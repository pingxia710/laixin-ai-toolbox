// N-79 connection-attempt 上送合同:漏斗终态尝试的紧凑聚合事件。
// 纪律与 DiagnosticEvent 同源:精确键集、逐字段白名单、⛔ 自由文本/原始毫秒/地址/令牌。
// 创始人四点补牢:稳定 attemptKey(跨重启幂等)、阶段强类型(严格解析器)、
// 只送白名单阶段码+相位+耗时桶;4xx/可重试分流在客户端队列层。
export const CONNECTION_ATTEMPT_TRIGGERS = ['connect', 'reconnect'] as const
export const CONNECTION_ATTEMPT_OUTCOMES = ['connected', 'reused', 'failed', 'fatal', 'abandoned'] as const
/** 上送的终态子集:superseded/stopped 无分析价值,⛔ 入合同。 */
export const CONNECTION_ATTEMPT_STAGES = [
  'startup-restore', 'shutdown-recovery', 'existing-proxy-probe', 'direct-path-probe',
  'connector-start', 'bridge-start', 'path-verify-before-settings', 'settings-write', 'path-verify-after-settings'
] as const
export const ATTEMPT_MS_BUCKETS = ['under-5s', '5s-30s', '30s-2m', '2m-10m', 'over-10m', 'unknown'] as const
/** stageMsBuckets 条目上限(阶段白名单共 9 项,同阶段可因重试重复出现)。 */
export const ATTEMPT_STAGE_ENTRIES_MAX = 12
export const ATTEMPT_STAGE_ENTRY_MAX_BYTES = 24
/** 序列化上限:后台路由同限。 */
export const CONNECTION_ATTEMPT_MAX_BYTES = 2048

export type ConnectionAttemptTrigger = typeof CONNECTION_ATTEMPT_TRIGGERS[number]
export type ConnectionAttemptOutcome = typeof CONNECTION_ATTEMPT_OUTCOMES[number]
export type ConnectionAttemptStage = typeof CONNECTION_ATTEMPT_STAGES[number]
export type AttemptMsBucket = typeof ATTEMPT_MS_BUCKETS[number]
export type ConnectionAttemptPhase = 'dns' | 'tcp' | 'tls' | 'proxy' | 'backend' | 'timeout' | 'unknown'

export interface ConnectionAttemptEvent {
  readonly eventId: string
  readonly kind: 'connection-attempt'
  /** 稳定键 trigger:startedAt——源自漏斗行,进程重启不变且与终态解耦;后台按 customerId+attemptKey 幂等(先到终态为准)。 */
  readonly attemptKey: string
  readonly trigger: ConnectionAttemptTrigger
  readonly outcome: ConnectionAttemptOutcome
  readonly firstFailedStage?: ConnectionAttemptStage
  readonly phase?: ConnectionAttemptPhase
  readonly totalMsBucket: AttemptMsBucket
  /** '阶段=桶' 条目,逐项严格解析(阶段∈白名单、桶∈白名单、条数/长度上限)。 */
  readonly stageMsBuckets: readonly string[]
  readonly clientVersion: string
  readonly platform: 'macos' | 'windows'
  readonly authorizationHash: string
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$/
// 稳定键=trigger:startedAt(⛔ 不含 outcome):同一次尝试的终态若在客户端重放时不同,
// 后端幂等以先到的为准——键含 outcome 会让「同一次尝试」计两次。终态不可变由漏斗
// 单写者保证(daemon-core 只在闭合时写终态一次);键不含 outcome 使重放天然幂等。
const ATTEMPT_KEY_PATTERN = /^(connect|reconnect):\d{1,15}$/
const REQUIRED_EVENT_KEYS = ['attemptKey', 'authorizationHash', 'clientVersion', 'eventId', 'kind', 'outcome', 'platform', 'stageMsBuckets', 'totalMsBucket', 'trigger'] as const
const OPTIONAL_EVENT_KEYS = ['firstFailedStage', 'phase'] as const

/** 桶分界与 diagnosticDurationBucket 同口径;原始毫秒只在本地换桶,⛔ 上送。 */
export function attemptBucketOf(durationMs: number | undefined): AttemptMsBucket {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return 'unknown'
  if (durationMs < 5_000) return 'under-5s'
  if (durationMs < 30_000) return '5s-30s'
  if (durationMs < 2 * 60_000) return '30s-2m'
  if (durationMs < 10 * 60_000) return '2m-10m'
  return 'over-10m'
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 严格验形:精确键集+逐字段白名单;任何一处不合形整体拒绝(⛔ 部分采纳)。 */
export function parseConnectionAttemptEvent(input: unknown): ConnectionAttemptEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Partial<ConnectionAttemptEvent>
  // 键集:必填全在;可选(firstFailedStage/phase)可缺席,在则合法;⛔ 任何多余键。
  const keys = Object.keys(input)
  if (keys.length !== REQUIRED_EVENT_KEYS.length + OPTIONAL_EVENT_KEYS.filter((optional) => optional in input).length) return undefined
  if (!REQUIRED_EVENT_KEYS.every((required) => required in input)) return undefined
  if (keys.some((key) => ![...REQUIRED_EVENT_KEYS, ...OPTIONAL_EVENT_KEYS].includes(key as typeof REQUIRED_EVENT_KEYS[number]))) return undefined
  if (value.kind !== 'connection-attempt') return undefined
  if (typeof value.eventId !== 'string' || !UUID_PATTERN.test(value.eventId)) return undefined
  if (typeof value.attemptKey !== 'string' || !ATTEMPT_KEY_PATTERN.test(value.attemptKey)) return undefined
  if (!CONNECTION_ATTEMPT_TRIGGERS.includes(value.trigger as ConnectionAttemptTrigger)) return undefined
  if (!CONNECTION_ATTEMPT_OUTCOMES.includes(value.outcome as ConnectionAttemptOutcome)) return undefined
  if (value.firstFailedStage !== undefined && !CONNECTION_ATTEMPT_STAGES.includes(value.firstFailedStage as ConnectionAttemptStage)) return undefined
  if (value.phase !== undefined &&
      !['dns', 'tcp', 'tls', 'proxy', 'backend', 'timeout', 'unknown'].includes(value.phase)) return undefined
  if (!ATTEMPT_MS_BUCKETS.includes(value.totalMsBucket as AttemptMsBucket)) return undefined
  if (!isStringArray(value.stageMsBuckets) || value.stageMsBuckets.length > ATTEMPT_STAGE_ENTRIES_MAX) return undefined
  for (const entry of value.stageMsBuckets) {
    if (Buffer.byteLength(entry, 'utf8') > ATTEMPT_STAGE_ENTRY_MAX_BYTES) return undefined
    const separator = entry.indexOf('=')
    if (separator <= 0) return undefined
    const stage = entry.slice(0, separator)
    const bucket = entry.slice(separator + 1)
    if (!CONNECTION_ATTEMPT_STAGES.includes(stage as ConnectionAttemptStage)) return undefined
    if (!ATTEMPT_MS_BUCKETS.includes(bucket as AttemptMsBucket)) return undefined
  }
  if (typeof value.clientVersion !== 'string' || !CLIENT_VERSION_PATTERN.test(value.clientVersion)) return undefined
  if (value.platform !== 'macos' && value.platform !== 'windows') return undefined
  if (typeof value.authorizationHash !== 'string' || value.authorizationHash !== 'none' && !/^[a-f0-9]{64}$/.test(value.authorizationHash)) return undefined
  if (JSON.stringify(value).length > CONNECTION_ATTEMPT_MAX_BYTES) return undefined
  return value as ConnectionAttemptEvent
}

/** 漏斗行 → 事件(纯函数):superseded/stopped/in-progress ⛔ 上送;失败行取首个非 ok 阶段;
 * 耗时只出桶(总时长=endedAt-startedAt,阶段=行内 durationMs)。 */
export interface FunnelAttemptLike {
  trigger: string
  startedAt: number
  outcome: string
  endedAt: number | null
  nodeId?: string
  legRole?: 'primary' | 'secondary'
  stages: ReadonlyArray<{ name: string; outcome: string; durationMs?: number; phase?: string }>
}

export function connectionAttemptKeyOf(attempt: FunnelAttemptLike): string | undefined {
  if (!CONNECTION_ATTEMPT_TRIGGERS.includes(attempt.trigger as ConnectionAttemptTrigger)) return undefined
  if (!CONNECTION_ATTEMPT_OUTCOMES.includes(attempt.outcome as ConnectionAttemptOutcome)) return undefined
  if (!Number.isInteger(attempt.startedAt) || attempt.startedAt <= 0) return undefined
  return `${attempt.trigger}:${attempt.startedAt}`
}

export function buildConnectionAttemptEvent(input: {
  attempt: FunnelAttemptLike
  eventId: string
  clientVersion: string
  platform: 'macos' | 'windows'
  authorizationHash: string
}): ConnectionAttemptEvent | undefined {
  const attemptKey = connectionAttemptKeyOf(input.attempt)
  if (attemptKey === undefined) return undefined
  const failedStage = input.attempt.stages.find((stage) => stage.outcome !== 'ok')
  const event: ConnectionAttemptEvent = {
    eventId: input.eventId,
    kind: 'connection-attempt',
    attemptKey,
    trigger: input.attempt.trigger as ConnectionAttemptTrigger,
    outcome: input.attempt.outcome as ConnectionAttemptOutcome,
    ...(failedStage !== undefined && CONNECTION_ATTEMPT_STAGES.includes(failedStage.name as ConnectionAttemptStage)
      ? { firstFailedStage: failedStage.name as ConnectionAttemptStage } : {}),
    ...(failedStage?.phase !== undefined && ['dns', 'tcp', 'tls', 'proxy', 'backend', 'timeout', 'unknown'].includes(failedStage.phase)
      ? { phase: failedStage.phase as ConnectionAttemptPhase } : {}),
    totalMsBucket: attemptBucketOf(input.attempt.endedAt !== null ? input.attempt.endedAt - input.attempt.startedAt : undefined),
    stageMsBuckets: input.attempt.stages
      .filter((stage) => CONNECTION_ATTEMPT_STAGES.includes(stage.name as ConnectionAttemptStage))
      .slice(0, ATTEMPT_STAGE_ENTRIES_MAX)
      .map((stage) => `${stage.name}=${attemptBucketOf(stage.durationMs)}`),
    clientVersion: input.clientVersion,
    platform: input.platform,
    authorizationHash: input.authorizationHash
  }
  return parseConnectionAttemptEvent(event) === undefined ? undefined : event
}
