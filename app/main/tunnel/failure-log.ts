// Phase 1 ④:监管器/常驻接线的结构化失败日志。落点与守护 stderr 同一份
// <userData>/logs/tunnel-daemon.log——它已是「常驻日志」(mac launchd StandardErrorPath /
// win schtasks 重定向),诊断包(report-collect.daemonLogCandidates)既有通道收录,零新面。
// FB-1 的 UNKNOWN(TOP2,9/45)大多来自「现件随进程丢失」的路径:意外退出、叫醒耗尽、
// 恢复子进程非正常退——这些路径此刻起先落一行事件,UNKNOWN 从此可归因。
// 事件名是稳定契约(诊断/客服按行检索):daemon-unexpected-exit / daemon-restart-surrendered /
// wake-miss / wake-exhausted / wake-fallback-stale-carry / wake-refused / calibrate-failed /
// calibrate-not-installed / restore-failed / restore-exit / restore-failure-suppressed。
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FailureLog = (event: string, detail?: string) => void

export function createFailureLog(logPath: string): FailureLog {
  return (event: string, detail?: string): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      const line = `[tunnel-supervisor] ${new Date().toISOString()} ${event}${detail ? ` ${String(detail).replace(/\s*\n+\s*/g, ' ')}` : ''}`
      appendFileSync(logPath, `${line}\n`, { mode: 0o600 })
    } catch { /* 日志是旁路:写不进去 ⛔ 挡主流程(盘满/只读时连接照常) */ }
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
