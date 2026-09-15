import { afterEach, expect, it, vi } from 'vitest'
import type { SharingListing, SharingPostView } from '../../app/sharing-types'
import type { SharingPublishInput } from '../../app/preload/api/sharing'
import { sharingStandardProducts } from '../../app/sharing-products'

const mocks = vi.hoisted(() => ({
  account: { view: { state: 'signed-in' as string, account: { id: 'local-fixture', username: 'local-fixture' } as { id: string; username: string } | null } },
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
  textContent = ''; type = ''; disabled = false; value = ''; checked = false; required = false; readOnly = false; rows = 0; name = ''; placeholder = ''; maxLength = -1; tabIndex = 0
  onclick: (() => void) | null = null
  onchange: (() => void) | null = null
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null
  onkeydown: ((event: { key: string; preventDefault(): void }) => void) | null = null
  readonly children: (Element | TextNode)[] = []
  readonly dataset: Record<string, string> = {}
  parent: Element | null = null
  private classes = new Set<string>()
  get className() { return [...this.classes].join(' ') }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  readonly classList = { add: (name: string) => { this.classes.add(name) }, remove: (name: string) => { this.classes.delete(name) }, contains: (name: string) => this.classes.has(name) }
  append(...nodes: (Element | TextNode)[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes: (Element | TextNode)[]) { this.children.splice(0, this.children.length); for (const node of nodes) { node.parent = this; this.children.push(node) } }
  setAttribute() { /* 结构断言不依赖属性 */ }
  removeAttribute() { /* 结构断言不依赖属性 */ }
  addEventListener() { /* 视图按钮走 onclick 属性 */ }
  click() { if (!this.disabled) this.onclick?.() }
  change() { this.onchange?.() }
  submit() { this.onsubmit?.({ preventDefault: () => undefined }) }
  focus() { /* 键盘焦点不在本测试范围 */ }
  querySelector(): Element | null { return null }
  all(): (Element | TextNode)[] { return [this, ...this.children.flatMap((child) => child.all())] }
  button(label: string): Element | undefined { return this.all().find((node): node is Element => node instanceof Element && node.tag === 'button' && node.textContent === label) }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(' ') }
  constructor(readonly tag: string) {}
}

const listing: SharingListing = { id: 'lst-fixture-1', software: 'codex', name: 'ChatGPT Plus 闲置共享', description: '工作日白天闲置的套餐',
  priceCents: 1999, serviceFeeCents: 200, term: '7 天', termDays: 7, deliveryHours: 24,
  usageTerms: '不得修改密码与绑定信息', cancellationTerms: '未交付可全额退款', enabled: true }

function stubApi(initial: SharingPostView[] = []) {
  let saved = [...initial]
  const ok = (data: unknown) => Promise.resolve({ data: JSON.stringify(data), error: '' })
  return {
    catalog: vi.fn(() => ok({ listings: [listing], channels: ['wechat', 'manual'] })),
    standards: vi.fn(() => ok({ products: sharingStandardProducts })),
    posts: vi.fn(() => ok({ posts: saved.filter((post) => post.status === 'published') })), myPosts: vi.fn(() => ok({ posts: saved })),
    publish: vi.fn((input: SharingPublishInput) => {
      const post: SharingPostView = { id: `sp-${'b'.repeat(32)}`, side: input.side as SharingPostView['side'], productId: input.productId as SharingPostView['productId'],
        software: input.software as SharingPostView['software'], accountPlan: input.accountPlan || null, apiProvider: input.apiProvider || null,
        apiModel: input.apiModel || null, termDays: Number(input.termDays), quotaAmount: input.quotaAmount ? Number(input.quotaAmount) : null,
        quotaUnit: input.quotaUnit as SharingPostView['quotaUnit'] || null, usageTier: input.usageTier as SharingPostView['usageTier'] || null,
        priceCents: Number(input.priceCents), availableCount: input.availableCount ? Number(input.availableCount) : null,
        deliveryHours: input.deliveryHours ? Number(input.deliveryHours) : null, status: 'published', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
      saved = [post, ...saved]; return ok(post)
    }),
    closePost: vi.fn(({ postId }: { postId: string }) => { saved = saved.map((post) => post.id === postId ? { ...post, status: 'closed' as const } : post); return ok(saved.find((post) => post.id === postId)) }),
    list: vi.fn(() => ok({ orders: [], nextCursor: '' })), create: vi.fn(), detail: vi.fn(), pay: vi.fn(), reveal: vi.fn(), complete: vi.fn(), cancel: vi.fn(), report: vi.fn(),
    intentions: vi.fn(() => ok({ intentions: [] })), share: vi.fn()
  }
}

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
function stubDom(api: ReturnType<typeof stubApi>) {
  const documentListeners = new Map<string, Set<() => void>>(); const windowListeners = new Map<string, Set<() => void>>()
  const track = (map: Map<string, Set<() => void>>) => ({
    addEventListener: (event: string, handler: () => void) => { const set = map.get(event) ?? new Set<() => void>(); set.add(handler); map.set(event, set) },
    removeEventListener: (event: string, handler: () => void) => { map.get(event)?.delete(handler) }
  })
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new TextNode(text),
    createElementNS: (_ns: string, tag: string) => new Element(tag), visibilityState: 'visible', ...track(documentListeners) })
  vi.stubGlobal('window', { toolbox: { sharing: api }, ...track(windowListeners) }); return { documentListeners, windowListeners }
}
async function mountView(api: ReturnType<typeof stubApi>) {
  const dom = stubDom(api); const { mountSharing } = await import('../../app/renderer/src/sharing/view'); const root = new Element('main')
  const dispose = mountSharing(root as unknown as HTMLElement); await flush(); return { root, dispose, ...dom }
}
const field = (root: Element, name: string): Element | undefined => root.all().find((node): node is Element => node instanceof Element && node.name === name)
const form = (root: Element): Element => root.all().find((node): node is Element => node instanceof Element && node.tag === 'form')!

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); mocks.account.view = { state: 'signed-in', account: { id: 'local-fixture', username: 'local-fixture' } } })

it('展示两类产品、API 两种模式和五个功能入口', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); const text = root.text()
  expect(text).toContain('账号租用和 API 租用'); expect(text).toContain('额度包、周期包'); expect(text).toContain('自己的价格')
  for (const label of ['账号租用', '供需大厅', '发布', '我的发布', '我的租单']) expect(root.button(label), label).toBeDefined()
  expect(root.button('查看账号租用')).toBeDefined(); expect(mocks.markServiceAvailability).toHaveBeenCalledWith('sharing', false); dispose()
})

it('未登录可以查看完整发布模板，提交发布或查看本人记录时才要求登录', async () => {
  mocks.account.view = { state: 'signed-out', account: null }; const api = stubApi(); const { root, dispose } = await mountView(api)
  root.button('发布')!.click(); await flush()
  expect(root.text()).toContain('发布标准需求或供给'); expect(field(root, 'productId')).toBeDefined()
  expect(mocks.requireAccount).not.toHaveBeenCalled()
  field(root, 'price')!.value = '19.90'; form(root).submit(); await flush()
  expect(mocks.requireAccount).toHaveBeenCalledWith('sharing'); expect(api.publish).not.toHaveBeenCalled()
  vi.mocked(mocks.requireAccount).mockClear(); root.button('我的发布')!.click(); await flush()
  expect(root.text()).toContain('登录后显示你的记录'); expect(mocks.requireAccount).not.toHaveBeenCalled(); expect(api.myPosts).not.toHaveBeenCalled()
  root.button('我的租单')!.click(); await flush()
  expect(root.text()).toContain('登录后显示你的租单'); expect(api.list).not.toHaveBeenCalled(); dispose()
})

it('需求者按账号模板发布愿付价格', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  field(root, 'price')!.value = '19.90'; form(root).submit(); await flush()
  expect(api.publish).toHaveBeenCalledTimes(1); expect(api.publish.mock.calls[0]![0]).toMatchObject({ side: 'demand', productId: 'account-rental', accountPlan: 'chatgpt-plus', priceCents: '1990', availableCount: '', deliveryHours: '' })
  expect(root.text()).toContain('需求发布成功'); expect(root.text()).toContain('愿付价格 ¥19.90'); dispose()
})

it('供给者也填写报价，并补充可提供数量与交付时效', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  field(root, 'side')!.value = 'supply'; field(root, 'side')!.change(); await flush()
  field(root, 'price')!.value = '25.99'; field(root, 'availableCount')!.value = '2'; form(root).submit(); await flush()
  expect(api.publish.mock.calls[0]![0]).toMatchObject({ side: 'supply', productId: 'account-rental', priceCents: '2599', availableCount: '2', deliveryHours: '1' })
  expect(root.text()).toContain('供给报价 ¥25.99'); expect(root.text()).toContain('可提供 2 份'); dispose()
})

it('API 额度包和周期包显示各自的标准字段', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  field(root, 'productId')!.value = 'api-quota'; field(root, 'productId')!.change(); await flush()
  expect(field(root, 'apiProvider')).toBeDefined(); expect(field(root, 'apiModel')).toBeDefined(); expect(field(root, 'quotaAmount')).toBeDefined(); expect(field(root, 'quotaUnit')).toBeDefined(); expect(field(root, 'usageTier')).toBeUndefined()
  field(root, 'productId')!.value = 'api-period'; field(root, 'productId')!.change(); await flush()
  expect(field(root, 'usageTier')).toBeDefined(); expect(field(root, 'quotaAmount')).toBeUndefined(); dispose()
})

it('本人可以关闭发布，关闭后大厅隐藏并保留历史', async () => {
  const post: SharingPostView = { id: `sp-${'c'.repeat(32)}`, side: 'supply', productId: 'account-rental', software: 'codex', accountPlan: 'chatgpt-plus',
    apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 2599,
    availableCount: 1, deliveryHours: 6, status: 'published', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
  const api = stubApi([post]); const { root, dispose } = await mountView(api); root.button('我的发布')!.click(); await flush(); root.button('关闭发布')!.click(); await flush()
  expect(api.closePost).toHaveBeenCalledWith({ postId: post.id }); expect(root.text()).toContain('已关闭'); expect(root.button('关闭发布')).toBeUndefined()
  root.button('供需大厅')!.click(); await flush(); expect(root.text()).toContain('当前还没有发布中的需求或供给'); dispose()
})

it('卸载时移除监听器并清空页面', async () => {
  const api = stubApi(); const { root, dispose, documentListeners, windowListeners } = await mountView(api)
  expect(documentListeners.get('visibilitychange')?.size).toBe(1); expect(windowListeners.get('blur')?.size).toBe(1); dispose()
  expect(documentListeners.get('visibilitychange')?.size ?? 0).toBe(0); expect(windowListeners.get('blur')?.size ?? 0).toBe(0); expect(root.children).toHaveLength(0)
})
