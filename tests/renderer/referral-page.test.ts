import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms } from '../../app/account-types'
import { buildGroupCard, page } from '../../app/renderer/src/pages/referral'
import { bundledGroupQr, wecomGroupConfig } from '../../app/renderer/src/referral-config'
import { requireAccount } from '../../app/renderer/src/account-state'

const state = vi.hoisted(() => ({ view: null as unknown }))
vi.mock('../../app/renderer/src/account-state', () => ({
  accountSnapshot: () => state.view,
  onAccountChange: (listener: (view: unknown) => void) => { listener(state.view); return () => undefined },
  requireAccount: vi.fn(() => undefined)
}))

const terms: CommercialTerms = { plans: [], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' },
  trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3,
  invite: { bytes: 5 * 1024 ** 3, hours: 168, perMonth: 10 } }

class Element {
  textContent = ''; className = ''; type = ''; disabled = false; value = ''; hidden = false; src = ''; alt = ''
  children: Element[] = []; handlers = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

vi.stubGlobal('document', {
  createElement: (tag: string) => new Element(tag),
  createElementNS: (_ns: string, tag: string) => new Element(tag),
  body: new Element('body')
})

const guest: AccountView = { state: 'signed-out', code: '', message: '', terms, account: null, overview: null }

const signedInInvite = { code: 'AB12CD34', invitedBy: null as string | null,
  rewards: [{ id: 'lx-' + '4'.repeat(32), role: 'inviter' as const, bytes: 5 * 1024 ** 3,
    grantedAt: Date.parse('2026-09-15T10:00:00+08:00'), expiresAt: Date.parse('2026-09-22T10:00:00+08:00'),
    state: 'active' as const, remainingBytes: 4 * 1024 ** 3, usedBytes: 1 * 1024 ** 3 }] }

const signedIn = (invite: NonNullable<NonNullable<AccountView['overview']>['invite']> = signedInInvite): AccountView => ({
  state: 'signed-in', code: '', message: '', terms,
  account: { id: 'acct-' + '2'.repeat(32), username: 'local-host' },
  overview: { trial: { available: false, usage: null }, recoveryReady: true, subscription: null,
    plans: [], networkAvailable: true, paymentChannels: [], invite }
})

const renderPage = (view: AccountView): Element => {
  state.view = view
  const root = new Element('section')
  page.mount(root as unknown as HTMLElement, { tab: 'referral' })
  return root
}

afterEach(() => { vi.clearAllMocks() })

it('游客首屏同时看到邀请奖励与客户群两件事，规则三项与预览标注齐全', () => {
  const root = renderPage(guest)
  const nodes = root.all()
  const texts = nodes.map((node) => node.textContent)
  expect(texts.some((text) => text.includes('邀请好友，双方各得 5 GB'))).toBe(true)
  expect(texts.some((text) => text.includes('奖励有效期 7 天'))).toBe(true)
  expect(texts.some((text) => text.includes('仅限一级直接邀请'))).toBe(true)
  expect(texts.some((text) => text.includes('注册成功后到账'))).toBe(true)
  expect(texts.some((text) => text.includes('诚邀加入 AI 沟通群'))).toBe(true)
  expect(texts.some((text) => text.includes('AI 使用交流群'))).toBe(true)
  // 预览阶段的模拟邀请码必须带「本地预览」标注，不能被当成真实到账。
  expect(texts.some((text) => text.includes('PREVIEW'))).toBe(true)
  expect(nodes.filter((node) => node.textContent === '本地预览').length).toBeGreaterThan(0)
})

it('游客点复制动作被引导去登录，不读写私人邀请数据；登录后回到邀请页', () => {
  const root = renderPage(guest)
  const copy = root.all().find((node) => node.tag === 'button' && node.textContent === '复制邀请码')
  expect(copy).toBeDefined()
  copy!.click()
  expect(vi.mocked(requireAccount)).toHaveBeenCalledWith('referral')
  // 游客渲染不得出现私人记录内容，占位行明确写「登录后」。
  expect(root.all().map((node) => node.textContent).some((text) => text.includes('登录后即可生成你自己的邀请码'))).toBe(true)
})

it('登录后展示真实邀请码与奖励剩余，复制走剪贴板且不再显示模拟示例码', () => {
  const root = renderPage(signedIn({ code: 'AB12CD34', invitedBy: null, rewards: [] }))
  const nodes = root.all()
  expect(nodes.some((node) => node.textContent.includes('AB12CD34'))).toBe(true)
  expect(nodes.some((node) => node.textContent.includes('PREVIEW'))).toBe(false)
  const copy = nodes.find((node) => node.tag === 'button' && node.textContent === '复制邀请码')
  copy!.click()
  expect(vi.mocked(requireAccount)).not.toHaveBeenCalled()
})

it('登录后展示奖励的来源、剩余与到期', () => {
  const root = renderPage(signedIn())
  const texts = root.all().map((node) => node.textContent)
  expect(texts.some((text) => text === '邀请好友所得')).toBe(true)
  expect(texts.some((text) => text === '4.00 GB')).toBe(true)
  expect(texts.some((text) => text === '可用')).toBe(true)
})

it('企业微信官方群活码直接平铺在卡片上，游客无需登录即可扫码', () => {
  const root = renderPage(guest)
  const nodes = root.all()
  const texts = nodes.map((node) => node.textContent)
  const qrImage = nodes.find((node) => node.tag === 'img')
  expect(qrImage).toBeDefined()
  expect((qrImage as unknown as { alt?: string }).alt).toContain('AI 使用交流群')
  expect((qrImage as unknown as { src?: string }).src).toBe(wecomGroupConfig.qrImageSrc)
  expect(texts.some((text) => text.includes('群入口正在配置'))).toBe(false)
  expect(nodes.some((node) => node.tag === 'a')).toBe(false)
  expect(nodes.some((node) => node.tag === 'button' && node.textContent === '查看群二维码')).toBe(false)
  expect(nodes.some((node) => node.tag === 'dialog')).toBe(false)
})

it('官网群活码读取成功后显示线上码，图片读取失败仍回退到随包备用码', () => {
  const activeConfig = { ...wecomGroupConfig, ready: true, qrImageSrc: 'bundled-live-code.png' }
  const remote = buildGroupCard(activeConfig, {
    source: 'remote', imageUrl: 'https://laixin.net.cn/AI-tools/group-entry/qr/20260915T020000Z.png'
  }) as unknown as Element
  const image = remote.all().find((node) => node.tag === 'img')!
  expect(image.src).toContain('/group-entry/qr/')
  image.handlers.get('error')?.()
  const fallback = bundledGroupQr(activeConfig)
  expect(image.src).toBe(fallback.source === 'bundled' ? fallback.imageUrl : '')
})

it('线上群活码图片失效且没有随包备用码时，不留空白二维码位', () => {
  const remote = buildGroupCard({ ...wecomGroupConfig, qrImageSrc: undefined, ready: false }, {
    source: 'remote', imageUrl: 'https://laixin.net.cn/AI-tools/group-entry/qr/20260915T020000Z.png'
  }) as unknown as Element
  const image = remote.all().find((node) => node.tag === 'img')!
  image.handlers.get('error')?.()
  expect(image.hidden).toBe(true)
  expect(remote.all().some((node) => node.textContent.includes('群入口正在配置'))).toBe(true)
})

it('官网码和随包码都不可用时如实显示「群入口正在配置」', () => {
  const notReady = buildGroupCard({ ...wecomGroupConfig, qrImageSrc: undefined, ready: false }) as unknown as Element
  const nodes = notReady.all()
  const texts = nodes.map((node) => node.textContent)
  expect(texts.some((text) => text.includes('群入口正在配置'))).toBe(true)
  expect(texts.some((text) => text.includes('管理员正在配置企业微信官方群活码'))).toBe(true)
  expect(nodes.some((node) => node.tag === 'img')).toBe(false)
  expect(nodes.some((node) => node.tag === 'a')).toBe(false)
})

it('页面注册在邀请有礼标签下；账号不可用时如实说明且不显示模拟示例码', () => {
  expect(page.moduleId).toBe('referral.customer')
  expect(page.tab).toBe('referral')
  const unavailable = renderPage({ state: 'unavailable', code: '', message: '', terms, account: null, overview: null })
  const texts = unavailable.all().map((node) => node.textContent)
  expect(texts.some((text) => text.includes('邀请好友，双方各得 5 GB'))).toBe(true)
  expect(texts.some((text) => text.includes('暂时无法读取你的邀请信息'))).toBe(true)
  expect(texts.some((text) => text.includes('PREVIEW'))).toBe(false)
  expect(vi.mocked(requireAccount)).not.toHaveBeenCalled()
})
