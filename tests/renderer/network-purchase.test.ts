import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms, PaymentChannelName } from '../../app/account-types'
import type { NetworkUsageView } from '../../app/shared/network-usage-types'
import { networkPlans } from '../../app/network-plans'
import { mountAccountOverview, mountTrafficSummary } from '../../app/renderer/src/ui/account-overview'
import { accountAction, requireAccount } from '../../app/renderer/src/account-state'
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
function render(state: AccountView['state'] = 'signed-in', usage: NetworkUsageView | null = null, channels: boolean | readonly PaymentChannelName[] = true,
  trial: NonNullable<AccountView['overview']>['trial'] = { available: false, usage: null }, from: 'account' | 'tunnel' = 'tunnel') {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const root = new Element('main')
  const view: AccountView = { state, code: '', message: '', terms,
    account: state === 'signed-in' ? { id: 'local-fixture', username: 'local-fixture' } : null,
    overview: state === 'signed-in' ? { trial, recoveryReady: true, subscription: usage,
      plans: [...networkPlans], networkAvailable: true, paymentChannels: typeof channels === 'boolean' ? channels ? ['alipay'] : [] : channels } : null }
  mountAccountOverview(root as unknown as HTMLElement, view, from)
  return root.all()
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('套餐始终展示，购买按钮直接进入付款；没有申请步骤', () => {
  const nodes = render()
  expect(nodes.some((node) => node.tag === 'details')).toBe(false)
  expect(nodes.some((node) => node.textContent.includes('申请'))).toBe(false)
  const purchase = nodes.filter((node) => node.tag === 'button' && node.textContent === '购买')
  expect(purchase).toHaveLength(4)
  purchase[1].click(); expect(openPaymentDialog).toHaveBeenCalledWith(networkPlans[1], 'alipay')
})

it('存在旧待付款记录时，所有购买按钮仍新建本次付款', () => {
  const nodes = render('signed-in', pending)
  const purchase = nodes.filter((node) => node.textContent === '购买')
  expect(purchase).toHaveLength(4)
  purchase[0].click()
  purchase[1].click()
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

it('网络页始终付费套餐在前、体验流量在后，不混入邀请活动；未登录不捏造额度', () => {
  for (const state of ['signed-out', 'signed-in', 'unavailable'] as const) {
    const nodes = render(state)
    expect(nodes.filter((node) => node.tag === 'h4').map(node => node.textContent)).toEqual(['付费套餐', '体验流量 · 5 GB / 48 小时'])
    expect(nodes.filter((node) => node.className === 'account-usage-card')).toHaveLength(2)
    expect(nodes.some(node => node.textContent.includes('邀请'))).toBe(false)
    expect(nodes.filter((node) => node.tag === 'dt').map((node) => node.textContent)).toEqual(['总量', '已用', '剩余', '到期', '总量', '已用', '剩余', '到期'])
    expect(nodes.filter((node) => node.tag === 'dd').every((node) => node.textContent === '—')).toBe(true)
  }
})

it.each(['active', 'unknown', 'provisioning'] as const)('套餐 %s 时仍可购买新套餐', (state) => {
  const nodes = render('signed-in', { ...pending, state })
  const buttons = nodes.filter((node) => node.tag === 'button' && node.textContent === '购买')
  expect(buttons).toHaveLength(4); expect(buttons.every((button) => !button.disabled)).toBe(true)
  buttons[1].click()
  expect(openPaymentDialog).toHaveBeenCalledExactlyOnceWith(networkPlans[1], 'alipay')
})

it.each(['signed-out', 'signed-in', 'unavailable'] as const)('我的账号在 %s 状态也将付费套餐放在体验流量前', (state) => {
  const nodes = render(state, null, true, undefined, 'account')
  expect(nodes.filter(node => node.tag === 'h4').map(node => node.textContent)).toEqual(['付费套餐', '体验流量 · 5 GB / 48 小时'])
})

it('已付款权益在节点开通失败时明确显示已入账，不限制继续购买', () => {
  const nodes = render('signed-in', { ...pending, state: 'queued', startsAt: Date.now(), expiresAt: Date.now() + 86400_000 })
  expect(nodes.some((node) => node.textContent.includes('20 GB 月套餐 · 已付款·等待节点开通'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('已记入权益'))).toBe(true)
  expect(nodes.filter((node) => node.tag === 'button' && node.textContent === '购买')).toHaveLength(4)
})

it('付款渠道不可用时给出明确状态，不退回提交申请', () => {
  const nodes = render('signed-in', null, false)
  nodes.find(node => node.tag === 'button' && node.textContent === '购买')!.click()
  expect(nodes.some((node) => node.textContent.startsWith('付款暂时不可用'))).toBe(true)
  expect(openPaymentDialog).not.toHaveBeenCalled()
  expect(nodes.some((node) => node.textContent.includes('申请'))).toBe(false)
})

it('正常开通过的体验到期后不误报开通失败', () => {
  const nodes = render('signed-in', null, true, { available: false, retryable: false, usage: {
    ...pending, kind: 'trial', planId: 'trial-5g', totalBytes: 5 * 1024 ** 3, state: 'expired', expiresAt: 1_800_000_000_000, reasonCode: 'NETWORK_AUTHORIZATION_EXPIRED'
  } })
  expect(nodes.some((node) => node.textContent === '体验流量 · 已到期')).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('体验仍未开通成功'))).toBe(false)
  const trial = nodes.find(node => node.className === 'account-usage-card' && node.all().some(child => child.textContent === '体验流量 · 已到期'))!.all()
  expect(trial.filter((node) => node.tag === 'dd').map((node) => node.textContent).slice(0, 3)).toEqual(['5.00 GB', '—', '已到期'])
  expect(trial.some((node) => node.textContent.includes('暂时无法获取'))).toBe(false)
  expect(trial.some((node) => node.textContent.includes('剩余额度已失效'))).toBe(true)
})

it('到期仍带用量记录时不把旧剩余当作可用，也不伪造已用值', () => {
  const nodes = render('signed-in', null, true, { available: false, usage: {
    ...pending, kind: 'trial', totalBytes: 5 * 1024 ** 3, state: 'expired', measurement: 'current', usedBytes: 1024 ** 3, remainingBytes: 4 * 1024 ** 3
  } })
  const trial = nodes.find(node => node.className === 'account-usage-card' && node.all().some(child => child.textContent === '体验流量 · 已到期'))!.all()
  expect(trial.filter((node) => node.tag === 'dd').map((node) => node.textContent).slice(0, 3)).toEqual(['5.00 GB', '1.00 GB', '已到期'])
  expect(trial.some((node) => node.tag === 'meter')).toBe(false)
})

it('首页到期体验显示已到期且不画旧用量条，有效付费套餐照常显示实测用量', () => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const root = new Element('main')
  const view: AccountView = { state: 'signed-in', code: '', message: '', terms,
    account: { id: 'local-fixture', username: 'local-fixture' },
    overview: { trial: { available: false, usage: { ...pending, kind: 'trial', state: 'expired', measurement: 'current', usedBytes: 1024 ** 3, remainingBytes: 4 * 1024 ** 3 } },
      subscription: { ...pending, state: 'active', measurement: 'current', usedBytes: 1024 ** 3, remainingBytes: 19 * 1024 ** 3 },
      recoveryReady: true, plans: [...networkPlans], networkAvailable: true, paymentChannels: [] } }
  mountTrafficSummary(root as unknown as HTMLElement, view)
  const sections = root.all().filter(node => node.className === 'traffic-summary')
  expect(sections[0].all().filter(node => node.tag === 'strong').map(node => node.textContent)).toEqual(['已到期'])
  expect(sections[0].all().some(node => node.tag === 'meter')).toBe(false)
  expect(sections[1].all().some(node => node.textContent === '剩余 19.00 GB')).toBe(true)
  expect(sections[1].all().some(node => node.tag === 'meter')).toBe(true)
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

it('点击购买后保留多渠道选择，只有选择渠道才进入付款', () => {
  const nodes = render('signed-in', null, ['alipay', 'wechat'])
  nodes.filter(node => node.textContent === '购买')[1].click()
  expect(openPaymentDialog).not.toHaveBeenCalled()
  const actions = nodes.flatMap(node => node.all())
  expect(actions.some(node => node.textContent === '支付宝付款')).toBe(true)
  actions.find(node => node.textContent === '微信付款')!.click()
  expect(openPaymentDialog).toHaveBeenCalledWith(networkPlans[1], 'wechat')
})

it('未登录也保留领取体验按钮，点击只进入账号，不领取权益', () => {
  const nodes = render('signed-out')
  expect(requireAccount).not.toHaveBeenCalled()
  nodes.find(node => node.textContent === '领取 5 GB 体验流量')!.click()
  expect(requireAccount).toHaveBeenCalledWith('tunnel')
  expect(accountAction).not.toHaveBeenCalled()
})

it('账号读取失败保留购买入口，点击明确失败且不创建订单', () => {
  const nodes = render('unavailable')
  nodes.find(node => node.textContent === '购买')!.click()
  expect(nodes.some(node => node.textContent.includes('暂时无法确认账号状态'))).toBe(true)
  expect(openPaymentDialog).not.toHaveBeenCalled()
  expect(requireAccount).not.toHaveBeenCalled()
})
