import type { NetworkPlan } from './account-types'

// 后台商业参数单点源(“fixture”):改价、改体验额度只动这里,客户端与界面随下发值变化,无需发版。
// Confirmed product prices; bytes follow the existing provisioning convention.
export const networkPlans: readonly NetworkPlan[] = [
  { id: '20g', label: '20 GB 月套餐', bytes: 20 * 1024 ** 3, priceCents: 1990 },
  { id: '50g', label: '50 GB 月套餐', bytes: 50 * 1024 ** 3, priceCents: 2990 },
  { id: '100g', label: '100 GB 月套餐', bytes: 100 * 1024 ** 3, priceCents: 3990 },
  { id: '200g', label: '200 GB 月套餐', bytes: 200 * 1024 ** 3, priceCents: 4990 }
]

/** 工具箱使用权一次性价格。 */
export const toolboxPlan = { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' } as const

/** 免费体验额度:每账号限领一次,领取后 hours 小时内有效。 */
export const trialTerms = { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 } as const

/** 邀请有礼:一级直接邀请,注册成功即双方各得 bytes 流量,hours 小时内有效;邀请人每自然月最多 perMonth 次。 */
export const inviteRewardTerms = { bytes: 5 * 1024 ** 3, hours: 7 * 24, perMonth: 10 } as const
