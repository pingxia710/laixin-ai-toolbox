import type { RuntimeObservationSample } from '../sidecar/shared/runtime-observation.d.mts'

export type RuntimeObservationKind = 'install' | 'daily'
export type RuntimeObservationSlot = '10' | '16' | '20'

export interface RuntimeObservationEvent {
  readonly eventId: string
  readonly kind: RuntimeObservationKind
  readonly clientVersion: string
  readonly platform: 'macos' | 'windows'
  readonly at: number
  readonly slot?: RuntimeObservationSlot
  readonly firstConnectedAt?: number
  readonly samples: readonly RuntimeObservationSample[]
}

const EVENT_ID_PATTERN = /^[a-f0-9-]{36}$/
const CLIENT_VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][A-Za-z0-9.-]{1,32})?$/
const STAGE_PATTERN = /^[a-z0-9-]{1,48}$/
const STATE_PATTERN = /^(?:idle|connecting|connected|degraded|error|stopped-restored|user-disconnected|shutdown)$/
const SLOTS: readonly RuntimeObservationSlot[] = ['10', '16', '20']
export const RUNTIME_OBSERVATION_SAMPLE_LIMIT = 288
export const RUNTIME_OBSERVATION_EVENT_LIMIT = 32
export const RUNTIME_OBSERVATION_SLOT_HOURS: Readonly<Record<RuntimeObservationSlot, number>> = { 10: 10, 16: 16, 20: 20 }

function safeCounter(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function safePercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000
    ? Math.round(value * 10) / 10 : undefined
}

export function isPreOneRuntimeObservationVersion(version: string): boolean {
  const match = CLIENT_VERSION_PATTERN.exec(version)
  return match !== null && Number(match[1]) === 0
}

export function runtimeObservationSlotAt(date: Date): RuntimeObservationSlot | undefined {
  const hour = date.getHours()
  if (hour >= RUNTIME_OBSERVATION_SLOT_HOURS['20']) return '20'
  if (hour >= RUNTIME_OBSERVATION_SLOT_HOURS['16']) return '16'
  if (hour >= RUNTIME_OBSERVATION_SLOT_HOURS['10']) return '10'
  return undefined
}

export function runtimeObservationSlotKey(date: Date, slot: RuntimeObservationSlot): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}:${slot}`
}

export function sanitizeRuntimeObservationSample(sample: unknown): RuntimeObservationSample | undefined {
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return undefined
  const value = sample as Record<string, unknown>
  if (typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 1 ||
      typeof value.state !== 'string' || !STATE_PATTERN.test(value.state)) return undefined
  const rebuilt: Record<string, unknown> = { at: Math.round(value.at), state: value.state }
  if (typeof value.stage === 'string' && STAGE_PATTERN.test(value.stage)) rebuilt.stage = value.stage
  for (const key of ['reconnectAttempts', 'activeStreams', 'uploadBytes', 'downloadBytes', 'rssBytes', 'heapUsedBytes']) {
    const counter = safeCounter(value[key])
    if (counter !== undefined) rebuilt[key] = counter
  }
  const cpuPercent = safePercent(value.cpuPercent)
  if (cpuPercent !== undefined) rebuilt.cpuPercent = cpuPercent
  return rebuilt as unknown as RuntimeObservationSample
}

export function parseRuntimeObservationEvent(input: unknown): RuntimeObservationEvent | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const required = ['at', 'clientVersion', 'eventId', 'kind', 'platform', 'samples']
  const allowed = new Set([...required, 'firstConnectedAt', 'slot'])
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) return undefined
  if (typeof value.eventId !== 'string' || !EVENT_ID_PATTERN.test(value.eventId) ||
      typeof value.clientVersion !== 'string' || !CLIENT_VERSION_PATTERN.test(value.clientVersion) ||
      !isPreOneRuntimeObservationVersion(value.clientVersion) ||
      (value.kind !== 'install' && value.kind !== 'daily') ||
      (value.platform !== 'macos' && value.platform !== 'windows') ||
      !Number.isSafeInteger(value.at) || Number(value.at) <= 0 || !Array.isArray(value.samples) ||
      value.samples.length > RUNTIME_OBSERVATION_SAMPLE_LIMIT) return undefined
  if (value.kind === 'daily') {
    if (value.slot !== undefined && !SLOTS.includes(value.slot as RuntimeObservationSlot)) return undefined
    if (value.slot === undefined || value.firstConnectedAt !== undefined) return undefined
  } else if (value.slot !== undefined || value.firstConnectedAt === undefined ||
      !Number.isSafeInteger(value.firstConnectedAt) || Number(value.firstConnectedAt) <= 0 ||
      Number(value.firstConnectedAt) > Number(value.at)) return undefined
  const samples = value.samples.map(sanitizeRuntimeObservationSample)
  if (samples.some((sample) => sample === undefined)) return undefined
  return {
    eventId: value.eventId as string,
    kind: value.kind as RuntimeObservationKind,
    clientVersion: value.clientVersion as string,
    platform: value.platform as 'macos' | 'windows',
    at: Number(value.at),
    ...(value.slot === undefined ? {} : { slot: value.slot as RuntimeObservationSlot }),
    ...(value.firstConnectedAt === undefined ? {} : { firstConnectedAt: Number(value.firstConnectedAt) }),
    samples: samples as RuntimeObservationSample[]
  }
}

export function runtimeObservationEventKey(event: Pick<RuntimeObservationEvent, 'kind' | 'at' | 'slot'>): string {
  return event.kind === 'install' ? 'install' : `${new Date(event.at).toISOString().slice(0, 10)}:${event.slot ?? ''}`
}
