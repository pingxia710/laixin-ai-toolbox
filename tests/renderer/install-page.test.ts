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
  it('六款软件均有官方获取入口，只有三款接入工具箱 API 配置', () => {
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

  it('Intel Mac 明确提示不能安装的 AI，同时说明工具箱网络功能仍可使用', async () => {
    vi.stubGlobal('document', {
      createElement: () => new Element(),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text })
    })
    vi.stubGlobal('window', {
      toolbox: {
        app: { info: async () => ({ platform: 'darwin', architecture: 'x64' }) },
        download: { openExternal: vi.fn() }
      }
    })
    const root = new Element()
    const teardown = mountInstallCard(root as unknown as HTMLElement, 'codex')

    await vi.waitFor(() => expect(root.all().some((element) => element.textContent.includes('Codex 当前官方桌面应用只支持 Apple 芯片'))).toBe(true))
    expect(root.all().some((element) => element.textContent.includes('AI 网络功能仍可使用'))).toBe(true)
    expect(root.all().some((element) => element.children.some((child) => child.textContent === '查看兼容说明'))).toBe(true)
    teardown()
  })

  it('Intel Mac 不会把官方支持的 Claude Code 误报为不支持', async () => {
    vi.stubGlobal('document', {
      createElement: () => new Element(),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text })
    })
    vi.stubGlobal('window', {
      toolbox: {
        app: { info: async () => ({ platform: 'darwin', architecture: 'x64' }) },
        download: { openExternal: vi.fn() }
      }
    })
    const root = new Element()
    const teardown = mountInstallCard(root as unknown as HTMLElement, 'claude-code')

    await vi.waitFor(() => expect(root.all().some((element) => element.textContent === 'Intel Mac')).toBe(true))
    expect(root.all().some((element) => element.textContent.includes('只支持 Apple 芯片'))).toBe(false)
    expect(root.all().some((element) => element.children.some((child) => child.textContent === '官方下载'))).toBe(true)
    teardown()
  })
})
