// FB-1:连接失败终态回传的发送与攒批。只经手白名单六字段(失败码/阶段/平台/客户端版本/
// 授权 ID/时间戳),⛔ IP、地址、进程名、配置内容、客户机器上的任何文本——自动回传必须比
// 客户主动点的一键上报更窄。后台不可达时本地攒队列(上限 50 条、7 天),下次启动补传;
// 判不出原因的失败在上游记 UNKNOWN+阶段,这里只管把给到的东西原样送出去。
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import type { EncryptedQueueCodec } from './diagnostic-event-queue'
import { KNOWN_FAILURE_CODES } from './failure-codes'
import { DIAGNOSTIC_CLIENT_VERSION_PATTERN } from '../../diagnostic-event-types'

export type DiagnosisStage = 'connect-start' | 'connect-run' | 'repair'

export interface DiagnosisReport {
  readonly code: string
  readonly stage: DiagnosisStage
  /** 空串 = 没有已导入配置(很多失败发生在导入之前)。 */
  readonly authorizationId?: string
}

export interface DiagnosisPayload {
  readonly code: string
  readonly stage: DiagnosisStage
  readonly platform: string
  readonly clientVersion: string
  readonly authorizationId: string
  readonly timestamp: number
}

/** send 抛错时带 diagnosisPermanent = 该失败不是「通道一时不通」:
 * 'auth' = 会话过期(补传也 401),'route' = 老后台没有这个端点。两类都不入队空转。 */
export interface DiagnosisSendError {
  diagnosisPermanent?: 'auth' | 'route'
}

export interface DiagnosisReporterDeps {
  readonly send: (payload: DiagnosisPayload) => Promise<void>
  /** 设置页开关;关掉时直传与入队都断(工作单验收:正向与反向都断)。 */
  readonly enabled: () => boolean
  readonly platform: string
  readonly version: () => string
  readonly now: () => number
  readonly queuePath: string
  /** 不给即不落盘，绝不退回明文。生产由 Electron safeStorage 注入。 */
  readonly queueCodec?: EncryptedQueueCodec
}

export const DIAGNOSIS_QUEUE_LIMIT = 50
export const DIAGNOSIS_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const DIAGNOSIS_MAX_QUEUE_BYTES = 256 * 1024

export class DiagnosisReporter {
  private flushing = false
  /** 队列「读全量→改→写回」的串行链,enqueue 与 flush 排进同一条:flush 持本地快照在
   * await send 挂起期间,中途入队若直接落盘,flush 恢复后会用旧快照整体覆盖——那条记录
   * 从未发送就从盘上消失。链自身永不拒绝:一步失败不堵下一步。 */
  private queueTail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DiagnosisReporterDeps) {
    this.cleanupLegacyPlaintextTemporaries()
  }

  /** 失败终态入口。同步返回,发送与入队的异常一律就地吞掉——回传 ⛔ 影响连接动作本身。 */
  report(report: DiagnosisReport): void {
    if (!this.deps.enabled()) return
    const code = report.code
    if (code === '') return
    const payload: DiagnosisPayload = {
      code, stage: report.stage, platform: this.deps.platform,
      clientVersion: this.deps.version(), authorizationId: report.authorizationId ?? '',
      timestamp: this.deps.now()
    }
    void this.deps.send(payload).catch((error: unknown) => {
      if ((error as DiagnosisSendError)?.diagnosisPermanent !== undefined) return
      void this.serialized(() => this.enqueue(payload)).catch(() => { /* 攒批失败只能放弃这一条;⛔ 让它冒成主进程未处理拒绝 */ })
    })
  }

  /** 启动/拿到会话后的补传。按序发,一条失败即停(通道不通时条条不通,⛔ 雪崩式重试);
   * 过期条目先丢。进行中重复调用直接让位。整个读-发-写回在串行链内,中途入队排在 flush 之后。 */
  async flushPending(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await this.serialized(async () => {
        const stored = this.readQueue()
        // 即使客户关了回传，也必须先把旧版明文授权 ID 迁移/清理。
        if (!this.deps.enabled()) return
        const queue = stored.filter((entry) => this.deps.now() - entry.timestamp <= DIAGNOSIS_MAX_AGE_MS)
        while (queue.length > 0) {
          const payload = queue[0]
          try {
            await this.deps.send(payload)
          } catch (error: unknown) {
            if ((error as DiagnosisSendError)?.diagnosisPermanent === 'route') {
              // 老后台没有端点:留着这批,后台升级后(7 天内)还有价值;本轮回发就此打住。
              this.writeQueue(queue)
              return
            }
            this.writeQueue(queue) // 会话过期或通道不通:整批原样保留
            return
          }
          queue.shift()
          this.writeQueue(queue)
        }
      })
    } finally {
      this.flushing = false
    }
  }

  private serialized<T>(op: () => T | Promise<T>): Promise<T> {
    const result = this.queueTail.then(op)
    this.queueTail = result.then(() => undefined, () => undefined)
    return result
  }

  private enqueue(payload: DiagnosisPayload): void {
    const queue = this.readQueue()
    queue.push(payload)
    // 满了丢最旧:最早的诊断对「下一版修什么」的参考价值最低,⛔ 因此丢掉失败事实本身。
    this.writeQueue(queue.slice(-DIAGNOSIS_QUEUE_LIMIT))
  }

  private cleanupLegacyPlaintextTemporaries(): void {
    if (basename(this.deps.queuePath) !== 'diagnosis-pending.json') return
    const directory = dirname(this.deps.queuePath)
    let entries: string[]
    try { entries = readdirSync(directory) }
    catch { return }
    for (const entry of entries) {
      if (!/^diagnosis-pending\.json\.tmp-[a-f0-9]{8}$/.test(entry)) continue
      const path = join(directory, entry)
      try {
        const info = lstatSync(path)
        if (info.isFile() || info.isSymbolicLink()) unlinkSync(path)
      } catch { /* 单个遗留项消失或无权处理时，不扩大清理范围。 */ }
    }
  }

  private readQueue(): DiagnosisPayload[] {
    if (!existsSync(this.deps.queuePath)) return []
    try {
      const info = lstatSync(this.deps.queuePath)
      if (info.isSymbolicLink()) { unlinkSync(this.deps.queuePath); return [] }
      if (!info.isFile() || info.size <= 0) return []
      // 专用队列超限时不可读入内存，也不能让旧明文授权 ID 永久留盘。
      if (info.size > DIAGNOSIS_MAX_QUEUE_BYTES) { unlinkSync(this.deps.queuePath); return [] }
      const bytes = readFileSync(this.deps.queuePath)
      const plaintextCandidate = /^\s*\[/.test(bytes.toString('utf8'))
      if (!this.deps.queueCodec) {
        // 没有系统加密能力时绝不保留可识别的旧明文队列。
        if (plaintextCandidate) unlinkSync(this.deps.queuePath)
        return []
      }
      let raw: string
      let legacyPlaintext = false
      try {
        raw = this.deps.queueCodec.decrypt(bytes)
      } catch {
        // 从旧版明文队列单向迁移：只接纳严格六字段，原始授权 ID 在重新加密前清空。
        raw = bytes.toString('utf8')
        legacyPlaintext = plaintextCandidate
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) }
      catch {
        if (legacyPlaintext) unlinkSync(this.deps.queuePath)
        return []
      }
      if (!Array.isArray(parsed) || parsed.length > DIAGNOSIS_QUEUE_LIMIT) {
        if (legacyPlaintext) unlinkSync(this.deps.queuePath)
        return []
      }
      const queue = parsed.filter((entry): entry is DiagnosisPayload => {
        const item = entry as Partial<DiagnosisPayload> | null
        return item !== null && Object.keys(item).sort().join(',') === 'authorizationId,clientVersion,code,platform,stage,timestamp' &&
          typeof item.code === 'string' && item.code.length > 0 && item.code.length <= 80 &&
          ['connect-start', 'connect-run', 'repair'].includes(item.stage as string) &&
          ['macos', 'windows'].includes(item.platform as string) && typeof item.clientVersion === 'string' &&
          DIAGNOSTIC_CLIENT_VERSION_PATTERN.test(item.clientVersion) &&
          typeof item.authorizationId === 'string' && Number.isSafeInteger(item.timestamp) && Number(item.timestamp) >= 0
      })
      if (queue.length !== parsed.length) {
        if (legacyPlaintext) unlinkSync(this.deps.queuePath)
        return []
      }
      const sanitized = queue.map((entry): DiagnosisPayload => ({
        code: legacyPlaintext && !KNOWN_FAILURE_CODES.has(entry.code) ? 'UNKNOWN' : entry.code,
        stage: entry.stage,
        platform: entry.platform,
        clientVersion: entry.clientVersion,
        authorizationId: '',
        timestamp: entry.timestamp
      }))
      if (legacyPlaintext || queue.some((entry) => entry.authorizationId !== '') ||
          process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        try { this.writeQueue(sanitized) }
        catch {
          // safeStorage 不可用时无法安全迁移；删掉旧明文，不让授权 ID 继续留盘。
          if (legacyPlaintext) unlinkSync(this.deps.queuePath)
          return []
        }
      }
      return sanitized
    } catch { return [] }
  }

  private writeQueue(queue: readonly DiagnosisPayload[]): void {
    if (!this.deps.queueCodec) return
    const sanitized = queue.map((entry): DiagnosisPayload => ({
      code: entry.code,
      stage: entry.stage,
      platform: entry.platform,
      clientVersion: entry.clientVersion,
      authorizationId: '',
      timestamp: entry.timestamp
    }))
    const encrypted = this.deps.queueCodec.encrypt(`${JSON.stringify(sanitized)}\n`)
    if (!Buffer.isBuffer(encrypted) || encrypted.length <= 0 || encrypted.length > DIAGNOSIS_MAX_QUEUE_BYTES) {
      throw new Error('DIAGNOSIS_STORAGE_UNAVAILABLE')
    }
    mkdirSync(dirname(this.deps.queuePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.deps.queuePath}.tmp-${randomBytes(4).toString('hex')}`
    let created = false
    let renamed = false
    try {
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
      created = true
      renameSync(temporary, this.deps.queuePath)
      renamed = true
    } finally {
      if (created && !renamed) {
        try { unlinkSync(temporary) } catch { /* 写入前失败或已被清理。 */ }
      }
    }
  }
}
