import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms } from '../../app/account-types'
import { mountAccountOverview } from '../../app/renderer/src/ui/account-overview'
import { accountAction } from '../../app/renderer/src/account-state'

vi.mock('../../app/renderer/src/account-state', () => ({ accountAction: vi.fn(), requireAccount: vi.fn(), selectedNetworkPlan: () => undefined }))
vi.mock('../../app/renderer/src/ui/payment-dialog', () => ({ openPaymentDialog: vi.fn() }))

const terms: CommercialTerms = { plans: [], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' },
  trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3,
  invite: { bytes: 5 * 1024 ** 3, hours: 168, perMonth: 10 } }

class Element {
  textContent = ''; className = ''; type = ''; disabled = false; value = ''
  children: Element[] = []; handlers = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

const reward = (overrides: Partial<NonNullable<NonNullable<AccountView['overview']>['invite']>['rewards'][number]> = {}) => ({
  id: 'lx-' + '3'.repeat(32), role: 'inviter' as const, bytes: 5 * 1024 ** 3,
  grantedAt: Date.parse('2026-09-15T10:00:00+08:00'), expiresAt: Date.parse('2026-09-22T10:00:00+08:00'),
  state: 'active' as const, remainingBytes: 4 * 1024 ** 3, usedBytes: 1 * 1024 ** 3, ...overrides
})

function render(invite: NonNullable<AccountView['overview']>['invite']) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const root = new Element('main')
  const view: AccountView = { state: 'signed-in', code: '', message: '', terms,
    account: { id: 'acct-' + '1'.repeat(32), username: 'local-host' },
    overview: { trial: { available: false, usage: null }, recoveryReady: true, subscription: null,
      plans: [], networkAvailable: true, paymentChannels: [], ...(invite ? { invite } : {}) } }
  mountAccountOverview(root as unknown as HTMLElement, view, 'account')
  return root.all()
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('有邀请数据时展示邀请卡：邀请码、来源、奖励剩余与到期、规则边界，不展示未接入落地页的伪链接', () => {
  const nodes = render({ code: 'AB12CD34', invitedBy: null,
    link: 'https://laixin.test/AI-tools/?inv=AB12CD34', rewards: [reward()] } as unknown as NonNullable<AccountView['overview']>['invite'])
  expect(nodes.filter((node) => node.className === 'account-usage-card')).toHaveLength(3)
  expect(nodes.some((node) => node.textContent.includes('邀请有礼'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('AB12CD34'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('双方各得 5 GB'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('复制邀请码'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('复制邀请链接'))).toBe(false)
  expect(nodes.some((node) => node.textContent.includes('邀请好友所得'))).toBe(true)
  expect(nodes.some((node) => node.textContent === '剩余' && nodes.some((n) => n.textContent === '4.00 GB'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('绑定后不可更改'))).toBe(true)
})

it('被邀请人显示邀请来源；待开通奖励提供开通按钮并经账号动作开通', async () => {
  const nodes = render({ code: 'AB12CD34', invitedBy: 'old-friend', rewards: [reward({ role: 'invitee', state: 'pending', remainingBytes: null, usedBytes: null })] })
  expect(nodes.some((node) => node.textContent.includes('old-friend'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('好友邀请奖励'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('待开通'))).toBe(true)
  const button = nodes.find((node) => node.tag === 'button' && node.textContent === '开通奖励流量')
  expect(button).toBeDefined()
  button!.click()
  // 开通动作走统一的账号动作通道（accountAction），由桥接层调用 redeemInviteRewards。
  expect(vi.mocked(accountAction)).toHaveBeenCalledTimes(1)
})

it('没有邀请数据时不渲染第三张卡，两张权益卡保持原样', () => {
  const nodes = render(undefined)
  expect(nodes.filter((node) => node.className === 'account-usage-card')).toHaveLength(2)
  expect(nodes.some((node) => node.textContent.includes('邀请有礼'))).toBe(false)
})

it('到期奖励显示已到期且不出现开通按钮', () => {
  const nodes = render({ code: 'AB12CD34', invitedBy: null, rewards: [reward({ state: 'expired', remainingBytes: 0, usedBytes: null })] })
  expect(nodes.some((node) => node.textContent.includes('已到期'))).toBe(true)
  expect(nodes.some((node) => node.tag === 'button' && node.textContent === '开通奖励流量')).toBe(false)
})
