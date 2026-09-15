import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountInstallCard, officialInstallPlatforms } from '../../app/renderer/src/platform/install-card'

class Element {
  textContent = ''
  className = ''
  type = ''
  disabled = false
  src = ''
  alt = ''
  width = 0
  height = 0
  draggable = false
  onclick?: () => void
  dataset: Record<string, string> = {}
  children: Element[] = []

  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
  click() { if (!this.disabled) this.onclick?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

afterEach(() => vi.unstubAllGlobals())

describe('各 AI 页的官方下载与版本入口', () => {
  it('保留六个已定平台和唯一的官方资源入口', () => {
    expect(officialInstallPlatforms.map((platform) => platform.id)).toEqual([
      'codex', 'claude-code', 'hermes', 'deepseek-harness', 'zcode', 'kimi-code'
    ])
    expect(officialInstallPlatforms.filter((platform) => platform.connectsInToolbox).map((platform) => platform.id))
      .toEqual(['codex', 'claude-code', 'hermes'])
    expect(new Set(officialInstallPlatforms.map((platform) => platform.resourceId)).size).toBe(6)
  })

  it('Codex 下载入口只交给登记的官方下载资源，连点不会重复打开', async () => {
    let releaseReachability = (): void => undefined
    const reachability = vi.fn(() => new Promise<{ snapshot: string }>((resolve) => {
      releaseReachability = () => resolve({ snapshot: JSON.stringify({ reachable: true }) })
    }))
    const openExternal = vi.fn(async () => undefined)
    vi.stubGlobal('document', {
      createElement: () => new Element(),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text })
    })
    vi.stubGlobal('window', {
      toolbox: {
        app: { info: async () => ({ platform: 'win32' }) },
        download: { openExternal },
        shells: { reachability },
        tunnel: { status: async () => ({ state: '未配置' }) }
      }
    })
    const root = new Element()
    const teardown = mountInstallCard(root as unknown as HTMLElement, 'codex')
    const download = root.all().find((element) => element.children.some((child) => child.textContent === '官方下载'))!

    download.click()
    download.click()
    releaseReachability()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('codex-official-download'))

    expect(reachability).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledTimes(1)
    teardown()
  })
})
