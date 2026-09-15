import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms } from '../../app/account-types'
import type { NetworkUsageView } from '../../app/shared/network-usage-types'
import { networkPlans } from '../../app/network-plans'
import { mountAccountOverview } from '../../app/renderer/src/ui/account-overview'
import { requireAccount } from '../../app/renderer/src/account-state'
import { openPaymentDialog } from '../../app/renderer/src/ui/payment-dialog'

vi.mock('../../app/renderer/src/account-state', () => ({ accountAction: vi.fn(), requireAccount: vi.fn(), selectedNetworkPlan: () => undefined }))
vi.mock('../../app/renderer/src/ui/payment-dialog', () => ({ openPaymentDialog: vi.fn() }))

const terms: CommercialTerms = { plans: [...networkPlans], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' },
  trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3 }

class Element {
  textContent = ''; className = ''; type = ''; disabled = false
  children: Element[] = []; handlers = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}
const pending: NetworkUsageView = { authorizationId: 'lx-' + 'a'.repeat(32), planId: '20g', kind: 'subscription', state: 'pending',
  measurement: 'not-requested', totalBytes: 20 * 1024 ** 3, usedBytes: null, remainingBytes: null, expiresAt: null, observedAt: null, reasonCode: '' }
function render(state: AccountView['state'] = 'signed-in', usage: NetworkUsageView | null = null, channels = true,
  trial: NonNullable<AccountView['overview']>['trial'] = { available: false, usage: null }) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const root = new Element('main')
  const view: AccountView = { state, code: '', message: '', terms,
    account: state === 'signed-in' ? { id: 'local-fixture', username: 'local-fixture' } : null,
    overview: state === 'signed-in' ? { trial, recoveryReady: true, subscription: usage,
      plans: [...networkPlans], networkAvailable: true, paymentChannels: channels ? ['alipay'] : [] } : null }
  mountAccountOverview(root as unknown as HTMLElement, view, 'tunnel')
  return root.all()
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('套餐始终展示，购买按钮直接进入付款；没有申请步骤', () => {
  const nodes = render()
  expect(nodes.some((node) => node.tag === 'details')).toBe(false)
  expect(nodes.some((node) => node.textContent.includes('申请'))).toBe(false)
  const purchase = nodes.filter((node) => node.tag === 'button' && node.textContent === '支付宝购买')
  expect(purchase).toHaveLength(4)
  purchase[1].click(); expect(openPaymentDialog).toHaveBeenCalledWith(networkPlans[1], 'alipay')
})

it('存在旧待付款选择时，原套餐可继续付款，其他套餐仍可直接购买', () => {
  const nodes = render('signed-in', pending)
  nodes.find((node) => node.textContent === '支付宝继续付款')!.click()
  nodes.filter((node) => node.textContent === '支付宝购买')[0].click()
  expect(openPaymentDialog).toHaveBeenNthCalledWith(1, networkPlans[0], 'alipay')
  expect(openPaymentDialog).toHaveBeenNthCalledWith(2, networkPlans[1], 'alipay')
  expect(nodes.some((node) => node.textContent === '等待开通')).toBe(false)
})

it('未登录也能查看全部价格，点击购买登录并记住所选套餐', () => {
  const nodes = render('signed-out')
  expect(nodes.filter((node) => node.className === 'account-plan')).toHaveLength(4)
  nodes.filter((node) => node.textContent === '购买')[2].click()
  expect(requireAccount).toHaveBeenCalledWith('tunnel', networkPlans[2].id)
  expect(openPaymentDialog).not.toHaveBeenCalled()
})

it('登录前后保留两张权益卡与相同流量字段；未登录不捏造额度', () => {
  for (const state of ['signed-out', 'signed-in', 'unavailable'] as const) {
    const nodes = render(state)
    expect(nodes.filter((node) => node.className === 'account-usage-card')).toHaveLength(2)
    expect(nodes.filter((node) => node.tag === 'dt').map((node) => node.textContent)).toEqual(['总量', '已用', '剩余', '到期', '总量', '已用', '剩余', '到期'])
    expect(nodes.filter((node) => node.tag === 'dd').every((node) => node.textContent === '—')).toBe(true)
  }
})

it.each(['active', 'unknown', 'provisioning'] as const)('套餐 %s 时仍展示全部套餐，但不允许重复购买', (state) => {
  const nodes = render('signed-in', { ...pending, state })
  const buttons = nodes.filter((node) => node.tag === 'button')
  expect(buttons).toHaveLength(4); expect(buttons.every((button) => button.disabled)).toBe(true)
  buttons.forEach((button) => button.click()); expect(openPaymentDialog).not.toHaveBeenCalled()
})

it('付款渠道不可用时给出明确状态，不退回提交申请', () => {
  const nodes = render('signed-in', null, false)
  expect(nodes.some((node) => node.textContent.startsWith('在线购买暂时无法使用'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('申请'))).toBe(false)
})

it('正常开通过的体验到期后不误报开通失败', () => {
  const nodes = render('signed-in', null, true, { available: false, retryable: false, usage: {
    ...pending, kind: 'trial', planId: 'trial-5g', state: 'expired', expiresAt: 1_800_000_000_000, reasonCode: 'NETWORK_AUTHORIZATION_EXPIRED'
  } })
  expect(nodes.some((node) => node.textContent === '体验流量 · 已到期')).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('体验仍未开通成功'))).toBe(false)
})

it('确实未开通成功的过期体验仍保留客服核对提示', () => {
  const nodes = render('signed-in', null, true, { available: false, retryable: false, usage: {
    ...pending, kind: 'trial', planId: 'trial-5g', state: 'expired', reasonCode: 'NETWORK_PROVISIONING_EXPIRED'
  } })
  expect(nodes.some((node) => node.textContent.includes('体验仍未开通成功'))).toBe(true)
})

it('领取体验等待期间明确显示正在开通并禁止重复点击', () => {
  const nodes = render('signed-in', null, true, { available: true, usage: null })
  const claim = nodes.find((node) => node.textContent === '领取 5 GB 体验流量')!
  claim.click()
  expect(claim.disabled).toBe(true)
  expect(claim.textContent).toBe('正在开通，请稍候…')
})
