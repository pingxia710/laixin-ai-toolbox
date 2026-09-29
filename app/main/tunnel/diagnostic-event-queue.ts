import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  diagnosticDurationBucket,
  diagnosticAuthorizationHashAt,
  DIAGNOSTIC_AUTHORIZATION_HASH_LOOKBACK_WINDOWS,
  DIAGNOSTIC_AUTHORIZATION_HASH_ROTATION_MS,
  parseDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticPathType,
  type DiagnosticRepairResult
} from '../../diagnostic-event-types'
import { KNOWN_FAILURE_CODES } from './failure-codes'

export type { DiagnosticEvent } from '../../diagnostic-event-types'

export interface EncryptedQueueCodec {
  readonly encrypt: (plain: string) => Buffer
  readonly decrypt: (encrypted: Buffer) => string
}

export interface DiagnosticEventQueueDeps {
  readonly queuePath: string
  readonly codec: EncryptedQueueCodec
  readonly enabled: () => boolean
  readonly platform: 'macos' | 'windows'
  readonly version: () => string
  readonly now: () => number
  readonly send: (event: DiagnosticEvent) => Promise<void>
  /** 当前账号只能补传属于自己授权的事件。 */
  readonly canSend?: (event: DiagnosticEvent) => boolean
  readonly createId?: () => string
}

export const DIAGNOSTIC_EVENT_QUEUE_LIMIT = 50
export const DIAGNOSTIC_EVENT_RETRY_MIN_MS = 30_000
export const DIAGNOSTIC_EVENT_RETRY_MAX_MS = 10 * 60_000
const MAX_ENCRYPTED_QUEUE_BYTES = 256 * 1024

export function diagnosticEventBelongsToAuthorization(event: DiagnosticEvent, authorizationId: string, now: number): boolean {
  if (authorizationId === '') return event.authorizationHash === 'none'
  for (let offset = 0; offset <= DIAGNOSTIC_AUTHORIZATION_HASH_LOOKBACK_WINDOWS; offset += 1) {
    if (event.authorizationHash === diagnosticAuthorizationHashAt(
      authorizationId, now - offset * DIAGNOSTIC_AUTHORIZATION_HASH_ROTATION_MS
    )) return true
  }
  return false
}

type FailureInput = {
  readonly failureCategory: string
  readonly pathType: DiagnosticPathType
  readonly authorizationId: string
}

/**
 * N-53 的离线闭环队列。磁盘文件只有系统安全存储加密后的字节；解密后仍只接受固定十字段。
 * 失败先入队，只有真实连接判据通过后才改成 recovered 并补传。服务端以 eventId 幂等去重。
 */
export class DiagnosticEventQueue {
  private queueTail: Promise<void> = Promise.resolve()
  private flushing = false
  private rerunFlush = false
  private hasQueued: boolean
  private retryFailures = 0
  private nextRetryAt = 0
  private readonly openedAt = new Map<string, number>()

  constructor(private readonly deps: DiagnosticEventQueueDeps) {
    this.hasQueued = this.readQueue().length > 0
  }

  async recordFailure(input: unknown): Promise<string | undefined> {
    if (!this.deps.enabled()) return undefined
    const failure = this.parseFailure(input)
    // 没有授权就无法在换号后证明客户归属；旧六字段仍保持原兼容行为。
    if (failure.authorizationId === '') return undefined
    const eventId = (this.deps.createId ?? randomUUID)()
    const event = parseDiagnosticEvent({
      eventId,
      failureCategory: failure.failureCategory,
      resultBucket: 'failed',
      durationBucket: 'unknown',
      pathType: failure.pathType,
      repairAction: 'none',
      repairResult: 'not-run',
      clientVersion: this.deps.version(),
      platform: this.deps.platform,
      authorizationHash: this.authorizationHash(failure.authorizationId)
    })
    if (event === undefined) throw new Error('DIAGNOSTIC_EVENT_INVALID')
    // 先同步抬起闸：recordFailure 的落盘虽排进串行链，紧随其后的有效连接观察也不能漏掉它。
    this.hasQueued = true
    await this.serialized(() => {
      const queue = this.readQueue()
      this.openedAt.set(event.eventId, this.deps.now())
      const retained = [...queue, event].slice(-DIAGNOSTIC_EVENT_QUEUE_LIMIT)
      const retainedIds = new Set(retained.map((entry) => entry.eventId))
      for (const id of this.openedAt.keys()) if (!retainedIds.has(id)) this.openedAt.delete(id)
      this.writeQueue(retained)
    })
    return eventId
  }

  async markRepairStarted(authorizationId: string): Promise<string | undefined> {
    if (!this.deps.enabled()) return undefined
    return this.updateLatestPending(authorizationId,
      (event) => ({ ...event, repairAction: 'repair', repairResult: 'running' }))
  }

  async markRepairResult(eventId: string, result: Exclude<DiagnosticRepairResult, 'not-run' | 'running'>): Promise<void> {
    if (!this.deps.enabled()) return
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(eventId)) {
      throw new Error('DIAGNOSTIC_EVENT_INVALID')
    }
    if (!['recovered', 'still-failing', 'unknown', 'cancelled'].includes(result)) {
      throw new Error('DIAGNOSTIC_EVENT_INVALID')
    }
    await this.serialized(() => {
      const queue = this.readQueue()
      const index = queue.findIndex((event) => event.eventId === eventId && event.resultBucket === 'failed')
      if (index < 0) return
      this.writeQueue(queue.map((event, eventIndex) => eventIndex === index
        ? { ...event, repairAction: 'repair', repairResult: result } : event))
    })
  }

  async recordRecovery(input: { readonly authorizationId: string; readonly verified: boolean; readonly pathType: DiagnosticPathType }): Promise<void> {
    if (!input || Object.keys(input).sort().join(',') !== 'authorizationId,pathType,verified' || typeof input.verified !== 'boolean' ||
        !this.validAuthorizationId(input.authorizationId) ||
        !['laixin', 'reused', 'unknown'].includes(input.pathType)) throw new Error('DIAGNOSTIC_EVENT_INVALID')
    if (!input.verified || input.pathType === 'unknown' || !this.hasQueued || !this.deps.enabled()) return
    await this.serialized(() => {
      const now = this.deps.now()
      const queue = this.readQueue()
      let changed = false
      const next = queue.map((event): DiagnosticEvent => {
        if (event.resultBucket !== 'failed' || !this.matchesAuthorization(event, input.authorizationId, now)) return event
        changed = true
        const startedAt = this.openedAt.get(event.eventId)
        return {
          ...event,
          resultBucket: 'recovered',
          durationBucket: diagnosticDurationBucket(startedAt === undefined ? undefined : now - startedAt),
          pathType: input.pathType,
          repairAction: event.repairAction === 'none' ? 'reconnect' : event.repairAction,
          repairResult: event.repairAction === 'repair' && event.repairResult !== 'running'
            ? event.repairResult : 'recovered'
        }
      })
      if (changed) this.writeQueue(next)
    })
    await this.flushRecovered()
  }

  async flushRecovered(): Promise<void> {
    if (this.flushing || !this.hasQueued || !this.deps.enabled() || this.deps.now() < this.nextRetryAt) return
    this.flushing = true
    try {
      while (this.hasQueued && this.deps.enabled() && this.deps.now() >= this.nextRetryAt) {
        const event = await this.serialized(() => {
          // rerun 只要求本次按当前会话筛选；在实际筛选回调内消费，不能影响随后一次发送的退避。
          this.rerunFlush = false
          return this.readQueue().find((entry) => entry.resultBucket === 'recovered' &&
            (this.deps.canSend?.(entry) ?? true))
        })
        if (event === undefined) break
        // 候选返回后可能已微任务级换号或关闭上报；重查与 send 调用之间不得让出执行权。
        const canSendNow = !this.rerunFlush && (this.deps.canSend?.(event) ?? true) && !this.rerunFlush && this.deps.enabled()
        if (!canSendNow) continue
        try {
          // 网络发送绝不能占用读改写临界区：新故障必须能在慢 POST 期间优先落盘。
          await this.deps.send(event)
        } catch (error: unknown) {
          if (!this.rerunFlush) {
            this.retryFailures += 1
            const hinted = (error as { diagnosticRetryAfterMs?: unknown })?.diagnosticRetryAfterMs
            const backoff = Math.min(DIAGNOSTIC_EVENT_RETRY_MAX_MS,
              DIAGNOSTIC_EVENT_RETRY_MIN_MS * 2 ** Math.min(this.retryFailures - 1, 5))
            this.nextRetryAt = this.deps.now() +
              (typeof hinted === 'number' && Number.isSafeInteger(hinted) && hinted > 0 ? Math.max(backoff, hinted) : backoff)
          }
          break
        }
        this.retryFailures = 0
        this.nextRetryAt = 0
        await this.serialized(() => {
          const queue = this.readQueue()
          if (!queue.some((entry) => entry.eventId === event.eventId)) return
          this.openedAt.delete(event.eventId)
          this.writeQueue(queue.filter((entry) => entry.eventId !== event.eventId))
        })
      }
    } finally {
      this.flushing = false
      if (this.rerunFlush) {
        this.rerunFlush = false
        this.retryFailures = 0
        this.nextRetryAt = 0
        await this.flushRecovered()
      }
    }
  }

  /** 会话刚就位时取消“无会话”退避，立即尝试当前账号自己的事件。 */
  async resumeUploads(): Promise<void> {
    this.retryFailures = 0
    this.nextRetryAt = 0
    if (this.flushing) {
      this.rerunFlush = true
      return
    }
    await this.flushRecovered()
  }

  state(): { readonly pending: number; readonly ready: number } {
    const queue = this.readQueue()
    return {
      pending: queue.filter((event) => event.resultBucket === 'failed').length,
      ready: queue.filter((event) => event.resultBucket === 'recovered').length
    }
  }

  private updateLatestPending(authorizationId: string,
    update: (event: DiagnosticEvent) => DiagnosticEvent): Promise<string | undefined> {
    if (!this.validAuthorizationId(authorizationId)) return Promise.reject(new Error('DIAGNOSTIC_EVENT_INVALID'))
    return this.serialized(() => {
      const now = this.deps.now()
      const queue = this.readQueue()
      const index = this.latestPendingIndex(queue, authorizationId, now)
      if (index < 0) return undefined
      this.writeQueue(queue.map((event, eventIndex) => eventIndex === index ? update(event) : event))
      return queue[index].eventId
    })
  }

  private parseFailure(input: unknown): FailureInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('DIAGNOSTIC_EVENT_INVALID')
    const value = input as Partial<FailureInput>
    if (Object.keys(value).sort().join(',') !== 'authorizationId,failureCategory,pathType' ||
        typeof value.failureCategory !== 'string' || !KNOWN_FAILURE_CODES.has(value.failureCategory) ||
        typeof value.authorizationId !== 'string' || value.authorizationId !== '' && !/^lx-[a-z0-9]{6,64}$/.test(value.authorizationId) ||
        !['laixin', 'reused', 'unknown'].includes(value.pathType as string)) throw new Error('DIAGNOSTIC_EVENT_INVALID')
    return value as FailureInput
  }

  private authorizationHash(authorizationId: string): string {
    if (authorizationId === '') return 'none'
    return this.authorizationHashAt(authorizationId, this.deps.now())
  }

  private validAuthorizationId(value: unknown): value is string {
    return typeof value === 'string' && (value === '' || /^lx-[a-z0-9]{6,64}$/.test(value))
  }

  private matchesAuthorization(event: DiagnosticEvent, authorizationId: string, now: number): boolean {
    return diagnosticEventBelongsToAuthorization(event, authorizationId, now)
  }

  private latestPendingIndex(queue: readonly DiagnosticEvent[], authorizationId: string, now: number): number {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const event = queue[index]
      if (event.resultBucket === 'failed' &&
          this.matchesAuthorization(event, authorizationId, now)) return index
    }
    return -1
  }

  private authorizationHashAt(authorizationId: string, at: number): string {
    return diagnosticAuthorizationHashAt(authorizationId, at)
  }

  private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queueTail.then(operation)
    this.queueTail = result.then(() => undefined, () => undefined)
    return result
  }

  private readQueue(): DiagnosticEvent[] {
    if (!existsSync(this.deps.queuePath)) return []
    try {
      const info = lstatSync(this.deps.queuePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ENCRYPTED_QUEUE_BYTES ||
          process.platform !== 'win32' && (info.mode & 0o077) !== 0) return []
      const parsed: unknown = JSON.parse(this.deps.codec.decrypt(readFileSync(this.deps.queuePath)))
      if (!Array.isArray(parsed) || parsed.length > DIAGNOSTIC_EVENT_QUEUE_LIMIT) return []
      const queue = parsed.map((entry) => parseDiagnosticEvent(entry))
      return queue.every((event) => event !== undefined) ? queue as DiagnosticEvent[] : []
    } catch {
      return []
    }
  }

  private writeQueue(queue: readonly DiagnosticEvent[]): void {
    const plain = `${JSON.stringify(queue)}\n`
    const encrypted = this.deps.codec.encrypt(plain)
    if (!Buffer.isBuffer(encrypted) || encrypted.length <= 0 || encrypted.length > MAX_ENCRYPTED_QUEUE_BYTES) {
      throw new Error('DIAGNOSTIC_EVENT_STORAGE_UNAVAILABLE')
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
    this.hasQueued = queue.length > 0
  }
}
