import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeObservationEvent, RuntimeObservationSlot } from '../../runtime-observation-types'
import { isPreOneRuntimeObservationVersion, parseRuntimeObservationEvent, runtimeObservationSlotAt, runtimeObservationSlotKey, RUNTIME_OBSERVATION_EVENT_LIMIT } from '../../runtime-observation-types'
import type { RuntimeObservationSample } from '../../../sidecar/shared/runtime-observation.d.mts'
import { runtimeObservationEventKey } from '../../runtime-observation-types'
import type { EncryptedQueueCodec } from './diagnostic-event-queue'

// 32 个事件最多覆盖约 10 天；每个 daily 事件可带 288 条白名单样本，留足离线补传空间。
const MAX_QUEUE_BYTES = 4 * 1024 * 1024
const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const
const PROCESSED_SLOT_LIMIT = 120

export type RuntimeObservationSendFailureKind = 'permanent' | 'retryable' | 'auth'

export class RuntimeObservationSendError extends Error {
  constructor(readonly kind: RuntimeObservationSendFailureKind, reason: string) { super(reason) }
}

export interface RuntimeObservationTelemetryQueueDeps {
  readonly queuePath: string
  readonly codec: EncryptedQueueCodec
  readonly enabled: () => boolean
  readonly platform: 'macos' | 'windows'
  readonly version: () => string
  /** 当前账号；换号时丢弃旧账号离线事件，禁止串发到新账号。 */
  readonly accountId?: () => string | undefined
  readonly send: (event: RuntimeObservationEvent) => Promise<void>
  readonly now: () => number
  readonly logFailure?: (event: string, detail: string) => void
}

interface StoredQueue {
  accountId?: string
  events: Array<{ event: RuntimeObservationEvent; recordedAt: number }>
  processedSlots: string[]
  installSent: boolean
}

function sampleWindow(samples: readonly RuntimeObservationSample[], limit: number): RuntimeObservationSample[] {
  return samples.slice(-limit)
}

export class RuntimeObservationTelemetryQueue {
  private events: Array<{ event: RuntimeObservationEvent; recordedAt: number }> = []
  private processedSlots: string[] = []
  private installSent = false
  private retryStep = 0
  private nextRetryAt = 0
  private pausedForAuth = false
  private flushing = false
  private rerunFlush = false
  private boundAccountId?: string

  constructor(private readonly deps: RuntimeObservationTelemetryQueueDeps) {
    if (deps.enabled() && isPreOneRuntimeObservationVersion(deps.version())) this.load()
  }

  private stateForPersist(): StoredQueue {
    const events = [...this.events]
    let processedSlots = this.processedSlots.slice(-PROCESSED_SLOT_LIMIT)
    let installSent = this.installSent
    const dropOldest = (): void => {
      const dropped = events.shift()
      if (dropped === undefined) return
      if (dropped.event.kind === 'install') installSent = false
      else if (dropped.event.slot !== undefined) {
        const key = runtimeObservationSlotKey(new Date(dropped.event.at), dropped.event.slot)
        processedSlots = processedSlots.filter((slot) => slot !== key)
      }
    }
    while (events.length > RUNTIME_OBSERVATION_EVENT_LIMIT) dropOldest()
    const stored = (): StoredQueue => ({ ...(this.boundAccountId === undefined ? {} : { accountId: this.boundAccountId }),
      events, processedSlots, installSent })
    let serialized = JSON.stringify(stored())
    while (Buffer.byteLength(serialized, 'utf8') > MAX_QUEUE_BYTES && events.length > 0) {
      dropOldest()
      serialized = JSON.stringify(stored())
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_QUEUE_BYTES) {
      events.length = 0
      processedSlots = []
    }
    return { ...stored(), events, processedSlots, installSent }
  }

  private persist(): void {
    try {
      const candidate = this.stateForPersist()
      const serialized = JSON.stringify(candidate)
      const encrypted = this.deps.codec.encrypt(serialized)
      if (!Buffer.isBuffer(encrypted) || encrypted.length <= 0 || encrypted.length > MAX_QUEUE_BYTES) return
      const temporary = `${this.deps.queuePath}.tmp-${randomBytes(8).toString('hex')}`
      let created = false
      let renamed = false
      try {
        mkdirSync(dirname(this.deps.queuePath), { recursive: true, mode: 0o700 })
        try {
          const info = lstatSync(dirname(this.deps.queuePath))
          if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) return
        } catch { return }
        writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
        created = true
        renameSync(temporary, this.deps.queuePath)
        renamed = true
      } finally {
        if (created && !renamed) { try { unlinkSync(temporary) } catch { /* best effort */ } }
      }
      this.events = candidate.events
      this.processedSlots = candidate.processedSlots
      this.installSent = candidate.installSent
    } catch { /* telemetry must never affect the network path */ }
  }

  private load(): void {
    try {
      const info = lstatSync(this.deps.queuePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_QUEUE_BYTES ||
          process.platform !== 'win32' && (info.mode & 0o077) !== 0) return
      const parsed = JSON.parse(this.deps.codec.decrypt(readFileSync(this.deps.queuePath))) as Partial<StoredQueue>
      if (typeof parsed.accountId === 'string' && parsed.accountId.length > 0 && parsed.accountId.length <= 128) {
        this.boundAccountId = parsed.accountId
      }
      this.installSent = parsed.installSent === true
      if (Array.isArray(parsed.processedSlots)) this.processedSlots = parsed.processedSlots
        .filter((slot): slot is string => typeof slot === 'string' && slot.length <= 40).slice(-PROCESSED_SLOT_LIMIT)
      if (Array.isArray(parsed.events)) {
        const decoded = parsed.events.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
          const value = entry as { event?: unknown; recordedAt?: unknown }
          const event = parseRuntimeObservationEvent(value.event)
          return event !== undefined && Number.isSafeInteger(value.recordedAt) && Number(value.recordedAt) >= 0
            ? [{ event, recordedAt: Number(value.recordedAt) }] : []
        })
        this.events = []
        for (const stored of decoded) {
          this.events.push(stored)
          while (this.events.length > RUNTIME_OBSERVATION_EVENT_LIMIT) this.dropOldestEvent()
        }
      }
    } catch { /* missing, corrupt, or old queue = empty */ }
  }

  private dropOldestEvent(): void {
    const dropped = this.events.shift()
    if (dropped === undefined) return
    if (dropped.event.kind === 'install') this.installSent = false
    else if (dropped.event.slot !== undefined) {
      const key = runtimeObservationSlotKey(new Date(dropped.event.at), dropped.event.slot)
      this.processedSlots = this.processedSlots.filter((slot) => slot !== key)
    }
  }

  private appendEvent(event: RuntimeObservationEvent, recordedAt: number): void {
    this.events = [...this.events, { event, recordedAt }]
    while (this.events.length > RUNTIME_OBSERVATION_EVENT_LIMIT) this.dropOldestEvent()
  }

  private removeEvent(eventId: string): void {
    this.events = this.events.filter(({ event }) => event.eventId !== eventId)
  }

  private currentAccountId(): string | undefined {
    const accountId = this.deps.accountId?.()
    return typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 128 ? accountId : undefined
  }

  private ensureAccountBinding(): string | undefined {
    const accountId = this.currentAccountId()
    if (accountId === undefined) return undefined
    if (this.boundAccountId === undefined) {
      // A queue written before account binding cannot be attributed safely.
      this.events = []
      this.processedSlots = []
      this.installSent = false
      this.boundAccountId = accountId
      this.persist()
      return accountId
    }
    if (this.boundAccountId !== accountId) {
      this.events = []
      this.processedSlots = []
      this.installSent = false
      this.retryStep = 0
      this.nextRetryAt = 0
      this.pausedForAuth = false
      this.boundAccountId = accountId
      this.persist()
    }
    return accountId
  }

  collectInstall(samples: readonly RuntimeObservationSample[]): boolean {
    if (this.deps.accountId !== undefined && this.ensureAccountBinding() === undefined) return false
    if (!this.deps.enabled() || !isPreOneRuntimeObservationVersion(this.deps.version()) || this.installSent ||
        this.events.some(({ event }) => event.kind === 'install')) return false
    const at = this.deps.now()
    const firstConnectedAt = samples.find((sample) => sample.state === 'connected' && sample.at <= at)?.at ?? at
    const event = parseRuntimeObservationEvent({
      eventId: randomUUID(), kind: 'install', clientVersion: this.deps.version(), platform: this.deps.platform,
      at, firstConnectedAt, samples: sampleWindow(samples, 12)
    })
    if (event === undefined) return false
    this.appendEvent(event, at)
    this.persist()
    return true
  }

  collectDaily(samples: readonly RuntimeObservationSample[]): number {
    if (this.deps.accountId !== undefined && this.ensureAccountBinding() === undefined) return 0
    if (!this.deps.enabled() || !isPreOneRuntimeObservationVersion(this.deps.version()) || samples.length === 0) return 0
    const nowMs = this.deps.now()
    const now = new Date(nowMs)
    const latest = runtimeObservationSlotAt(now)
    if (latest === undefined) return 0
    const slots: RuntimeObservationSlot[] = latest === '20' ? ['10', '16', '20'] : latest === '16' ? ['10', '16'] : ['10']
    let appended = 0
    for (const slot of slots) {
      const key = runtimeObservationSlotKey(now, slot)
      if (this.processedSlots.includes(key)) continue
      const event = parseRuntimeObservationEvent({
        eventId: randomUUID(), kind: 'daily', clientVersion: this.deps.version(), platform: this.deps.platform,
        at: nowMs, slot, samples: sampleWindow(samples, 288)
      })
      if (event === undefined) continue
      this.appendEvent(event, nowMs)
      this.processedSlots = [...this.processedSlots, key].slice(-PROCESSED_SLOT_LIMIT)
      appended += 1
    }
    if (appended > 0) this.persist()
    return appended
  }

  async flush(): Promise<void> {
    if (this.flushing) { this.rerunFlush = true; return }
    if (this.deps.accountId !== undefined && this.ensureAccountBinding() === undefined) return
    if (!this.deps.enabled() || this.pausedForAuth || this.events.length === 0 || this.deps.now() < this.nextRetryAt) return
    this.flushing = true
    try {
      while (this.events.length > 0) {
        if (this.deps.accountId !== undefined && this.ensureAccountBinding() === undefined) return
        const current = this.events[0]
        try {
          await this.deps.send(current.event)
          this.removeEvent(current.event.eventId)
          if (current.event.kind === 'install') this.installSent = true
          this.retryStep = 0
          this.nextRetryAt = 0
          this.persist()
        } catch (error) {
          if (error instanceof RuntimeObservationSendError && error.kind === 'permanent') {
            this.removeEvent(current.event.eventId)
            // 老后台没有这条接口时只记一次并停止该安装事件，避免每 30 秒重复打一个永远失败的请求。
            if (current.event.kind === 'install') this.installSent = true
            this.deps.logFailure?.('runtime-observation-dropped', `${current.event.kind}:${error.message}`)
            this.persist()
            continue
          }
          if (error instanceof RuntimeObservationSendError && error.kind === 'auth') this.pausedForAuth = true
          else {
            this.retryStep = Math.min(this.retryStep + 1, RETRY_BACKOFF_MS.length - 1)
            this.nextRetryAt = this.deps.now() + RETRY_BACKOFF_MS[this.retryStep]
          }
          return
        }
      }
    } finally {
      this.flushing = false
      if (this.rerunFlush) {
        this.rerunFlush = false
        await this.flush()
      }
    }
  }

  resume(): void {
    this.pausedForAuth = false
    this.retryStep = 0
    this.nextRetryAt = 0
  }

  pendingCount(): number { return this.events.length }
  hasInstallationSent(): boolean { return this.installSent }
  pendingKinds(): readonly string[] { return this.events.map(({ event }) => runtimeObservationEventKey(event)) }
}
