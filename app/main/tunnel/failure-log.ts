// Phase 1 ④:监管器/常驻接线的结构化失败日志。落点与守护 stderr 同一份
// <userData>/logs/tunnel-daemon.log——它已是「常驻日志」(mac launchd StandardErrorPath /
// win schtasks 重定向),诊断包(report-collect.daemonLogCandidates)既有通道收录,零新面。
// FB-1 的 UNKNOWN(TOP2,9/45)大多来自「现件随进程丢失」的路径:意外退出、叫醒耗尽、
// 恢复子进程非正常退——这些路径此刻起先落一行事件,UNKNOWN 从此可归因。
// 事件名是稳定契约(诊断/客服按行检索):daemon-unexpected-exit / daemon-restart-surrendered /
// wake-miss / wake-exhausted / wake-fallback-stale-carry / wake-refused / calibrate-failed /
// calibrate-not-installed / restore-failed / restore-exit / restore-failure-suppressed。
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FailureLog = (event: string, detail?: string) => void

/** 轮转阈值注入(测试收紧用);生产用下面的默认值。 */
export interface FailureLogRotation {
  /** 每累积多少次写入做一次大小检查(低频 statSync,⛔ 每写必 stat)。 */
  readonly checkEveryWrites?: number
  /** 每累积多少字节做一次大小检查。 */
  readonly checkEveryBytes?: number
  /** 超过即轮转的字节上限。 */
  readonly maxBytes?: number
}

// 轮转节奏:同步日志是旁路,大小检查也要低频——64 次或 1MB 任一先到才 stat 一次。
// 只留一代(.1):这份日志的价值在「最近一次失败的现场」,⛔ 无限代际占客户磁盘。
const ROTATION_CHECK_EVERY_WRITES = 64
const ROTATION_CHECK_EVERY_BYTES = 1024 * 1024
const ROTATION_MAX_BYTES = 10 * 1024 * 1024

export function createFailureLog(logPath: string, rotation: FailureLogRotation = {}): FailureLog {
  const checkEveryWrites = rotation.checkEveryWrites ?? ROTATION_CHECK_EVERY_WRITES
  const checkEveryBytes = rotation.checkEveryBytes ?? ROTATION_CHECK_EVERY_BYTES
  const maxBytes = rotation.maxBytes ?? ROTATION_MAX_BYTES
  let writesSinceCheck = 0
  let bytesSinceCheck = 0
  return (event: string, detail?: string): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      const line = `[tunnel-supervisor] ${new Date().toISOString()} ${event}${detail ? ` ${String(detail).replace(/\s*\n+\s*/g, ' ')}` : ''}`
      writesSinceCheck += 1
      bytesSinceCheck += Buffer.byteLength(line)
      if (writesSinceCheck >= checkEveryWrites || bytesSinceCheck >= checkEveryBytes) {
        writesSinceCheck = 0
        bytesSinceCheck = 0
        rotateIfOversized(logPath, maxBytes)
      }
      appendFileSync(logPath, `${line}\n`, { mode: 0o600 })
    } catch { /* 日志是旁路:写不进去 ⛔ 挡主流程(盘满/只读时连接照常) */ }
  }
}

/** 超上限即把当前文件挪成 .1(旧 .1 覆盖丢弃);挪不动就照常追加——日志是旁路,⛔ 因轮转失败丢事件。 */
function rotateIfOversized(logPath: string, maxBytes: number): void {
  let size: number
  try { size = statSync(logPath).size } catch { return /* 还没有文件:无需轮转 */ }
  if (size <= maxBytes) return
  try { renameSync(logPath, `${logPath}.1`) } catch { /* 轮转失败照常追加 */ }
}

export interface StderrLineSink {
  /** 接一个 chunk:攒行,遇 \n 才整行落,尾巴留存(保序)。 */
  push(chunk: string): void
  /** 进程收尾冲洗:没有换行结尾的尾巴也落一行(⛔ 丢尾)。 */
  flush(): void
}

// 单行积攒上限:守护输出一行不换行时 ⛔ 无限攒内存,超限按一行落掉(保序,不保换行)。
const STDERR_LINE_MAX_BYTES = 64 * 1024

/** stderr 接流的行级合并:真实子进程的一行常被管道切成多个 chunk,逐 chunk 落盘既是
 *  数倍的同步写,也把一行日志撕成数行(诊断按行检索失效)。空行不落(基线的 trim 同样丢弃)。 */
export function createStderrLineSink(log: FailureLog, event: string): StderrLineSink {
  let pending = ''
  const emit = (line: string): void => {
    const text = line.trim()
    if (text !== '') log(event, text)
  }
  return {
    push(chunk: string): void {
      pending += chunk
      let newlineAt = pending.indexOf('\n')
      while (newlineAt >= 0) {
        emit(pending.slice(0, newlineAt))
        pending = pending.slice(newlineAt + 1)
        newlineAt = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending) > STDERR_LINE_MAX_BYTES) {
        emit(pending)
        pending = ''
      }
    },
    flush(): void {
      if (pending !== '') {
        emit(pending)
        pending = ''
      }
    }
  }
}

/** 从任意错误提炼单行细节:错误名+首行截断——daemon-core errorNameOf/firstLineOf 的同款纪律。 */
export function firstLineOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** 守护/恢复子进程 stderr 的接流落点(生产接线用):与失败日志同文件,行级追加。 */
export function daemonLogPath(userDataPath: string): string {
  return join(userDataPath, 'logs', 'tunnel-daemon.log')
}
