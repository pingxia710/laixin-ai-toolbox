import { afterEach, expect, it, vi } from 'vitest'

class Element {
  textContent = ''; type = ''; disabled = false
  onclick: (() => void) | null = null
  readonly children: Element[] = []
  private classes = new Set<string>()
  get className() { return [...this.classes].join(' ') }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  append(...nodes: Element[]) { this.children.push(...nodes) }
  setAttribute() { /* 结构断言不依赖属性 */ }
  click() { if (!this.disabled) this.onclick?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  byClass(name: string): Element[] { return this.all().filter((node) => node.classes.has(name)) }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(' ') }
  constructor(readonly tag: string) {}
}

const mount = async (spec: { cta?: string; disabled?: boolean; onChoose?: () => void }) => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const { planCard } = await import('../../app/renderer/src/ui/plan-card')
  return planCard({
    name: 'ChatGPT Plus', description: '官方个人套餐', price: '¥160.00', termSuffix: ' · 按月订阅',
    cta: spec.cta ?? '查看套餐与办理说明', disabled: spec.disabled ?? false, onChoose: spec.onChoose ?? (() => undefined),
    features: ['付款后 24 小时内人工办理交付', '已含账号订阅服务费 ¥10.00，网络费用另计']
  }) as unknown as Element
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('按官方套餐页排版输出卡片结构：名称、描述、大价格与周期、主按钮、特性列表', async () => {
  const card = await mount({})
  expect(card.byClass('plan-card')).toHaveLength(1)
  expect(card.all().find((node) => node.tag === 'h3')?.textContent).toBe('ChatGPT Plus')
  expect(card.byClass('plan-card-desc')[0]?.textContent).toBe('官方个人套餐')
  const price = card.byClass('plan-card-price')[0]!
  expect(price.children[0]?.tag).toBe('strong')
  expect(price.children[0]?.textContent).toBe('¥160.00')
  expect(price.children[1]?.textContent).toBe(' · 按月订阅')
  const cta = card.byClass('plan-card-cta')[0]!
  expect(cta.className).toContain('primary-action')
  expect(cta.textContent).toBe('查看套餐与办理说明')
  const features = card.byClass('plan-card-features')[0]!
  expect(features.tag).toBe('ul')
  expect(features.children.map((node) => node.textContent)).toEqual(['付款后 24 小时内人工办理交付', '已含账号订阅服务费 ¥10.00，网络费用另计'])
})

it('按钮禁用时不触发选择，启用时触发', async () => {
  let chosen = 0
  const disabledCard = await mount({ cta: '暂未开放', disabled: true, onChoose: () => { chosen++ } })
  disabledCard.byClass('plan-card-cta')[0]!.click()
  expect(chosen).toBe(0)
  const enabledCard = await mount({ onChoose: () => { chosen++ } })
  enabledCard.byClass('plan-card-cta')[0]!.click()
  expect(chosen).toBe(1)
})
