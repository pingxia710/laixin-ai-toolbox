// 0.7.3 客户端可达性上报合同。
// 只发送节点标识、结果、受控失败分类、探测耗时和腿角色；不带地址、域名、正文或客户身份。
import { randomUUID } from 'node:crypto'
import type { FunnelAttemptLike } from './connection-attempt-types'

export const REACHABILITY_MAX_BYTES = 2 * 1024
export const REACHABILITY_BATCH_LIMIT = 20
export type ReachabilityResult = 'ok' | 'failed'
export type ReachabilityLegRole = 'primary' | 'secondary'
export interface ReachabilityEvent {
  readonly eventId: string
  readonly clientVersion: string
  readonly platform: 'macos' | 'windows'
  readonly nodeId: string
  readonly at: number
  readonly result: ReachabilityResult
  readonly failureCategory: string | null
  readonly rttMs: number | null
  readonly legRole: ReachabilityLegRole
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const FAILURE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/

export function parseReachabilityEvent(input: unknown): ReachabilityEvent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Partial<ReachabilityEvent>
  const keys = Object.keys(input).sort().join(',')
  if (keys !== 'at,clientVersion,eventId,failureCategory,legRole,nodeId,platform,result,rttMs') return undefined
  if (typeof value.eventId !== 'string' || !UUID_PATTERN.test(value.eventId) ||
      typeof value.clientVersion !== 'string' || !CLIENT_VERSION_PATTERN.test(value.clientVersion) ||
      value.platform !== 'macos' && value.platform !== 'windows' ||
      typeof value.nodeId !== 'string' || !NODE_ID_PATTERN.test(value.nodeId) ||
      !Number.isSafeInteger(value.at) || (value.at ?? -1) < 0 ||
      value.result !== 'ok' && value.result !== 'failed' ||
      value.failureCategory !== null && (typeof value.failureCategory !== 'string' || !FAILURE_PATTERN.test(value.failureCategory)) ||
      value.result === 'ok' && value.failureCategory !== null ||
      value.result === 'failed' && (value.failureCategory === null || typeof value.failureCategory !== 'string') ||
      value.rttMs !== null && (!Number.isSafeInteger(value.rttMs) || (value.rttMs ?? -1) < 0 || (value.rttMs ?? 120_001) > 120_000) ||
      value.legRole !== 'primary' && value.legRole !== 'secondary' ||
      JSON.stringify(value).length > REACHABILITY_MAX_BYTES) return undefined
  return value as ReachabilityEvent
}

function failureCategoryOf(attempt: FunnelAttemptLike): string | null {
  if (attempt.outcome === 'connected') return null
  const failed = attempt.stages.find((stage) => stage.outcome !== 'ok')
  const phase = failed?.phase
  if (phase !== undefined && ['dns', 'tcp', 'tls', 'proxy', 'backend', 'timeout'].includes(phase)) return phase.toUpperCase()
  return 'CONNECT_FAILED'
}

function rttOf(attempt: FunnelAttemptLike): number | null {
  const stage = attempt.stages.find((entry) => entry.name === 'path-verify-after-settings') ??
    attempt.stages.find((entry) => entry.name === 'path-verify-before-settings')
  const durationMs = stage?.durationMs
  if (!stage || !Number.isSafeInteger(durationMs) || (durationMs ?? -1) < 0 || (durationMs ?? 120_001) > 120_000) return null
  return durationMs as number
}

/** 漏斗终态转成一条客户侧节点可达性事件；缺少新包 nodeId 的旧包直接跳过。 */
export function buildReachabilityEvent(input: {
  readonly attempt: FunnelAttemptLike
  readonly clientVersion: string
  readonly platform: 'macos' | 'windows'
  readonly at?: number
}): ReachabilityEvent | undefined {
  if (typeof input.attempt.nodeId !== 'string' || !NODE_ID_PATTERN.test(input.attempt.nodeId)) return undefined
  if (input.attempt.outcome !== 'connected' && !['failed', 'fatal', 'abandoned'].includes(input.attempt.outcome)) return undefined
  const event: ReachabilityEvent = {
    eventId: randomUUID(), clientVersion: input.clientVersion, platform: input.platform,
    nodeId: input.attempt.nodeId, at: input.at ?? input.attempt.endedAt ?? input.attempt.startedAt,
    result: input.attempt.outcome === 'connected' ? 'ok' : 'failed',
    failureCategory: failureCategoryOf(input.attempt), rttMs: rttOf(input.attempt),
    legRole: input.attempt.legRole ?? 'primary'
  }
  return parseReachabilityEvent(event)
}
