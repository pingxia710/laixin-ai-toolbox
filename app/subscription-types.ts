import type { PaymentChannelName, PaymentOrderView } from './account-types'

export type SubscriptionSoftware = 'codex' | 'claude'
export type SubscriptionStatus = 'pending_payment' | 'queued' | 'processing' | 'ready' | 'completed' | 'problem' | 'cancel_requested' | 'refund_pending' | 'refunded' | 'cancelled'
export type SubscriptionIssue = 'cannot_login' | 'wrong_entitlement' | 'cannot_deliver' | 'other'
export interface SubscriptionProduct {
  id: string
  software: SubscriptionSoftware
  name: string
  description: string
  priceCents: number
  serviceFeeCents: number
  term: string
  deliveryHours: number
  fulfillmentTerms: string
  recoveryTerms: string
  cancellationTerms: string
  enabled: boolean
}
export interface SubscriptionOrderView {
  id: string
  product: SubscriptionProduct
  status: SubscriptionStatus
  channel: PaymentChannelName | 'manual'
  createdAt: number
  paidAt: number | null
  dueAt: number | null
  updatedAt: number
  issue: SubscriptionIssue | null
  deliveredAt: number | null
  startsAt: number | null
  expiresAt: number | null
  revealedAt: number | null
  refundAt: number | null
  paymentId: string | null
  events: { at: number; status: SubscriptionStatus }[]
}
export interface SubscriptionDelivery {
  username: string
  password: string
  instructions: string
  startsAt: number
  expiresAt: number
}
export interface SubscriptionCatalog { products: SubscriptionProduct[]; channels: (PaymentChannelName | 'manual')[] }
export interface SubscriptionPayment { order: SubscriptionOrderView; payment: PaymentOrderView | null }
export type SubscriptionOperation = 'catalog' | 'list' | 'create' | 'detail' | 'pay' | 'reveal' | 'complete' | 'cancel' | 'report'
export const subscriptionMessages: Record<string, string> = {
  SUBSCRIPTION_UNAVAILABLE: '代订阅暂未开放购买。',
  SUBSCRIPTION_INVALID: '信息不完整，请刷新后重试。',
  SUBSCRIPTION_NOT_FOUND: '找不到这笔订单，请确认登录账号。',
  SUBSCRIPTION_CONFLICT: '订单状态已变化，请刷新后继续。',
  SUBSCRIPTION_UNPAID: '尚未确认付款，请先完成付款。',
  SUBSCRIPTION_DELIVERY_UNAVAILABLE: '暂时无法读取交付资料，请联系来信客服。'
}
