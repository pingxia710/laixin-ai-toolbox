import type { PaymentChannelName, PaymentOrderView } from './account-types'

export type SharingSoftware = 'codex' | 'claude'
export type SharingStatus = 'pending_payment' | 'queued' | 'processing' | 'ready' | 'active' | 'expired' | 'problem' | 'cancel_requested' | 'refund_pending' | 'refunded' | 'cancelled'
export type SharingIssue = 'cannot_login' | 'wrong_entitlement' | 'account_reclaimed' | 'other'
export interface SharingListing {
  id: string
  software: SharingSoftware
  name: string
  description: string
  priceCents: number
  serviceFeeCents: number
  term: string
  termDays: number
  deliveryHours: number
  usageTerms: string
  cancellationTerms: string
  enabled: boolean
}
export interface SharingOrderView {
  id: string
  listing: SharingListing
  status: SharingStatus
  channel: PaymentChannelName | 'manual'
  createdAt: number
  paidAt: number | null
  dueAt: number | null
  updatedAt: number
  issue: SharingIssue | null
  deliveredAt: number | null
  startsAt: number | null
  expiresAt: number | null
  revealedAt: number | null
  refundAt: number | null
  paymentId: string | null
  events: { at: number; status: SharingStatus }[]
}
export interface SharingDelivery {
  username: string
  password: string
  instructions: string
  startsAt: number
  expiresAt: number
}
export interface SharingCatalog { listings: SharingListing[]; channels: (PaymentChannelName | 'manual')[] }
export interface SharingPayment { order: SharingOrderView; payment: PaymentOrderView | null }
export type SharingIntentionStatus = 'pending' | 'contacted' | 'listed' | 'closed'
export interface SharingIntention {
  id: string
  software: SharingSoftware
  plan: string
  availableNote: string
  contact: string
  status: SharingIntentionStatus
  createdAt: number
  updatedAt: number
}
export type SharingPostSide = 'demand' | 'supply'
export type SharingProductId = 'account-rental' | 'api-quota' | 'api-period'
export type SharingQuotaUnit = 'million-tokens' | 'yuan-credit' | 'request-count'
export type SharingUsageTier = 'light' | 'standard' | 'heavy'
export type SharingPostStatus = 'published' | 'closed'
export interface SharingChoice { value: string; label: string }
export interface SharingAccountPlanChoice extends SharingChoice { software: SharingSoftware }
export interface SharingApiProviderChoice extends SharingChoice { models: SharingChoice[] }
export interface SharingStandardProduct {
  id: SharingProductId
  label: string
  description: string
  termDays: SharingChoice[]
  software: SharingChoice[]
  accountPlans: SharingAccountPlanChoice[]
  apiProviders: SharingApiProviderChoice[]
  quotaUnits: SharingChoice[]
  usageTiers: SharingChoice[]
  deliveryHours: SharingChoice[]
}
export interface SharingPostDraft {
  side: SharingPostSide
  productId: SharingProductId
  software: SharingSoftware
  accountPlan: string | null
  apiProvider: string | null
  apiModel: string | null
  termDays: number
  quotaAmount: number | null
  quotaUnit: SharingQuotaUnit | null
  usageTier: SharingUsageTier | null
  priceCents: number
  availableCount: number | null
  deliveryHours: number | null
}
export interface SharingPostView extends SharingPostDraft {
  id: string
  status: SharingPostStatus
  createdAt: number
  updatedAt: number
}
export type SharingOperation = 'catalog' | 'standards' | 'posts' | 'myPosts' | 'publish' | 'closePost' | 'list' | 'create' | 'detail' | 'pay' | 'reveal' | 'complete' | 'cancel' | 'report' | 'intentions' | 'share'
export const sharingMessages: Record<string, string> = {
  SHARING_UNAVAILABLE: '账号分享暂未开放租用。',
  SHARING_INVALID: '信息不完整，请刷新后重试。',
  SHARING_NOT_FOUND: '找不到这笔租单，请确认登录账号。',
  SHARING_CONFLICT: '租单状态已变化，请刷新后继续。',
  SHARING_UNPAID: '尚未确认付款，请先完成付款。',
  SHARING_DELIVERY_UNAVAILABLE: '暂时无法读取交付资料，请联系来信客服。',
  SHARING_INTENTION_INVALID: '登记信息不完整，请检查后重试。',
  SHARING_POST_INVALID: '发布内容不符合标准模板，请检查后重试。'
}
