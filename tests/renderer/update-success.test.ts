import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateSuccessNotice } from '../../app/desktop-types'

// 「更新成功」弹窗的渲染契约(无真实 DOM,沿 settings-update 的 fake Element 骨架):
// 更新重启后的第一眼要说出「从哪版升上来、这版改了什么」,一次更新只弹一次。
class Element {
  textContent = ''; className = ''; type = ''; id = ''
  disabled = false; hidden = false; open = false
  readonly dataset: Record<string, string> = {}
  readonly children: Element[] = []
  private handlers = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  click() { if (!this.disabled) this.handlers.get('click')?.forEach((handler) => handler()) }
  showModal() { this.open = true }
  close() { this.open = false; this.handlers.get('close')?.forEach((handler) => handler()) }
  remove() { this.removed = true }
  removed = false
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  find(className: string): Element | undefined {
    return this.all().find((node) => node.className.split(' ').includes(className))
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

const boot = () => {
  const body = new Element('body')
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag), body })
  return body
}

const notice: UpdateSuccessNotice = { version: '0.5.8', previous: '0.5.7', notes: '· 网络修复\n· 模型 API' }
const load = async () => (await import('../../app/renderer/src/update-success')).showUpdateSuccessNotice

describe('更新成功弹窗', () => {
  it('说出「从哪版升上来」和更新内容,我知道了关掉', async () => {
    const body = boot()
    const show = await load()
    show(notice)
    expect(body.children).toHaveLength(1)
    const dialog = body.children[0]
    expect(dialog.className).toContain('update-success-dialog')
    expect(dialog.all().find((node) => node.id === 'update-success-title')?.textContent).toBe('更新成功!')
    expect(dialog.find('update-dialog-release')?.textContent).toBe('v0.5.8')
    expect(dialog.find('update-dialog-summary')?.textContent).toBe('已从 v0.5.7 更新到 v0.5.8。')
    expect(dialog.find('update-dialog-notes')?.textContent).toBe('· 网络修复\n· 模型 API')
    const ack = dialog.all().find((node) => node.textContent === '我知道了')
    expect(ack).toBeTruthy()
    expect(dialog.open).toBe(true)
    ack!.click()
    expect(dialog.open).toBe(false)
    expect(dialog.removed).toBe(true)
  })

  it('旧 pending 没记上一版时兜底「已更新到」,说明缺失时不留空', async () => {
    const body = boot()
    const show = await load()
    show({ version: '0.5.8', previous: '', notes: '' })
    const dialog = body.children[0]
    expect(dialog.find('update-dialog-summary')?.textContent).toBe('已更新到 v0.5.8。')
    expect(dialog.find('update-dialog-notes')?.textContent).toBe('此版本未提供更新说明。')
  })

  it('一次更新只弹一次;空通知不弹', async () => {
    const body = boot()
    const show = await load()
    show(notice)
    show(notice)
    expect(body.children).toHaveLength(1)
    show({ version: '', previous: '', notes: '' })
    expect(body.children).toHaveLength(1)
  })
})
