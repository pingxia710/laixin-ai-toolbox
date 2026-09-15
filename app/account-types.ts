import type { NetworkUsageView } from './shared/network-usage-types'

export interface AccountIdentity { id: string; username: string }
export type AccountDevice = 'macos' | 'windows' | 'linux' | 'web' | 'unknown'
export interface AccountLogin { id: string; device: AccountDevice; deviceId?: string; createdAt: number | null; expiresAt: number; current: boolean }
export interface InstallationRecord {
  software: 'hermes' | 'codex' | 'claude'
  platform: 'mac' | 'windows'
  stage: string
  evidence: 'reliable-detection' | 'customer-confirmation' | 'unknown'
  updatedAt: number
  stageLabel?: string
  deviceId?: string
  errorCode?: string | null
  lastError?: { code: string; at: number }
}
export interface ToolboxPurchase {
  id: string; status: 'pending' | 'paid' | 'refunded'; amountFen: number; createdAt: number; paidAt: number | null
  refundedFen?: number
}
export interface CustomerProfile extends AccountIdentity {
  createdAt: number | null; lastLoginAt: number | null; closedAt: number | null
  installations: InstallationRecord[]; toolbox: ToolboxPurchase | null
}
export interface AccountSession { account: AccountIdentity; accessToken: string; expiresAt: number }
export interface AccountRegistration extends AccountSession { recoveryCode: string }
export interface RecoveryResult { view: AccountView; recoveryCode: string }
export interface NetworkPlan { id: string; label: string; bytes: number; priceCents: number }
/** 商业参数(套餐、工具箱价格、体验额度、设备上限):后台 /v1/account/plans 下发,客户端只展示与按值校验。 */
export interface CommercialTerms {
  plans: NetworkPlan[]
  toolbox: { id: string; priceCents: number; subject: string }
  trial: { bytes: number; hours: number; perAccount: number }
  deviceLimit: number
  /** 邀请有礼条款；旧版后台缺省时界面退化为不含数字的通用文案。 */
  invite?: { bytes: number; hours: number; perMonth: number }
}
export type PaymentChannelName = 'alipay' | 'wechat'
export interface PaymentRedirect { kind: 'url' | 'qrcode'; data: string; expiresAt: number }
export interface PaymentOrderView {
  orderId: string
  applicationId: string
  planId: string
  channel: PaymentChannelName
  amountFen: number
  status: 'open' | 'paid' | 'confirmed' | 'partially_refunded' | 'refunded' | 'cancelled'
  /** 本人订单的创建时间；后台投影下发的客户可读安全字段，旧版后台缺省时界面不虚构。 */
  createdAt?: number
  paidAt: number | null
  redirect: PaymentRedirect | null
  confirmError: string | null
  expiresAt?: number | null
  cancelPending?: boolean
  refundedFen?: number
}
export interface InviteRewardView {
  id: string
  role: 'inviter' | 'invitee'
  bytes: number
  grantedAt: number
  expiresAt: number
  state: 'pending' | 'provisioning' | 'active' | 'exhausted' | 'expired' | 'disabled' | 'unknown' | 'unavailable'
  remainingBytes: number | null
  usedBytes: number | null
}
/** 账号页邀请块：本人邀请码、邀请来源与奖励台账的诚实展示状态。旧版后台缺省时界面不渲染邀请卡。 */
export interface InviteOverview {
  code: string | null
  invitedBy: string | null
  rewards: InviteRewardView[]
}
export interface AccountOverview {
  profile?: CustomerProfile
  trial: { available: boolean; usage: NetworkUsageView | null; retryable?: boolean; compensated?: boolean }
  recoveryReady: boolean
  subscription: NetworkUsageView | null
  plans: NetworkPlan[]
  networkAvailable: boolean
  paymentChannels: readonly PaymentChannelName[]
  invite?: InviteOverview
}
export interface AccountView {
  state: 'signed-out' | 'signed-in' | 'unavailable'
  account: AccountIdentity | null
  code: string
  message: string
  overview: AccountOverview | null
  /** 后台下发的商业参数快照;后台未提供(旧版)时缺省,文案退化为不含具体数字的通用表述。 */
  terms?: CommercialTerms | null
}
