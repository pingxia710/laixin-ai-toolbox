import { afterEach, expect, it, vi } from 'vitest'

class Element {
  textContent = ''; type = ''; disabled = false
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  children: Element[] = []
  parent: Element | null = null
  private classes = new Set<string>()
  private handlers = new Map<string, Array<() => void>>()
  get className() { return [...this.classes].join(' ') }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) }
  readonly classList = {
    add: (name: string) => { this.classes.add(name) },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name)
      if (next) this.classes.add(name); else this.classes.delete(name)
      return next
    }
  }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes: Element[]) { this.children = []; for (const node of nodes) { node.parent = this; this.children.push(node) } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null } }
  setAttribute(name: string, value: string) { if (name === 'class') this.className = value; else this.dataset[name] = value }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  click() { if (!this.disabled) this.handlers.get('click')?.forEach((handler) => handler()) }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  button(label: string): Element | undefined { return this.all().find((node) => node.tag === 'button' && node.textContent === label) }
  constructor(readonly tag: string) {}
}

const stubDom = () => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag)
  })
}

const mount = async (expiresAt: number) => {
  stubDom()
  const { mountQrCountdown } = await import('../../app/renderer/src/subscription/qr-countdown')
  const container = new Element('div')
  const regenerate = vi.fn()
  mountQrCountdown(container as unknown as HTMLElement, { data: 'weixin://wxpay/qr-test', expiresAt }, { regenerate: regenerate as unknown as () => void })
  return { container, regenerate }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

it('展示二维码与倒计时,剩不到 1 分钟时提示尽快扫码', async () => {
  vi.useFakeTimers()
  const start = Date.now()
  vi.setSystemTime(start)
  const { container } = await mount(start + 90_000)
  const text = container.all().map((node) => node.textContent).join(' ')
  expect(text).toContain('1 分 30 秒')
  expect(container.all().some((node) => node.tag === 'svg')).toBe(true)
  vi.advanceTimersByTime(35_000)
  expect(container.all().map((node) => node.textContent).join(' ')).toContain('请尽快扫码')
  expect(container.all().some((node) => node.tag === 'svg')).toBe(true)
})

it('过期后二维码不可见、区块灰掉并出现重新生成按钮', async () => {
  vi.useFakeTimers()
  const start = Date.now()
  vi.setSystemTime(start)
  const { container, regenerate } = await mount(start + 3_000)
  expect(container.all().some((node) => node.tag === 'svg')).toBe(true)
  vi.advanceTimersByTime(3_100)
  expect(container.all().some((node) => node.tag === 'svg')).toBe(false)
  expect(container.className).toContain('qr-expired')
  expect(container.all().map((node) => node.textContent).join(' ')).toContain('二维码已过期')
  const button = container.button('重新生成二维码')
  expect(button).toBeDefined()
  button!.click()
  expect(regenerate).toHaveBeenCalledTimes(1)
})

it('渲染时已过期则直接进入过期态', async () => {
  vi.useFakeTimers()
  const start = Date.now()
  vi.setSystemTime(start)
  const { container, regenerate } = await mount(start - 1_000)
  expect(container.className).toContain('qr-expired')
  expect(container.all().some((node) => node.tag === 'svg')).toBe(false)
  expect(container.button('重新生成二维码')).toBeDefined()
  container.button('重新生成二维码')!.click()
  expect(regenerate).toHaveBeenCalledTimes(1)
})
