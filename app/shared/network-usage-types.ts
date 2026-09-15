/** Network entitlement state only; it never claims the device is connected. */
export interface NetworkUsageView {
  authorizationId: string
  kind: 'subscription' | 'trial' | 'invite'
  planId: string
  state: 'pending' | 'provisioning' | 'active' | 'exhausted' | 'expired' | 'disabled' | 'unknown'
  measurement: 'current' | 'unavailable' | 'not-requested'
  totalBytes: number
  usedBytes: number | null
  remainingBytes: number | null
  expiresAt: number | null
  observedAt: number | null
  reasonCode: string
}
