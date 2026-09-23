import { afterEach, expect, it, vi } from 'vitest'
import type { SharingListing, SharingMyResponseView, SharingPostView } from '../../app/sharing-types'
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

const codexDemand: SharingPostView = { id: `sp-${'a'.repeat(32)}`, side: 'demand', productId: 'account-rental', software: 'codex', accountPlan: 'chatgpt-plus',
  apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 1990,
  availableCount: null, deliveryHours: null, status: 'published', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
const claudeSupply: SharingPostView = { id: `sp-${'c'.repeat(32)}`, side: 'supply', productId: 'api-quota', software: 'claude', accountPlan: null,
  apiProvider: 'zhipu', apiModel: 'glm-5.3-flash', termDays: 30, quotaAmount: 10, quotaUnit: 'million-tokens', usageTier: null, priceCents: 2999,
  availableCount: 2, deliveryHours: 6, status: 'published', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
const codexSupply: SharingPostView = { id: `sp-${'e'.repeat(32)}`, side: 'supply', productId: 'account-rental', software: 'codex', accountPlan: 'chatgpt-plus',
  apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 2500,
  availableCount: 2, deliveryHours: 6, status: 'published', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
const candidate = { responseId: `sr-${'9'.repeat(32)}`, productId: 'account-rental' as const, software: 'codex' as const, accountPlan: 'chatgpt-plus',
  apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 2500, availableCount: 2, deliveryHours: 6,
  respondedAt: 1_800_000_000_000, status: 'presented' as const }

function stubApi(initial: SharingPostView[] = [], catalogListings: SharingListing[] = [listing], responses: SharingMyResponseView[] = []) {
  let saved = [...initial]
  const ok = (data: unknown) => Promise.resolve({ data: JSON.stringify(data), error: '' })
  return {
    catalog: vi.fn(() => ok({ listings: catalogListings, channels: ['wechat', 'manual'] })),
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
    respond: vi.fn((input: { demandPostId: string; supplyPostId: string }) => ok({ id: `sr-${'d'.repeat(32)}`, demandPostId: input.demandPostId, supplyPostId: input.supplyPostId, status: 'responded', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 })),
    myResponses: vi.fn(() => ok({ responses: responses })),
    demandResponses: vi.fn(({ demandPostId }: { demandPostId: string }) => ok({ candidates: demandPostId === `sp-${'a'.repeat(32)}` ? [candidate] : [] })),
    selectResponse: vi.fn((input: { responseId: string }) => ok({ id: input.responseId, demandPostId: `sp-${'a'.repeat(32)}`, supplyPostId: `sp-${'c'.repeat(32)}`, status: 'selected', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 })),
    confirmResponse: vi.fn((input: { responseId: string }) => ok({ id: `lx-${'f'.repeat(32)}`, listing: { id: `share-m${input.responseId.slice(3, 34)}`, software: 'codex', name: '账号租用 · 市场成交', description: '市场成交', priceCents: 2500, serviceFeeCents: 0, term: '7 天', termDays: 7, deliveryHours: 6, usageTerms: '市场成交', cancellationTerms: '客服办理', enabled: true }, status: 'pending_payment', channel: 'manual', createdAt: 1_800_000_000_000, paidAt: null, dueAt: null, updatedAt: 1_800_000_000_000, issue: null, deliveredAt: null, startsAt: null, expiresAt: null, revealedAt: null, refundAt: null, paymentId: null, events: [{ at: 1_800_000_000_000, status: 'pending_payment' }] })),
    declineResponse: vi.fn((input: { responseId: string }) => ok({ id: input.responseId, demandPostId: `sp-${'a'.repeat(32)}`, supplyPostId: `sp-${'c'.repeat(32)}`, status: 'declined', createdAt: 1, updatedAt: 1 })),
    withdrawResponse: vi.fn((input: { responseId: string }) => ok({ id: input.responseId, demandPostId: `sp-${'a'.repeat(32)}`, supplyPostId: `sp-${'c'.repeat(32)}`, status: 'withdrawn', createdAt: 1, updatedAt: 1 })),
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

it('默认落地租用市场：信任条、直租档位置顶、市场组与兜底带，三入口导航', async () => {
  const api = stubApi([codexDemand]); const { root, dispose } = await mountView(api); const text = root.text()
  expect(text).toContain('账号与 API 租用')
  for (const label of ['人工核对交付', '到期收回换密', '交付资料仅本人可见', '售后走客服']) expect(text).toContain(label)
  for (const label of ['租用市场', '发布', '我的']) expect(root.button(label), label).toBeDefined()
  expect(text).toContain('来信直租'); expect(text).toContain('下单即办理')
  expect(text).toContain('市场发布'); expect(text).toContain('客服对接成交')
  expect(root.button('查看并下单'), '直租档位卡 CTA').toBeDefined()
  expect(text).toContain('没找到合适的'); expect(root.button('发布需求')).toBeDefined(); expect(root.button('发布供给')).toBeDefined()
  expect(text).not.toContain('直接租用与供需大厅是两条入口')
  expect(mocks.markServiceAvailability).toHaveBeenCalledWith('sharing', false); dispose()
})

it('软件切换器同时过滤直租档位与市场发布', async () => {
  const api = stubApi([codexDemand, claudeSupply]); const { root, dispose } = await mountView(api)
  expect(root.text()).toContain('愿付 ¥19.90'); expect(root.text()).not.toContain('报价 ¥29.99')
  root.button('Claude Code')!.click(); await flush()
  expect(root.text()).toContain('报价 ¥29.99'); expect(root.text()).not.toContain('愿付 ¥19.90')
  dispose()
})

it('直租与市场空态都有下一步动作，不再出现裸空文案', async () => {
  const api = stubApi([], []); const { root, dispose } = await mountView(api); const text = root.text()
  expect(text).toContain('暂无直租档位'); expect(root.button('发布需求')).toBeDefined()
  expect(text).toContain('暂无市场发布')
  expect(text).not.toContain('当前还没有发布中的需求或供给'); dispose()
})

it('需求卡可回应：有匹配供给直接回应，无则预填供给发布并在发布后自动回应', async () => {
  const api = stubApi([codexDemand]); const { root, dispose } = await mountView(api)
  root.button('回应这个需求')!.click(); await flush()
  expect(field(root, 'price')).toBeDefined()
  expect(root.button('我要出')!.classList.contains('is-active')).toBe(true)
  field(root, 'price')!.value = '25'; field(root, 'availableCount')!.value = '2'; form(root).submit(); await flush()
  expect(api.publish).toHaveBeenCalledTimes(1)
  expect(api.publish.mock.calls[0]![0]).toMatchObject({ side: 'supply', productId: 'account-rental', software: 'codex' })
  expect(api.respond).toHaveBeenCalledTimes(1)
  expect((api.respond.mock.calls[0]![0] as { demandPostId: string }).demandPostId).toBe(codexDemand.id)
  expect(root.text()).toContain('回应已提交'); dispose()
})

it('已回应的需求卡显示等待核查；访客只见联系客服且无回应按钮', async () => {
  const responded: SharingMyResponseView = { id: `sr-${'d'.repeat(32)}`, demandPostId: codexDemand.id, supplyPostId: codexSupply.id, status: 'responded', createdAt: 1, updatedAt: 1,
    demand: { postId: codexDemand.id, productId: 'account-rental', software: 'codex', accountPlan: 'chatgpt-plus', apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 1990, status: 'published' } }
  const api = stubApi([codexDemand], [listing], [responded]); const { root, dispose } = await mountView(api); await flush()
  expect(root.text()).toContain('已回应 · 等待客服核查'); expect(root.button('回应这个需求')).toBeUndefined(); dispose()
  mocks.account.view = { state: 'signed-out', account: null }
  const api2 = stubApi([codexDemand]); const view2 = await mountView(api2)
  expect(view2.root.button('有疑问？联系客服')).toBeDefined(); expect(view2.root.button('回应这个需求')).toBeUndefined()
  view2.dispose()
})

it('我的发布需求卡展开候选并选择报价；候选不含对方身份', async () => {
  const api = stubApi([codexDemand]); const { root, dispose } = await mountView(api)
  root.button('我的')!.click(); await flush()
  root.button('查看回应')!.click(); await flush()
  expect(root.text()).toContain('回应候选'); expect(root.text()).toContain('报价 ¥25.00')
  expect(root.text()).not.toContain('acct_')
  root.button('选择这个报价')!.click(); await flush()
  expect(api.selectResponse).toHaveBeenCalledTimes(1)
  expect((api.selectResponse.mock.calls[0]![0] as { responseId: string }).responseId).toBe(candidate.responseId)
  expect(root.text()).toContain('等待对方确认'); dispose()
})

it('供给卡被选中时可确认成交或声明没货', async () => {
  const selected: SharingMyResponseView = { id: candidate.responseId, demandPostId: codexDemand.id, supplyPostId: codexSupply.id, status: 'selected', createdAt: 1, updatedAt: 1,
    demand: { postId: codexDemand.id, productId: 'account-rental', software: 'codex', accountPlan: 'chatgpt-plus', apiProvider: null, apiModel: null, termDays: 7, quotaAmount: null, quotaUnit: null, usageTier: null, priceCents: 1990, status: 'published' } }
  const api = stubApi([codexSupply], [listing], [selected]); const { root, dispose } = await mountView(api); await flush()
  root.button('我的')!.click(); await flush()
  expect(root.text()).toContain('需求方已选中 · 待你确认')
  root.button('确认成交，为对方生成租单')!.click(); await flush()
  expect(api.confirmResponse).toHaveBeenCalledTimes(1)
  expect(root.text()).toContain('已确认成交，已为对方生成租单')
  dispose()
})

it('未登录可以浏览市场与发布模板，提交发布或查看本人记录时才要求登录', async () => {
  mocks.account.view = { state: 'signed-out', account: null }; const api = stubApi([codexDemand]); const { root, dispose } = await mountView(api)
  expect(root.button('查看并下单')).toBeDefined(); expect(root.text()).toContain('愿付 ¥19.90')
  root.button('发布')!.click(); await flush()
  expect(root.text()).toContain('发布后会发生什么'); expect(field(root, 'price')).toBeDefined()
  expect(mocks.requireAccount).not.toHaveBeenCalled()
  field(root, 'price')!.value = '19.90'; form(root).submit(); await flush()
  expect(mocks.requireAccount).toHaveBeenCalledWith('sharing'); expect(api.publish).not.toHaveBeenCalled()
  vi.mocked(mocks.requireAccount).mockClear(); root.button('我的')!.click(); await flush()
  expect(root.text()).toContain('登录后显示你的租单'); expect(root.text()).toContain('登录后显示你的记录')
  expect(mocks.requireAccount).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled(); expect(api.myPosts).not.toHaveBeenCalled(); dispose()
})

it('需求者按账号模板发布愿付价格，成功后落到我的发布', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  field(root, 'price')!.value = '19.90'; form(root).submit(); await flush()
  expect(api.publish).toHaveBeenCalledTimes(1); expect(api.publish.mock.calls[0]![0]).toMatchObject({ side: 'demand', productId: 'account-rental', accountPlan: 'chatgpt-plus', priceCents: '1990', availableCount: '', deliveryHours: '' })
  expect(root.text()).toContain('需求发布成功'); expect(root.text()).toContain('已发布 · 等待客服对接'); expect(root.text()).toContain('愿付 ¥19.90'); dispose()
})

it('供给者通过「我要出」发布报价，并补充可提供数量与交付时效', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  root.button('我要出')!.click(); await flush()
  expect(root.button('我要出')!.classList.contains('is-active')).toBe(true)
  expect(field(root, 'availableCount')).toBeDefined(); expect(field(root, 'deliveryHours')).toBeDefined()
  field(root, 'price')!.value = '25.99'; field(root, 'availableCount')!.value = '2'; form(root).submit(); await flush()
  expect(api.publish.mock.calls[0]![0]).toMatchObject({ side: 'supply', productId: 'account-rental', priceCents: '2599', availableCount: '2', deliveryHours: '1' })
  expect(root.text()).toContain('供给发布成功'); expect(root.text()).toContain('报价 ¥25.99'); expect(root.text()).toContain('可提供 2 份'); dispose()
})

it('三张模板卡用用户语言并在切换时显示各自标准字段', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush()
  for (const label of ['租账号', '租 API 额度', '包月 API']) expect(root.button(label), label).toBeDefined()
  root.button('租 API 额度')!.click(); await flush()
  expect(field(root, 'apiProvider')).toBeDefined(); expect(field(root, 'apiModel')).toBeDefined(); expect(field(root, 'quotaAmount')).toBeDefined(); expect(field(root, 'quotaUnit')).toBeDefined(); expect(field(root, 'usageTier')).toBeUndefined()
  root.button('包月 API')!.click(); await flush()
  expect(field(root, 'usageTier')).toBeDefined(); expect(field(root, 'quotaAmount')).toBeUndefined(); dispose()
})

it('发布页展示发布后会发生什么与边界、风险提示', async () => {
  const api = stubApi(); const { root, dispose } = await mountView(api); root.button('发布')!.click(); await flush(); const text = root.text()
  expect(text).toContain('发布后会发生什么'); expect(text).toContain('客服核对你的发布内容'); expect(text).toContain('随时可以在「我的」里关闭发布')
  expect(text).toContain('不收集账号密码、API Key 和联系方式'); expect(text).toContain('共享账号可能违反部分厂商的服务条款'); dispose()
})

it('我的页聚合租单与发布：发布状态显示等待客服对接并可关闭', async () => {
  const post: SharingPostView = { ...claudeSupply, id: `sp-${'d'.repeat(32)}` }
  const api = stubApi([post]); const { root, dispose } = await mountView(api)
  root.button('我的')!.click(); await flush()
  expect(root.text()).toContain('我的租单'); expect(root.text()).toContain('我的发布'); expect(root.text()).toContain('还没有租单')
  expect(root.text()).toContain('已发布 · 等待客服对接')
  root.button('关闭发布')!.click(); await flush()
  expect(api.closePost).toHaveBeenCalledWith({ postId: post.id }); expect(root.text()).toContain('已关闭'); expect(root.button('关闭发布')).toBeUndefined(); dispose()
})

it('卸载时移除监听器并清空页面', async () => {
  const api = stubApi(); const { root, dispose, documentListeners, windowListeners } = await mountView(api)
  expect(documentListeners.get('visibilitychange')?.size).toBe(1); expect(windowListeners.get('blur')?.size).toBe(1); dispose()
  expect(documentListeners.get('visibilitychange')?.size ?? 0).toBe(0); expect(windowListeners.get('blur')?.size ?? 0).toBe(0); expect(root.children).toHaveLength(0)
})
