import { icon, type IconName } from './icons'

export interface ButtonOptions {
  readonly className?: string
  readonly iconName?: IconName
  readonly disabled?: boolean
  readonly onClick?: () => void
}

export function pageHeading(title: string, description: string, eyebrow?: string): HTMLElement {
  const header = document.createElement('header')
  header.className = 'page-heading'
  const copy = document.createElement('div')
  copy.className = 'page-heading-copy'
  if (eyebrow !== undefined) {
    copy.append(Object.assign(document.createElement('div'), { className: 'eyebrow', textContent: eyebrow }))
  }
  copy.append(Object.assign(document.createElement('h2'), { textContent: title }))
  copy.append(Object.assign(document.createElement('p'), { textContent: description }))
  header.append(copy)
  return header
}

export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = `button${options.className === undefined ? '' : ` ${options.className}`}`
  node.disabled = options.disabled === true
  if (options.iconName !== undefined) node.append(icon(options.iconName))
  node.append(document.createTextNode(label))
  if (options.onClick !== undefined) node.addEventListener('click', options.onClick)
  return node
}

export function statusPill(label: string, tone: 'neutral' | 'positive' | 'warning' | 'danger' = 'neutral'): HTMLElement {
  const node = document.createElement('span')
  node.className = 'status-pill'
  node.dataset.tone = tone
  node.textContent = label
  return node
}

export function emptyState(iconName: IconName, title: string, description: string, badge?: string): HTMLElement {
  const state = document.createElement('section')
  state.className = 'empty-state'
  const mark = document.createElement('div')
  mark.className = 'empty-icon'
  mark.append(icon(iconName))
  state.append(mark)
  if (badge !== undefined) state.append(statusPill(badge))
  state.append(Object.assign(document.createElement('h2'), { textContent: title }))
  state.append(Object.assign(document.createElement('p'), { textContent: description }))
  return state
}
