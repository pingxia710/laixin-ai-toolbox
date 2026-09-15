function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}

export interface PlanCardSpec {
  name: string
  description: string
  price: string
  termSuffix: string
  cta: string
  disabled: boolean
  onChoose: () => void
  features: string[]
}

/** 官方套餐页排版：套餐名 → 描述 → 大价格与周期 → 主按钮 → ✓ 特性列表。订阅与分享两页共用，样式在 subscription/style.css。 */
export function planCard(spec: PlanCardSpec): HTMLElement {
  const card = el('article', '', 'plan-card')
  const price = el('p', '', 'plan-card-price'); price.append(el('strong', spec.price), el('span', spec.termSuffix))
  const choose = el('button', spec.cta, 'primary-action plan-card-cta'); choose.type = 'button'; choose.disabled = spec.disabled
  choose.onclick = () => { spec.onChoose() }
  const features = el('ul', '', 'plan-card-features')
  for (const item of spec.features) features.append(el('li', item))
  card.append(el('h3', spec.name), el('p', spec.description, 'plan-card-desc'), price, choose, features)
  return card
}
