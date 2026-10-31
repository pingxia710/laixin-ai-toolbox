// N-79 客户端:connection-attempt 迷你队列。纪律照 diagnostic-event-queue 抄:加密落盘、
// 有界、退避补传——但合同更小(无恢复语义)。创始人四点补牢的落点:
// ①已采集 attemptKey 持久化在本队列文件(跨重启幂等,⛔ 只靠内存集合);
// ④400/404 合同不兼容→丢弃+留痕一次;429/5xx/网络→退避保留;401/403→暂停等下次会话。
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildConnectionAttemptEvent, connectionAttemptKeyOf, parseConnectionAttemptEvent, type ConnectionAttemptEvent, type FunnelAttemptLike } from '../../connection-attempt-types'

export const ATTEMPT_QUEUE_EVENT_LIMIT = 50
export const ATTEMPT_PROCESSED_KEY_LIMIT = 200
export const ATTEMPT_FLUSH_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const
const MAX_QUEUE_BYTES = 256 * 1024

/** 发送失败的分类(由接线方把 HTTP/账号错误映射进来;队列只认这三类)。 */
export type AttemptSendFailureKind = 'permanent' | 'retryable' | 'auth'
export class AttemptSendError extends Error {
  constructor (readonly kind: AttemptSendFailureKind, reason: string) { super(reason) }
}

export interface AttemptQueueDeps {
  readonly queuePath: string
  readonly codec: { encrypt: (plain: string) => Buffer; decrypt: (encrypted: Buffer) => string }
  readonly platform: 'macos' | 'windows'
  readonly version: () => string
  /** 当前授权哈希(与诊断事件同款口径;无授权给 'none')。 */
  readonly authorizationHash: () => string
  readonly send: (event: ConnectionAttemptEvent) => Promise<void>
  readonly now?: () => number
  readonly logFailure?: (event: string, detail: string) => void
}

interface StoredQueue { events: Array<{ event: ConnectionAttemptEvent; recordedAt: number }>; processedKeys: string[] }

export class ConnectionAttemptQueue {
  private events: Array<{ event: ConnectionAttemptEvent; recordedAt: number }> = []
  private processedKeys: string[] = []
  private lastFlushAt = 0
  private backoffStep = 0
  private pausedForAuth = false

  constructor (private readonly deps: AttemptQueueDeps) { this.load() }

  private now (): number { return this.deps.now?.() ?? Date.now() }

  private load (): void {
    try {
      const stored = JSON.parse(this.deps.codec.decrypt(readFileSync(this.deps.queuePath))) as StoredQueue
      if (Array.isArray(stored.events)) {
        this.events = stored.events.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
          const event = parseConnectionAttemptEvent(entry.event)
          return event !== undefined && Number.isSafeInteger(entry.recordedAt) && entry.recordedAt >= 0
            ? [{ event, recordedAt: entry.recordedAt }]
            : []
        }).slice(-ATTEMPT_QUEUE_EVENT_LIMIT)
      }
      if (Array.isArray(stored.processedKeys)) this.processedKeys = stored.processedKeys.slice(-ATTEMPT_PROCESSED_KEY_LIMIT)
    } catch { /* 损坏即从空开始 */ }
  }

  private persist (): void {
    try {
      this.events = this.events.slice(-ATTEMPT_QUEUE_EVENT_LIMIT)
      this.processedKeys = this.processedKeys.slice(-ATTEMPT_PROCESSED_KEY_LIMIT)
      const serialized = JSON.stringify({ events: this.events, processedKeys: this.processedKeys })
      // 超限(畸形膨胀)先裁最老事件;仍超限保键弃事件——⛔ 让队列文件无限长大。
      if (Buffer.byteLength(serialized, 'utf8') > MAX_QUEUE_BYTES) {
        this.events = this.events.slice(-10)
        if (Buffer.byteLength(JSON.stringify({ events: this.events, processedKeys: this.processedKeys }), 'utf8') > MAX_QUEUE_BYTES) this.events = []
      }
      const temporary = `${this.deps.queuePath}.tmp-${randomBytes(8).toString('hex')}`
      try {
        mkdirSync(dirname(this.deps.queuePath), { recursive: true })
        writeFileSync(temporary, this.deps.codec.encrypt(JSON.stringify({ events: this.events, processedKeys: this.processedKeys })))
        renameSync(temporary, this.deps.queuePath)
      } finally {
        try { rmSync(temporary, { force: true }) } catch { /* 队列落盘失败不得影响连接 */ }
      }
    } catch { /* 队列落盘失败不得影响连接 */ }
  }

  /** 采集漏斗终态尝试:attemptKey 持久去重;合同外行(superseded/stopped/in-progress)静默跳过。 */
  collect (attempts: readonly FunnelAttemptLike[]): number {
    let appended = 0
    for (const attempt of attempts) {
      const key = connectionAttemptKeyOf(attempt)
      if (key === undefined || this.processedKeys.includes(key)) continue
      const event = buildConnectionAttemptEvent({
        attempt, eventId: randomUUID(), clientVersion: this.deps.version(),
        platform: this.deps.platform, authorizationHash: this.deps.authorizationHash()
      })
      if (event === undefined) { // 合同外终态也标记已处理,⛔ 反复尝试构建.
        this.processedKeys = [...this.processedKeys, key].slice(-ATTEMPT_PROCESSED_KEY_LIMIT)
        continue
      }
      this.events = [...this.events, { event, recordedAt: this.now() }].slice(-ATTEMPT_QUEUE_EVENT_LIMIT)
      this.processedKeys = [...this.processedKeys, key].slice(-ATTEMPT_PROCESSED_KEY_LIMIT)
      appended += 1
    }
    if (appended > 0) this.persist()
    return appended
  }

  /** 补传:退避窗内不空转;permanent 丢弃留痕,retryable 保留退避,auth 暂停。 */
  async flush (): Promise<void> {
    if (this.pausedForAuth || this.events.length === 0) return
    const now = this.now()
    if (now - this.lastFlushAt < ATTEMPT_FLUSH_BACKOFF_MS[Math.min(this.backoffStep, ATTEMPT_FLUSH_BACKOFF_MS.length - 1)]) return
    this.lastFlushAt = now
    while (this.events.length > 0) {
      const { event } = this.events[0]
      try {
        await this.deps.send(event)
        this.events = this.events.slice(1)
        this.backoffStep = 0
        this.persist()
      } catch (error) {
        if (!(error instanceof AttemptSendError)) {
          // 接线方未分类的网络异常按可重试处理(保守保留)。
          this.backoffStep = Math.min(this.backoffStep + 1, ATTEMPT_FLUSH_BACKOFF_MS.length - 1)
          return
        }
        if (error.kind === 'permanent') {
          this.events = this.events.slice(1)
          this.deps.logFailure?.('connection-attempt-dropped', `${event.attemptKey}:${error.message}`)
          this.persist()
          continue
        }
        if (error.kind === 'auth') { this.pausedForAuth = true; return }
        this.backoffStep = Math.min(this.backoffStep + 1, ATTEMPT_FLUSH_BACKOFF_MS.length - 1)
        return
      }
    }
  }

  /** 新会话/重新登录后恢复上送(401/403 暂停的出口)。 */
  resume (): void { this.pausedForAuth = false; this.backoffStep = 0 }

  pendingCount (): number { return this.events.length }
}
