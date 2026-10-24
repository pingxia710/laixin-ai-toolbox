import { afterEach, expect, it, vi } from 'vitest'
import type { SharingIntentionStatus, SharingListing, SharingStatus } from '../../app/sharing-types'
import { sharingStandardProducts } from '../../app/sharing-products'

const mocks = vi.hoisted(() => ({
  account: { view: { state: 'signed-in', account: { id: 'local-fixture', username: 'local-fixture' } } },
  requireAccount: vi.fn(), markServiceAvailability: vi.fn(), revealSupport: vi.fn()
}))
vi.mock('../../app/renderer/src/account-state', () => ({
  accountSnapshot: () => mocks.account.view,
  onAccountChange: (listener: (view: unknown) => void) => { listener(mocks.account.view); return () => undefined },
  requireAccount: mocks.requireAccount
}))
vi.mock('../../app/renderer/src/navigation', () => ({ markServiceAvailability: mocks.markServiceAvailability }))
vi.mock('../../app/renderer/src/support-widget', () => ({ revealSupport: mocks.revealSupport }))

class TextNode {
  parent: Element | null = null
  readonly children: never[] = []
  constructor(readonly textContent: string) {}
  all(): TextNode[] { return [this] }
  text(): string { return this.textContent }
}
class Element {
  textContent = ''; type = ''; disabled = false; value = ''; checked = false; required = false; readOnly = false; rows = 0; name = ''; placeholder = ''; maxLength = -1
  onclick: (() => void) | null = null
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null
  readonly children: (Element | TextNode)[] = []
  readonly dataset: Record<string, string> = {}
  parent: Element | null = null
  private classes = new Set<string>()
  get className() { return [...this.classes].join(' ') }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  readonly classList = {
    add: (name: string) => { this.classes.add(name) },
    remove: (name: string) => { this.classes.delete(name) },
    contains: (name: string) => this.classes.has(name)
  }
  append(...nodes: (Element | TextNode)[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes: (Element | TextNode)[]) { this.children.splice(0, this.children.length); for (const node of nodes) { node.parent = this; this.children.push(node) } }
  setAttribute() { /* 文案断言不依赖属性 */ }
  removeAttribute() { /* 文案断言不依赖属性 */ }
  addEventListener() { /* 视图按钮走 onclick 属性 */ }
  click() { if (!this.disabled) this.onclick?.() }
  submit() { this.onsubmit?.({ preventDefault: () => undefined }) }
  all(): (Element | TextNode)[] { return [this, ...this.children.flatMap((child) => child.all())] }
  button(label: string): Element | undefined {
    return this.all().find((node): node is Element => node instanceof Element && node.tag === 'button' && node.textContent === label)
  }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(' ') }
  constructor(readonly tag: string) {}
}

const listing: SharingListing = { id: 'lst-fixture-1', software: 'codex', name: 'ChatGPT Plus 闲置共享', description: '工作日白天闲置的套餐',
  priceCents: 1999, serviceFeeCents: 200, term: '7 天', termDays: 7, deliveryHours: 24,
  usageTerms: '不得修改密码与绑定信息', cancellationTerms: '未交付可全额退款', enabled: true }

function stubSharingApi(overrides: Record<string, unknown> = {}) {
  return {
    catalog: vi.fn(async () => ({ data: JSON.stringify({ listings: [listing], channels: ['wechat', 'manual'] }), error: '' })),
    standards: vi.fn(async () => ({ data: JSON.stringify({ products: sharingStandardProducts }), error: '' })),
    posts: vi.fn(async () => ({ data: JSON.stringify({ posts: [] }), error: '' })),
    myPosts: vi.fn(async () => ({ data: JSON.stringify({ posts: [] }), error: '' })), publish: vi.fn(), closePost: vi.fn(),
    list: vi.fn(async () => ({ data: JSON.stringify({ orders: [], nextCursor: '' }), error: '' })),
    create: vi.fn(), detail: vi.fn(), pay: vi.fn(), reveal: vi.fn(), complete: vi.fn(), cancel: vi.fn(), report: vi.fn(),
    intentions: vi.fn(async () => ({ data: JSON.stringify({ intentions: [] }), error: '' })),
    share: vi.fn(),
    ...overrides
  }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function mountView(api: Record<string, unknown>) {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => new TextNode(text),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  vi.stubGlobal('window', { toolbox: { sharing: api }, addEventListener: () => undefined, removeEventListener: () => undefined })
  const { mountSharing } = await import('../../app/renderer/src/sharing/view')
  const root = new Element('main')
  const dispose = mountSharing(root as unknown as HTMLElement)
  await flush()
  return { root, dispose }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

it('租单状态文案覆盖全部 SharingStatus', async () => {
  const { statusLabels } = await import('../../app/renderer/src/sharing/view')
  const statuses: SharingStatus[] = ['pending_payment', 'queued', 'processing', 'ready', 'active', 'expired', 'problem', 'cancel_requested', 'refund_pending', 'refunded', 'cancelled']
  expect(Object.keys(statusLabels).sort()).toEqual([...statuses].sort())
  for (const status of statuses) expect(statusLabels[status].length).toBeGreaterThan(0)
  expect(statusLabels.pending_payment).toBe('等待付款')
  expect(statusLabels.active).toBe('租用中')
  expect(statusLabels.expired).toBe('租期已满 · 已收回')
})

it('分享登记状态文案覆盖全部 SharingIntentionStatus', async () => {
  const { intentionStatusLabels } = await import('../../app/renderer/src/sharing/view')
  const statuses: SharingIntentionStatus[] = ['pending', 'contacted', 'listed', 'closed']
  expect(Object.keys(intentionStatusLabels).sort()).toEqual([...statuses].sort())
  expect(intentionStatusLabels.pending).toBe('待客服对接')
  expect(intentionStatusLabels.listed).toBe('已上架出租')
})

it('市场页用用户语言：信任条与直租、市场分组；系统语言退出页面', async () => {
  const api = stubSharingApi()
  const { root, dispose } = await mountView(api)
  const text = root.text()
  expect(text).toContain('账号与 API 租用')
  expect(text).toContain('来信人工办理交接')
  expect(text).toContain('来信直租')
  expect(text).toContain('下单即办理')
  expect(text).toContain('市场发布')
  expect(text).toContain('客服对接成交')
  expect(text).toContain('人工核对交付')
  expect(text).not.toContain('供需大厅')
  expect(text).not.toContain('标准模板')
  expect(text).not.toContain('三种标准产品')
  expect(text).not.toContain('找服务，或发布一份服务')
  dispose()
})

it('下单确认页保留租约、交付、使用约定、取消说明与风险提示', async () => {
  const api = stubSharingApi()
  const { root, dispose } = await mountView(api)
  root.button('查看并下单')!.click()
  await flush()
  const checkout = root.text()
  expect(checkout).toContain('总价已含账号分享服务费 ¥2.00，网络费用另计。')
  expect(checkout).toContain('交付：付款后 24 小时内人工办理交接。')
  expect(checkout).toContain('使用约定：不得修改密码与绑定信息')
  expect(checkout).toContain('取消与退款：未交付可全额退款')
  expect(checkout).toContain('我已阅读租约、交付、使用约定及取消说明。')
  expect(checkout).toContain('共享账号可能违反部分厂商的服务条款')
  dispose()
})
