import { afterEach, expect, it, vi } from 'vitest'
import type { SubscriptionProduct } from '../../app/subscription-types'

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
  readonly children: never[] = []
  constructor(readonly textContent: string) {}
  all(): TextNode[] { return [this] }
  text(): string { return this.textContent }
}
class Element {
  textContent = ''; type = ''; disabled = false; value = ''; checked = false; required = false
  onclick: (() => void) | null = null
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null
  onkeydown: ((event: { key: string; preventDefault(): void }) => void) | null = null
  readonly children: (Element | TextNode)[] = []
  private classes = new Set<string>()
  readonly dataset: Record<string, string> = {}
  get className() { return [...this.classes].join(' ') }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  readonly classList = { add: (name: string) => { this.classes.add(name) }, remove: (name: string) => { this.classes.delete(name) } }
  append(...nodes: (Element | TextNode)[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: (Element | TextNode)[]) { this.children.splice(0, this.children.length, ...nodes) }
  setAttribute() { /* 结构断言不依赖属性 */ }
  removeAttribute() { /* 结构断言不依赖属性 */ }
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

const product = (id: string, software: 'codex' | 'claude', name: string, priceCents: number): SubscriptionProduct => ({
  id, software, name, description: `${name} 说明`, priceCents, serviceFeeCents: 1200, term: '按月订阅', deliveryHours: 24,
  fulfillmentTerms: '办理说明', recoveryTerms: '找回说明', cancellationTerms: '取消说明', enabled: true
})
const catalog = { products: [
  product('sub-codex-go-v1', 'codex', 'ChatGPT Go', 6800),
  product('sub-codex-plus-v1', 'codex', 'ChatGPT Plus', 15800),
  product('sub-codex-pro-v1', 'codex', 'ChatGPT Pro', 139800),
  product('sub-claude-pro-v1', 'claude', 'Claude Pro', 14500),
  product('sub-claude-max5-v1', 'claude', 'Claude Max（5×）', 72000),
  product('sub-claude-max20-v1', 'claude', 'Claude Max（20×）', 139800)
], channels: ['manual'] }

function stubApi() {
  return {
    catalog: vi.fn(async () => ({ data: JSON.stringify(catalog), error: '' })),
    list: vi.fn(async () => ({ data: JSON.stringify({ orders: [], nextCursor: '' }), error: '' })),
    create: vi.fn(), detail: vi.fn(), pay: vi.fn(), reveal: vi.fn(), complete: vi.fn(), cancel: vi.fn(), report: vi.fn()
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function stubDom(api: ReturnType<typeof stubApi>) {
  const listeners = new Map<string, Set<() => void>>()
  const track = (map: Map<string, Set<() => void>>) => ({
    addEventListener: (event: string, handler: () => void) => { const set = map.get(event) ?? new Set<() => void>(); set.add(handler); map.set(event, set) },
    removeEventListener: (event: string, handler: () => void) => { map.get(event)?.delete(handler) }
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => new TextNode(text),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    visibilityState: 'visible',
    ...track(listeners)
  })
  vi.stubGlobal('window', { toolbox: { subscription: api }, ...track(new Map()) })
}
async function mountView(api: ReturnType<typeof stubApi>) {
  stubDom(api)
  const { mountSubscriptions } = await import('../../app/renderer/src/subscription/view')
  const root = new Element('main')
  const dispose = mountSubscriptions(root as unknown as HTMLElement)
  await flush()
  return { root, dispose }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); mocks.account.view = { state: 'signed-in', account: { id: 'local-fixture', username: 'local-fixture' } } })

it('默认 Codex 视图渲染三档套餐卡（官方三档）', async () => {
  const api = stubApi()
  const { root, dispose } = await mountView(api)
  const text = root.text()
  for (const name of ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro']) expect(text).toContain(name)
  expect(text).toContain('¥68.00')
  expect(text).not.toContain('Claude Pro 说明')
  expect(root.all().filter((node) => node instanceof Element && node.className.split(/\s+/).includes('plan-card'))).toHaveLength(3)
  expect(root.button('Codex')).toBeDefined()
  expect(root.button('Claude Code')).toBeDefined()
  expect(mocks.markServiceAvailability).toHaveBeenCalledWith('purchase', false)
  dispose()
})

it('切到 Claude Code 显示三档 Claude 套餐，切回 Codex 恢复', async () => {
  const api = stubApi()
  const { root, dispose } = await mountView(api)
  root.button('Claude Code')!.click()
  await flush()
  const text = root.text()
  for (const name of ['Claude Pro', 'Claude Max（5×）', 'Claude Max（20×）']) expect(text).toContain(name)
  expect(text).not.toContain('ChatGPT Plus')
  expect(root.all().filter((node) => node instanceof Element && node.className.split(/\s+/).includes('plan-card'))).toHaveLength(3)
  root.button('Codex')!.click()
  await flush()
  expect(root.text()).toContain('ChatGPT Plus')
  dispose()
})

it('「我的订单」在页头右上角，点击后切换为订单视图并显示「选择套餐」回程', async () => {
  const api = stubApi()
  const { root, dispose } = await mountView(api)
  const header = root.all().find((node): node is Element => node instanceof Element && node.className.split(/\s+/).includes('sub-header'))!
  expect(header).toBeDefined()
  expect(header.all().some((node) => node instanceof Element && node.tag === 'button' && node.textContent === '我的订单')).toBe(true)
  root.button('我的订单')!.click()
  await flush()
  const text = root.text()
  expect(text).toContain('还没有账号订阅订单。')
  expect(root.button('选择套餐')).toBeDefined()
  root.button('选择套餐')!.click()
  await flush()
  expect(root.text()).toContain('ChatGPT Go')
  dispose()
})

it('切换后选套餐仍进入确认下单视图', async () => {
  const api = stubApi()
  const { root, dispose } = await mountView(api)
  root.button('Claude Code')!.click()
  await flush()
  root.button('查看套餐与办理说明')!.click()
  await flush()
  const text = root.text()
  expect(text).toContain('Claude Pro')
  expect(text).toContain('取消与退款：取消说明')
  expect(root.button('确认下单')).toBeDefined()
  dispose()
})
