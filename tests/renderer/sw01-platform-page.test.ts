import { afterEach, expect, it, vi } from 'vitest'
import { mountPlatformPage } from '../../app/renderer/src/platform/view'

class Element {
  className = ''
  textContent = ''
  id = ''
  tabIndex = 0
  dataset: Record<string, string> = {}
  children: Element[] = []
  onclick?: () => void
  onkeydown?: (event: KeyboardEvent) => void
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

afterEach(() => vi.unstubAllGlobals())

it('更多平台三款显示各自的官方获取卡并打开正确入口，已有用量页仍可进入', async () => {
  vi.stubGlobal('document', {
    createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text })
  })
  const openExternal = vi.fn(async () => undefined)
  vi.stubGlobal('window', { toolbox: { app: { info: async () => ({ platform: 'win32' }) }, download: { openExternal } } })
  for (const [platform, resourceId] of [
    ['deepseek-harness', 'deepseek-harness-official-install'],
    ['zcode', 'zcode-official-download'],
    ['kimi-code', 'kimi-code-official-install']
  ] as const) {
    const root = new Element()
    const usage = vi.fn(() => () => undefined)
    const teardown = mountPlatformPage(root as unknown as HTMLElement, platform, usage)
    expect(usage).toHaveBeenCalledOnce()
    expect(root.all().some((node) => node.className.includes('platform-install-card'))).toBe(true)
    const download = root.all().find((node) => node.children.some((child) => child.textContent === '官方下载'))
    expect(download).toBeDefined()
    download?.onclick?.()
    await vi.waitFor(() => expect(openExternal).toHaveBeenLastCalledWith(resourceId))
    teardown()
  }
})
