import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView } from '../../app/account-types'
import type { NetworkUsageView } from '../../app/shared/network-usage-types'
import { networkAllowance } from '../../app/renderer/src/pages/network-account'
import { networkPlans } from '../../app/network-plans'
import { requireAccount, refreshAccount } from '../../app/renderer/src/account-state'

const fixture = vi.hoisted(() => ({ view: { state: 'signed-out', code: '', message: '', account: null, overview: null } as AccountView }))
vi.mock('../../app/renderer/src/account-state', () => ({
  onAccountChange: (listener: (view: AccountView) => void) => { listener(fixture.view); return () => undefined },
  refreshAccount: vi.fn(), requireAccount: vi.fn(), accountAction: vi.fn(), selectedNetworkPlan: () => undefined
}))
vi.mock('../../app/renderer/src/ui/payment-dialog', () => ({ openPaymentDialog: vi.fn() }))
class Element {
  textContent = ''; className = ''; open = false; disabled = false; children: Element[] = []
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  querySelectorAll() { return this.all().filter(node => node.tag === 'details' && node.open) }
  private handlers: Record<string, () => void> = {}
  setAttribute() {}; addEventListener(event: string, call: () => void) { this.handlers[event] = call }
  click() { if (!this.disabled) this.handlers.click?.() }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
}
afterEach(() => {
  vi.unstubAllGlobals()
  fixture.view = { state: 'signed-out', code: '', message: '', account: null, overview: null }
  vi.clearAllMocks()
})
it('登录、未登录和读取失败展示相同流量模块及操作，不用登录卡替换内容', async () => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const { page } = await import('../../app/renderer/src/pages/network-account')
  const structures: string[][] = []
  for (const state of ['signed-out', 'signed-in', 'unavailable'] as const) {
    fixture.view = { ...signedIn([]), state, terms: { plans: [...networkPlans], toolbox: { id: 'toolbox', priceCents: 0, subject: '' },
      trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3 },
      overview: state === 'signed-in' ? { ...signedIn([]).overview!, trial: { available: true, usage: null }, paymentChannels: ['alipay'] } : null }
    const root = new Element('section'); page.mount(root as unknown as HTMLElement, { tab: 'tunnel' })
    const nodes = root.all()
    structures.push(nodes.filter(node => ['h3', 'h4', 'summary', 'button', 'dt'].includes(node.tag)).map(node => `${node.tag}:${node.textContent}`))
    expect(nodes.some(node => node.textContent === '当前可用')).toBe(true)
    expect(nodes.some(node => node.textContent === '登录后查看流量' || node.textContent === '登录 / 注册')).toBe(false)
    expect(nodes.some(node => node.tag === 'button' && node.textContent === '刷新流量')).toBe(true)
    expect(nodes.filter(node => node.className === 'account-plan')).toHaveLength(4)
    if (state !== 'signed-in') expect(nodes.some(node => node.textContent === '暂无数据')).toBe(true)
    page.unmount()
  }
  expect(structures[0]).toEqual(structures[1])
  expect(structures[2]).toEqual(structures[1])
  expect(page.order).toBeLessThan((await import('../../app/renderer/src/pages/network-diagnostics')).page.order)
  expect(requireAccount).not.toHaveBeenCalled()
})
it('未登录时保留刷新流量入口，点击才请求登录', async () => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const { page } = await import('../../app/renderer/src/pages/network-account')
  const root = new Element('section'); page.mount(root as unknown as HTMLElement, { tab: 'tunnel' })
  expect(requireAccount).not.toHaveBeenCalled()
  root.all().find(node => node.tag === 'button' && node.textContent === '刷新流量')!.click()
  expect(requireAccount).toHaveBeenCalledWith('tunnel')
  expect(refreshAccount).toHaveBeenCalledTimes(1)
  page.unmount()
})

const usage: NetworkUsageView = { authorizationId: 'local', planId: '20g', kind: 'subscription', state: 'active',
  measurement: 'current', totalBytes: 20 * 1024 ** 3, usedBytes: 18 * 1024 ** 3, remainingBytes: 2 * 1024 ** 3,
  expiresAt: 1_800_000_000_000, observedAt: 1_799_000_000_000, reasonCode: '' }
function signedIn(items: NetworkUsageView[]): AccountView {
  return { state: 'signed-in', code: '', message: '', account: { id: 'local', username: 'local' }, overview: {
    networkAvailable: true, trial: { available: false, usage: null }, subscription: items[0] ?? null, subscriptions: items,
    recoveryReady: true, plans: [], paymentChannels: []
  } }
}
it('用量未知时提供可见重试入口，明细保持折叠', async () => {
  fixture.view = signedIn([{ ...usage, measurement: 'unavailable' }])
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const { page } = await import('../../app/renderer/src/pages/network-account')
  const root = new Element('section'); page.mount(root as unknown as HTMLElement, { tab: 'tunnel' })
  expect(root.all().some(node => node.textContent === '暂时无法确认')).toBe(true)
  expect(root.all().some(node => node.tag === 'button' && node.textContent === '刷新流量')).toBe(true)
  expect(root.all().filter(node => node.tag === 'details').every(node => !node.open)).toBe(true)
  page.unmount()
})
it('汇总每份有效流量一次，显示最近到期而不是把有效期合并', () => {
  const view = signedIn([usage, { ...usage, authorizationId: 'local2', expiresAt: usage.expiresAt! + 86400_000 }])
  view.overview!.trial.usage = { ...usage, kind: 'trial', state: 'expired' }
  const summary = networkAllowance(view)
  expect(summary.remaining).toBe('4.00 GB')
  expect(summary.expiry).toContain(new Date(usage.expiresAt!).toLocaleString('zh-CN'))
  expect(summary.expiry).toContain('各份流量独立到期')
})
it.each([
  { measurement: 'unavailable' as const }, { state: 'unknown' as const }, { remainingBytes: null }, { remainingBytes: -1 }
])('任何一份用量未知都不展示虚假总额度：%j', invalid => {
  expect(networkAllowance(signedIn([usage, { ...usage, ...invalid }])).remaining).toBe('暂时无法确认')
})
it('正在开通不计入可用额度；明确耗尽显示零', () => {
  expect(networkAllowance(signedIn([{ ...usage, state: 'provisioning', remainingBytes: null }]))).toEqual({
    remaining: '0.00 GB', expiry: '有流量正在开通，完成后计入可用额度。'
  })
  expect(networkAllowance(signedIn([{ ...usage, state: 'exhausted' }])).remaining).toBe('0.00 GB')
})
it('有效邀请奖励计入流量，奖励用量未知不以旧值替代', () => {
  const view = signedIn([usage])
  view.overview!.invite = { code: null, invitedBy: null, rewards: [{ id: 'local', role: 'invitee', state: 'active',
    bytes: 1024 ** 3, remainingBytes: 1024 ** 3, usedBytes: 0, grantedAt: 1, expiresAt: usage.expiresAt! }] }
  expect(networkAllowance(view).remaining).toBe('3.00 GB')
  view.overview!.invite.rewards[0].remainingBytes = null
  expect(networkAllowance(view).remaining).toBe('暂时无法确认')
  view.overview!.networkAvailable = false
  expect(networkAllowance(view).remaining).toBe('暂时无法确认')
})
