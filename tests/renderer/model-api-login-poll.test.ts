import { afterEach, expect, it, vi } from 'vitest'
import type { AiAccessApi } from '../../app/preload/api/ai-access'

/**
 * API-11：登录等待/输登录码期间渲染层每 1.5 秒一轮全量 status，把电脑拖卡。
 * 轮询必须只调轻量登录态端点（codexOfficialStatus / claudeOfficialStatus），
 * 等待窗口内零次全量 status（≙ 主进程观察器零 spawn），登录出结果后全量刷一次对齐整页。
 */

type Doc = { activeElement: Element | null; createElement: (tag: string) => Element }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document

class Element {
  tag = ''
  textContent = ''; className = ''; disabled = false; value = ''; type = ''
  dataset: Record<string, string> = {}; children: Element[] = []
  parent: Element | undefined
  private handlers: Record<string, (event?: unknown) => void> = {}
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child) } }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children) }
  addEventListener(event: string, handler: (event?: unknown) => void) { this.handlers[event] = handler }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' ') },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' ') },
    toggle: (name: string, force?: boolean) => {
      const has = this.className.split(' ').includes(name)
      const next = force === undefined ? !has : force
      if (next && !has) this.classList.add(name)
      if (!next && has) this.classList.remove(name)
      return next
    },
    contains: (name: string) => this.className.split(' ').includes(name)
  }
  focus() { doc().activeElement = this }
  querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0] }
  querySelectorAll(selector: string): Element[] { return this.all().filter(node => matches(node, selector)) }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
}

function matches(node: Element, selector: string): boolean {
  return selector.split(',').some(part => {
    const rule = part.trim()
    if (rule.startsWith('.')) return node.className.split(' ').includes(rule.slice(1))
    if (rule.startsWith('[') && rule.endsWith(']')) {
      const attribute = rule.slice(1, -1)
      return Object.keys(node.dataset).includes(attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()))
    }
    return node.tag === rule
  })
}

const providerKeys = { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false }
const statusSnapshot = (): string => JSON.stringify({
  legacyZaiKeySaved: false,
  shells: {
    codex: { selected: null, officialAvailable: true, providerKeys },
    claude: { selected: null, officialAvailable: true, providerKeys },
    hermes: { selected: null, officialAvailable: true, providerKeys }
  }
})

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(platform: 'codex' | 'claude-code', login: { codex: string; claude: string }) {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }) })
  vi.stubGlobal('window', { toolbox: {} })
  const api = {
    status: vi.fn(async () => ({ snapshot: statusSnapshot() })),
    serviceStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ usage: [], startupError: null }) })),
    codexOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.codex }) })),
    claudeOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.claude }) }))
  }
  const { mountModelApi } = await import('../../app/renderer/src/platform/model-api')
  const root = new Element()
  const unmount = mountModelApi(root as unknown as HTMLElement, platform, api as unknown as AiAccessApi)
  cleanup = unmount
  await flush()
  return { api, login }
}

it('Codex 登录等待期轮询只走登录态端点：窗口内零次全量 status，出结果后全量刷一次对齐', async () => {
  const x = await setup('codex', { codex: 'pending', claude: 'idle' })
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(1500)
  await vi.advanceTimersByTimeAsync(1500)
  await vi.advanceTimersByTimeAsync(1500)
  // 等待窗口内：只问登录态，全量 status（及其后的观察器 spawn、用量读取）一次都不发生。
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.serviceStatus).toHaveBeenCalledTimes(1)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(4)

  x.login.codex = 'connected'
  await vi.advanceTimersByTimeAsync(1500)
  // 登录有了结果：恰好一次全量刷新把配置目标、用量与页面一起对齐（终刷自身再读一次登录态），然后轮询停止。
  expect(x.api.status).toHaveBeenCalledTimes(2)
  expect(x.api.serviceStatus).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(4500)
  expect(x.api.codexOfficialStatus).toHaveBeenCalledTimes(6)
  expect(x.api.status).toHaveBeenCalledTimes(2)
})

it('Claude 登录码等待期同样只轮询登录态；输码阶段不退轮询，登录完成即对齐', async () => {
  const x = await setup('claude-code', { codex: 'idle', claude: 'pending' })
  expect(x.api.status).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(3000)
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(1 + 2)

  x.login.claude = 'code-required'
  await vi.advanceTimersByTimeAsync(1500)
  // pending → code-required 仍是等待：轮询继续，且不触发全量 status。
  expect(x.api.status).toHaveBeenCalledTimes(1)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(4)

  x.login.claude = 'connected'
  await vi.advanceTimersByTimeAsync(1500)
  expect(x.api.status).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3000)
  expect(x.api.claudeOfficialStatus).toHaveBeenCalledTimes(6)
  expect(x.api.status).toHaveBeenCalledTimes(2)
})
