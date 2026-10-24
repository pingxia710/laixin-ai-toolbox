import { afterEach, expect, it, vi } from 'vitest'

class Element {
  textContent = ''; type = ''; disabled = false; value = ''; rows = 0; readOnly = false
  readonly children: Element[] = []
  private handlers = new Map<string, Array<() => void>>()
  append(...nodes: Element[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: Element[]) { this.children.splice(0, this.children.length, ...nodes) }
  setAttribute() { /* 结构断言不依赖属性 */ }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  click() { if (!this.disabled) this.handlers.get('click')?.forEach((handler) => handler()) }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  constructor(readonly tag: string) {}
}

const mount = async () => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const { renderSecretFields } = await import('../../app/renderer/src/subscription/secret-fields')
  const area = new Element('div')
  renderSecretFields(area as unknown as HTMLElement, [
    { name: '账号', value: 'codex-user-1', rows: 2 },
    { name: '密码', value: 'p@ss-w0rd', rows: 2 },
    { name: '登录说明', value: '使用官方站点登录', rows: 4 }
  ])
  return { area, writeText }
}

const copyButtons = (area: Element) => area.all().filter((node) => node.tag === 'button')

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

it('每个字段各有一个复制按钮,点击后剪贴板收到原值并短暂显示已复制', async () => {
  vi.useFakeTimers()
  const { area, writeText } = await mount()
  const buttons = copyButtons(area)
  expect(buttons.map((button) => button.textContent)).toEqual(['复制', '复制', '复制'])
  expect(area.all().filter((node) => node.tag === 'textarea').map((field) => field.value)).toEqual(['codex-user-1', 'p@ss-w0rd', '使用官方站点登录'])
  buttons[1]!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(writeText).toHaveBeenCalledWith('p@ss-w0rd')
  expect(buttons[1]!.textContent).toBe('已复制')
  await vi.advanceTimersByTimeAsync(1500)
  expect(buttons[1]!.textContent).toBe('复制')
  expect(buttons[0]!.textContent).toBe('复制')
})

it('剪贴板不可用时按钮短暂显示复制失败', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) })
  vi.stubGlobal('navigator', { clipboard: undefined })
  const { renderSecretFields } = await import('../../app/renderer/src/subscription/secret-fields')
  const area = new Element('div')
  renderSecretFields(area as unknown as HTMLElement, [{ name: '密码', value: 'x', rows: 2 }])
  copyButtons(area)[0]!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(copyButtons(area)[0]!.textContent).toBe('复制失败')
  await vi.advanceTimersByTimeAsync(1500)
  expect(copyButtons(area)[0]!.textContent).toBe('复制')
})
