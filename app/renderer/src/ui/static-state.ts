export interface StaticState {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
}

export function mountStaticState(element: HTMLElement, state: StaticState): void {
  element.classList.add('static-state')
  const title = document.createElement('h2')
  title.textContent = state.title
  const description = document.createElement('p')
  description.className = 'static-state-description'
  description.textContent = state.description
  const facts = document.createElement('dl')
  facts.className = 'static-state-facts'
  for (const item of state.facts) {
    const row = document.createElement('div')
    const label = document.createElement('dt')
    label.textContent = item.label
    const value = document.createElement('dd')
    value.textContent = item.value
    row.append(label, value)
    facts.append(row)
  }
  element.replaceChildren(title, description)
  if (state.facts.length) element.append(facts)
}
