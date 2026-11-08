export interface SingleAddressRefreshFailure {
  readonly state?: string
  readonly code?: string
  readonly connectStage?: string
}

const DATA_PLANE_TIMEOUT_STAGES: ReadonlySet<string> = new Set([
  'connector-start',
  'path-verify-before-settings',
  'path-verify-after-settings'
])

const REFRESH_RETRY_CODES: ReadonlySet<string> = new Set([
  'NETWORK_SERVICE_UNAVAILABLE',
  'NETWORK_LEASE_INVALID',
  'NETWORK_LEASE_CONTINUATION'
])

/** 只把当前守护的真实数据面异常交给单地址绑定刷新。 */
export function isSingleAddressRefreshFailure(failure: SingleAddressRefreshFailure): boolean {
  if (failure.state !== 'error' || typeof failure.code !== 'string' || failure.code === '') return false
  if (failure.code === '上游不可达') return failure.connectStage === undefined || failure.connectStage !== 'bridge-start'
  if (failure.code !== 'TUNNEL_CONNECTION_TIMEOUT') return false
  // 未知阶段不能证明是数据面故障；本地 bridge-start 明确排除。
  return failure.connectStage !== undefined && DATA_PLANE_TIMEOUT_STAGES.has(failure.connectStage)
}

/** 刷新后台瞬时失败的有界退避：首次立即、随后 1s/3s，之后停止。 */
export function singleAddressRefreshRetryDelay(attempt: number): number | undefined {
  return attempt === 0 ? 0 : attempt === 1 ? 1_000 : attempt === 2 ? 3_000 : undefined
}

export function shouldRetrySingleAddressRefresh(code: string): boolean {
  return REFRESH_RETRY_CODES.has(code)
}
