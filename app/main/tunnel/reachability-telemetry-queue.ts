// 0.7.3 客户端可达性事件队列：默认关闭、加密落盘、有界批量、失败退避。
// 连接本身不依赖它；队列损坏、落盘失败和上报失败都只能少一条遥测，不能阻断网络。
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildReachabilityEvent, parseReachabilityEvent, REACHABILITY_BATCH_LIMIT, type ReachabilityEvent } from '../../reachability-types'
import type { FunnelAttemptLike } from '../../connection-attempt-types'

const EVENT_LIMIT = 100
const PROCESSED_LIMIT = 200
const MAX_QUEUE_BYTES = 256 * 1024
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const

export type ReachabilitySendFailureKind = 'permanent' | 'retryable' | 'auth'
export class ReachabilitySendError extends Error {
  constructor(readonly kind: ReachabilitySendFailureKind, reason: string) { super(reason) }
}

export interface ReachabilityTelemetryQueueDeps {
  readonly queuePath: string
  readonly codec: { encrypt: (plain: string) => Buffer; decrypt: (encrypted: Buffer) => string }
  readonly enabled: () => boolean
  readonly platform: 'macos' | 'windows'
  readonly version: () => string
  readonly send: (events: readonly ReachabilityEvent[]) => Promise<void>
  readonly now?: () => number
  readonly logFailure?: (event: string, detail: string) => void
}

interface StoredQueue { events: ReachabilityEvent[]; processedKeys: string[] }

export class ReachabilityTelemetryQueue {
  private events: ReachabilityEvent[] = []
  private processedKeys: string[] = []
  private lastFlushAt = 0
  // -1 表示尚未失败；首次失败使用 BACKOFF_MS[0]。
  private backoffStep = -1
  private pausedForAuth = false
  private flushing?: Promise<void>

  constructor(private readonly deps: ReachabilityTelemetryQueueDeps) { this.load() }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private backoffDelayMs(): number {
    if (this.backoffStep < 0) return 0
    return BACKOFF_MS[Math.min(this.backoffStep, BACKOFF_MS.length - 1)]
  }

  private load(): void {
    try {
      const stored = JSON.parse(this.deps.codec.decrypt(readFileSync(this.deps.queuePath))) as StoredQueue
      if (Array.isArray(stored.events)) this.events = stored.events.flatMap((event) => {
        const parsed = parseReachabilityEvent(event)
        return parsed === undefined ? [] : [parsed]
      }).slice(-EVENT_LIMIT)
      if (Array.isArray(stored.processedKeys)) this.processedKeys = stored.processedKeys.filter((key) => typeof key === 'string').slice(-PROCESSED_LIMIT)
    } catch { /* 缺失或损坏按空队列处理 */ }
  }

  private persist(): void {
    try {
      this.events = this.events.slice(-EVENT_LIMIT)
      this.processedKeys = this.processedKeys.slice(-PROCESSED_LIMIT)
      let serialized = JSON.stringify({ events: this.events, processedKeys: this.processedKeys })
      if (Buffer.byteLength(serialized, 'utf8') > MAX_QUEUE_BYTES) {
        this.events = this.events.slice(-20)
        serialized = JSON.stringify({ events: this.events, processedKeys: this.processedKeys })
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_QUEUE_BYTES) this.events = []
      const temporary = `${this.deps.queuePath}.tmp-${randomBytes(8).toString('hex')}`
      try {
        mkdirSync(dirname(this.deps.queuePath), { recursive: true })
        writeFileSync(temporary, this.deps.codec.encrypt(JSON.stringify({ events: this.events, processedKeys: this.processedKeys })))
        renameSync(temporary, this.deps.queuePath)
      } finally { try { rmSync(temporary, { force: true }) } catch { /* best effort */ } }
    } catch { /* 遥测旁路不影响主流程 */ }
  }

  collect(attempts: readonly FunnelAttemptLike[]): number {
    if (!this.deps.enabled()) return 0
    let appended = 0
    for (const attempt of attempts) {
      const key = `${attempt.trigger}:${String(attempt.startedAt)}`
      if (this.processedKeys.includes(key)) continue
      const event = buildReachabilityEvent({ attempt, clientVersion: this.deps.version(), platform: this.deps.platform })
      this.processedKeys = [...this.processedKeys, key].slice(-PROCESSED_LIMIT)
      if (event === undefined) continue
      this.events = [...this.events, event].slice(-EVENT_LIMIT)
      appended++
    }
    if (appended > 0 || attempts.length > 0) this.persist()
    return appended
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.flushPending().finally(() => { this.flushing = undefined })
    return this.flushing
  }

  private async flushPending(): Promise<void> {
    if (!this.deps.enabled() || this.pausedForAuth || this.events.length === 0) return
    const now = this.now()
    if (now - this.lastFlushAt < this.backoffDelayMs()) return
    this.lastFlushAt = now
    while (this.events.length > 0) {
      const batch = this.events.slice(0, REACHABILITY_BATCH_LIMIT)
      const ids = new Set(batch.map(event => event.eventId))
      try {
        await this.deps.send(batch)
        this.events = this.events.filter(event => !ids.has(event.eventId))
        this.backoffStep = -1
        this.persist()
      } catch (error) {
        if (error instanceof ReachabilitySendError && error.kind === 'permanent') {
          this.events = this.events.filter(event => !ids.has(event.eventId))
          this.backoffStep = -1
          this.deps.logFailure?.('reachability-dropped', `${batch.length}:${error.message}`)
          this.persist()
          continue
        }
        if (error instanceof ReachabilitySendError && error.kind === 'auth') this.pausedForAuth = true
        else this.backoffStep = Math.min(this.backoffStep + 1, BACKOFF_MS.length - 1)
        return
      }
    }
  }

  resume(): void { this.pausedForAuth = false; this.backoffStep = -1; this.lastFlushAt = 0 }
  pendingCount(): number { return this.events.length }
}
