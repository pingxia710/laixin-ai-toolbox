import { createHash } from 'node:crypto'
import { KNOWN_FAILURE_CODES } from './main/tunnel/failure-codes'

export const DIAGNOSTIC_DURATION_BUCKETS = ['under-5s', '5s-30s', '30s-2m', '2m-10m', 'over-10m', 'unknown'] as const
export const DIAGNOSTIC_PATH_TYPES = ['laixin', 'reused', 'unknown'] as const
export const DIAGNOSTIC_REPAIR_ACTIONS = ['none', 'repair', 'reconnect'] as const
export const DIAGNOSTIC_REPAIR_RESULTS = ['not-run', 'running', 'recovered', 'still-failing', 'unknown', 'cancelled'] as const
// JS 的 `$` 可在末尾换行前命中；前置否定彻底禁掉所有行终止符，避免版本字段夹带正文。
export const DIAGNOSTIC_CLIENT_VERSION_PATTERN = /^(?![\s\S]*[\n\r\u2028\u2029])[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-(?:test(?:\.[0-9]{1,4})?|rc\.[0-9]{1,4}|alpha(?:\.[0-9]{1,4})?|beta(?:\.[0-9]{1,4})?|unified\.[0-9]{1,4}|ui\.[0-9]{1,4}|fix\.[0-9]{1,4}|compare\.[0-9]{1,4}|customer-ops\.[0-9]{1,4}|fb[0-9]{1,4}))?$/

export type DiagnosticDurationBucket = typeof DIAGNOSTIC_DURATION_BUCKETS[number]
export type DiagnosticPathType = typeof DIAGNOSTIC_PATH_TYPES[number]
export type DiagnosticRepairAction = typeof DIAGNOSTIC_REPAIR_ACTIONS[number]
export type DiagnosticRepairResult = typeof DIAGNOSTIC_REPAIR_RESULTS[number]

export const DIAGNOSTIC_AUTHORIZATION_HASH_ROTATION_MS = 7 * 24 * 60 * 60_000
export const DIAGNOSTIC_AUTHORIZATION_HASH_LOOKBACK_WINDOWS = 16

export function diagnosticAuthorizationHashAt(authorizationId: string, at: number): string {
  if (authorizationId === '') return 'none'
  const window = Math.floor(Math.max(0, at) / DIAGNOSTIC_AUTHORIZATION_HASH_ROTATION_MS)
  return createHash('sha256').update(`laixin:n53:${String(window)}:${authorizationId}`).digest('hex')
}

/** N-53 本机队列与后台共用的完整白名单。resultBucket 是最终路径结果，
 * repairResult 是修复动作自身结果，两者独立；事件不含地址、端口、域名或正文。 */
export interface DiagnosticEvent {
  readonly eventId: string
  readonly failureCategory: string
  readonly resultBucket: 'failed' | 'recovered'
  readonly durationBucket: DiagnosticDurationBucket
  readonly pathType: DiagnosticPathType
  readonly repairAction: DiagnosticRepairAction
  readonly repairResult: DiagnosticRepairResult
  readonly clientVersion: string
  readonly platform: 'macos' | 'windows'
  readonly authorizationHash: string
}

const EVENT_KEYS = [
  'authorizationHash', 'clientVersion', 'durationBucket', 'eventId', 'failureCategory',
  'pathType', 'platform', 'repairAction', 'repairResult', 'resultBucket'
] as const

export function parseDiagnosticEvent(input: unknown,
  options: { readonly normalizeUnknownFailureCategory?: boolean } = {}): DiagnosticEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Partial<DiagnosticEvent>
  if (Object.keys(value).sort().join(',') !== [...EVENT_KEYS].sort().join(',')) return undefined
  if (typeof value.eventId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.eventId)) return undefined
  if (typeof value.failureCategory !== 'string' || !/^[A-Z0-9_\u4e00-\u9fff]{2,80}$/.test(value.failureCategory)) return undefined
  const failureCategory = KNOWN_FAILURE_CODES.has(value.failureCategory) ? value.failureCategory
    : options.normalizeUnknownFailureCategory ? 'UNKNOWN' : undefined
  if (failureCategory === undefined) return undefined
  if (value.resultBucket !== 'failed' && value.resultBucket !== 'recovered') return undefined
  if (!DIAGNOSTIC_DURATION_BUCKETS.includes(value.durationBucket as DiagnosticDurationBucket)) return undefined
  if (!DIAGNOSTIC_PATH_TYPES.includes(value.pathType as DiagnosticPathType)) return undefined
  if (!DIAGNOSTIC_REPAIR_ACTIONS.includes(value.repairAction as DiagnosticRepairAction)) return undefined
  if (!DIAGNOSTIC_REPAIR_RESULTS.includes(value.repairResult as DiagnosticRepairResult)) return undefined
  if (typeof value.clientVersion !== 'string' || !DIAGNOSTIC_CLIENT_VERSION_PATTERN.test(value.clientVersion)) return undefined
  if (value.platform !== 'macos' && value.platform !== 'windows') return undefined
  if (typeof value.authorizationHash !== 'string' || value.authorizationHash !== 'none' && !/^[a-f0-9]{64}$/.test(value.authorizationHash)) return undefined
  if (value.resultBucket === 'recovered' && (value.pathType === 'unknown' || value.repairAction === 'none' ||
      value.repairResult === 'not-run' || value.repairResult === 'running' ||
      value.repairAction === 'reconnect' && value.repairResult !== 'recovered')) return undefined
  return { ...value, failureCategory } as DiagnosticEvent
}

export function diagnosticDurationBucket(durationMs: number | undefined): DiagnosticDurationBucket {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return 'unknown'
  if (durationMs < 5_000) return 'under-5s'
  if (durationMs < 30_000) return '5s-30s'
  if (durationMs < 2 * 60_000) return '30s-2m'
  if (durationMs < 10 * 60_000) return '2m-10m'
  return 'over-10m'
}
