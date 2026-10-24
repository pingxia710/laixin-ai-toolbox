/** Network entitlement state only; it never claims the device is connected. */
export interface NetworkUsageView {
  authorizationId: string
  kind: 'subscription' | 'trial' | 'invite'
  planId: string
  state: 'pending' | 'queued' | 'provisioning' | 'active' | 'exhausted' | 'expired' | 'disabled' | 'unknown'
  measurement: 'current' | 'unavailable' | 'not-requested'
  totalBytes: number
  usedBytes: number | null
  remainingBytes: number | null
  /** 该份权益成立时间；付费套餐等于支付渠道确认时间。旧后台可缺省。 */
  startsAt?: number | null
  expiresAt: number | null
  observedAt: number | null
  reasonCode: string
}
