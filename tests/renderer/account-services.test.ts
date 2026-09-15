import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, PaymentOrderView } from '../../app/account-types'
import type { SharingListing, SharingOrderView } from '../../app/sharing-types'
import type { SubscriptionOrderView, SubscriptionProduct } from '../../app/subscription-types'
import { mountAccountServices } from '../../app/renderer/src/ui/account-services'

class Element {
  textContent = ''
  children: Element[] = []
  isConnected = true
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  addEventListener() {}
  allText(): string { return [this.textContent, ...this.children.map((child) => child.allText())].join('\n') }
}

afterEach(() => vi.unstubAllGlobals())

const signedOut: AccountView = { state: 'signed-out', account: null, overview: null, code: '', message: '' }

const subscriptionProduct: SubscriptionProduct = {
  id: 'sub-codex-monthly', software: 'codex', name: 'Codex Plus 代订阅', description: 'x', priceCents: 19900,
  serviceFeeCents: 900, term: '一个月', deliveryHours: 24, fulfillmentTerms: 'x', recoveryTerms: 'x', cancellationTerms: 'x', enabled: true
}
const sharingListing: SharingListing = {
  id: 'share-claude-30d', software: 'claude', name: 'Claude 账号合租 · 30 天', description: 'x', priceCents: 9900,
  serviceFeeCents: 0, term: '30 天', termDays: 30, deliveryHours: 12, usageTerms: 'x', cancellationTerms: 'x', enabled: true
}

const subOrder = (overrides: Partial<SubscriptionOrderView>): SubscriptionOrderView => ({
  id: `lx-${'1'.repeat(32)}`, product: subscriptionProduct, status: 'pending_payment', channel: 'alipay',
  createdAt: Date.UTC(2026, 8, 14, 1, 0, 0), paidAt: null, dueAt: null, updatedAt: Date.UTC(2026, 8, 14, 1, 0, 0),
  issue: null, deliveredAt: null, startsAt: null, expiresAt: null, revealedAt: null, refundAt: null, paymentId: null, events: [],
  ...overrides
})
const shareOrder = (overrides: Partial<SharingOrderView>): SharingOrderView => ({
  id: `lx-${'2'.repeat(32)}`, listing: sharingListing, status: 'active', channel: 'wechat',
  createdAt: Date.UTC(2026, 8, 13, 1, 0, 0), paidAt: Date.UTC(2026, 8, 13, 2, 0, 0), dueAt: Date.UTC(2026, 8, 13, 14, 0, 0),
  updatedAt: Date.UTC(2026, 8, 13, 2, 0, 0), issue: null, deliveredAt: Date.UTC(2026, 8, 13, 3, 0, 0),
  startsAt: Date.UTC(2026, 8, 13, 3, 0, 0), expiresAt: Date.UTC(2026, 10, 12, 3, 0, 0), revealedAt: null, refundAt: null, paymentId: null, events: [],
  ...overrides
})

interface SourceStubs {
  paymentOrders?: () => Promise<{ orders: string }>
  subscriptionList?: () => Promise<{ data: string; error: string }>
  sharingList?: () => Promise<{ data: string; error: string }>
}

function stubWindow(stubs: SourceStubs): { paymentOrders: ReturnType<typeof vi.fn>; subscriptionList: ReturnType<typeof vi.fn>; sharingList: ReturnType<typeof vi.fn> } {
  const paymentOrders = vi.fn(stubs.paymentOrders ?? (async () => ({ orders: '[]' })))
  const subscriptionList = vi.fn(stubs.subscriptionList ?? (async () => ({ data: JSON.stringify({ orders: [], nextCursor: '' }), error: '' })))
  const sharingList = vi.fn(stubs.sharingList ?? (async () => ({ data: JSON.stringify({ orders: [], nextCursor: '' }), error: '' })))
  vi.stubGlobal('document', { createElement: () => new Element() })
  vi.stubGlobal('window', { toolbox: { account: { paymentOrders }, subscription: { list: subscriptionList }, sharing: { list: sharingList } } })
  return { paymentOrders, subscriptionList, sharingList }
}

const signedInView = (overrides: Partial<AccountView> = {}): AccountView => ({
  state: 'signed-in', account: { id: 'local-fixture', username: 'local-fixture' }, code: '', message: '',
  overview: { trial: { available: false, usage: null }, recoveryReady: true, subscription: null,
    plans: [], networkAvailable: true, paymentChannels: [],
    profile: { id: 'local-fixture', username: 'local-fixture', createdAt: null, lastLoginAt: null, closedAt: null, toolbox: null, installations: [] }
  },
  ...overrides
})

it('未登录展示工具箱免费说明,不出现使用权购买话术,也不查询本人订单、订阅或分享', () => {
  const { paymentOrders, subscriptionList, sharingList } = stubWindow({})
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, signedOut)
  expect(root.children).toHaveLength(2)
  expect(root.children.map((card) => card.children[0].textContent)).toEqual(['工具箱', '支付与服务'])
  const text = root.allText()
  expect(text).toContain('工具箱免费')
  expect(text).toContain('登录后查看')
  for (const banned of ['使用权', '申请购买', '重新购买', '支付宝付款', '微信付款']) expect(text).not.toContain(banned)
  expect(paymentOrders).not.toHaveBeenCalled()
  expect(subscriptionList).not.toHaveBeenCalled()
  expect(sharingList).not.toHaveBeenCalled()
})

it('已登录不展示工具箱购买动作;旧购买历史只读展示', () => {
  stubWindow({})
  const view = signedInView({
    overview: { trial: { available: false, usage: null }, recoveryReady: true, subscription: null,
      plans: [], networkAvailable: true, paymentChannels: [],
      profile: { id: 'local-fixture', username: 'local-fixture', createdAt: null, lastLoginAt: null,
        closedAt: null, toolbox: { id: `lx-${'a'.repeat(32)}`, status: 'refunded', amountFen: 1990, createdAt: 1, paidAt: 1, refundedFen: 1990 }, installations: [] }
    }
  })
  const root = new Element()
  const before = JSON.stringify(view)
  mountAccountServices(root as unknown as HTMLElement, view)
  expect(root.children.map((card) => card.children[0].textContent)).toEqual(['工具箱', '支付与服务'])
  const text = root.allText()
  expect(text).toContain('工具箱免费')
  expect(text).toContain('已退款')
  expect(text).toContain('累计已退 ¥19.90')
  for (const banned of ['申请购买工具箱', '重新购买工具箱', '支付宝付款', '微信付款', '一次购买']) expect(text).not.toContain(banned)
  expect(text).not.toContain('AI 安装记录')
  expect(text).not.toContain('继续安装 AI')
  expect(JSON.stringify(view)).toBe(before)
})

it('付款订单里网络订单保留继续付款,toolbox 历史订单只读不再提供付款入口', async () => {
  const orders: PaymentOrderView[] = [
    { orderId: 'a'.repeat(32), applicationId: 'lx-' + 'b'.repeat(32), planId: 'toolbox', channel: 'alipay', amountFen: 1990, status: 'open', paidAt: null, redirect: null, confirmError: null },
    { orderId: 'c'.repeat(32), applicationId: 'lx-' + 'd'.repeat(32), planId: '20g', channel: 'wechat', amountFen: 1990, status: 'open', paidAt: null, redirect: null, confirmError: null }
  ]
  stubWindow({ paymentOrders: async () => ({ orders: JSON.stringify(orders) }) })
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, signedInView())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = root.allText()
  expect(text).toContain('工具箱使用权（历史订单）')
  expect(text).toContain('工具箱已免费')
  // 只有网络待付款订单保留继续付款;取消动作两者都在。
  expect(text.split('继续付款').length - 1).toBe(1)
  expect(text.split('取消此订单').length - 1).toBe(2)
})

it('AC-03:网络订单显示产品标签与创建时间,不再只给原始 planId', async () => {
  const orders: PaymentOrderView[] = [
    { orderId: 'c'.repeat(32), applicationId: 'lx-' + 'd'.repeat(32), planId: '20g', channel: 'wechat', amountFen: 1990, status: 'open', paidAt: null, redirect: null, confirmError: null, createdAt: Date.UTC(2026, 8, 15, 4, 0, 0) }
  ]
  stubWindow({ paymentOrders: async () => ({ orders: JSON.stringify(orders) }) })
  const view = signedInView({ terms: { plans: [{ id: '20g', label: '20GB 套餐', bytes: 20 * 1024 ** 3, priceCents: 1990 }],
    toolbox: { id: 'toolbox', priceCents: 1990, subject: 'x' }, trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3 } })
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, view)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = root.allText()
  expect(text).toContain('20GB 套餐')
  expect(text).toContain('创建于')
  expect(text).toContain('2026/9/15')
  expect(text).toContain('待付款')
})

it('AC-03:账号订阅与账号分享进入支付与服务摘要;待付款只跳各自页面,不生成第二份付款入口', async () => {
  stubWindow({
    subscriptionList: async () => ({ data: JSON.stringify({ orders: [
      subOrder({ id: `lx-${'3'.repeat(32)}`, status: 'completed', createdAt: Date.UTC(2026, 7, 1, 1, 0, 0) }),
      subOrder({ id: `lx-${'4'.repeat(32)}`, status: 'pending_payment' })
    ], nextCursor: '' }), error: '' }),
    sharingList: async () => ({ data: JSON.stringify({ orders: [shareOrder({})], nextCursor: '' }), error: '' })
  })
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, signedInView())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = root.allText()
  expect(text).toContain('账号订阅')
  expect(text).toContain('Codex Plus 代订阅')
  expect(text).toContain('等待付款')
  expect(text).toContain('去账号订阅页')
  expect(text).toContain('账号分享')
  expect(text).toContain('Claude 账号合租 · 30 天')
  expect(text).toContain('租用中')
  expect(text).toContain('查看账号分享租单')
  // 进行中的条目排在历史之前
  expect(text.indexOf('等待付款')).toBeLessThan(text.indexOf('已确认完成'))
  // 账号页不为订阅/分享生成第二份付款入口
  expect(text.split('继续付款').length - 1).toBe(0)
  for (const banned of ['二维码', '扫码支付', '微信付款', '支付宝付款']) expect(text).not.toContain(banned)
})

it('AC-03:账号分享读取失败给保守提示和入口,不显示暂无', async () => {
  stubWindow({ sharingList: async () => ({ data: '', error: '账号分享暂未开放租用。' }) })
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, signedInView())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = root.allText()
  expect(text).toContain('账号分享')
  expect(text).toContain('暂时无法读取')
  expect(text).toContain('不代表没有')
  expect(text).not.toContain('暂无账号分享')
  expect(text).toContain('前往账号分享页')
})

it('AC-03:网络付款读取失败同样保守提示,不冒充空列表', async () => {
  stubWindow({ paymentOrders: async () => { throw new Error('PAYMENT_SERVICE_DOWN') } })
  const root = new Element()
  mountAccountServices(root as unknown as HTMLElement, signedInView())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = root.allText()
  expect(text).toContain('网络套餐')
  expect(text).toContain('暂时无法读取')
  expect(text).toContain('不代表没有')
  expect(text).not.toContain('暂无网络套餐')
})
