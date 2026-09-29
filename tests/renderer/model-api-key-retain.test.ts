import { afterEach, expect, it, vi } from 'vitest'
import type { AiAccessApi } from '../../app/preload/api/ai-access'

const providerEditor = vi.hoisted(() => ({ open: vi.fn(() => () => undefined) }))
vi.mock('../../app/renderer/src/platform/provider-editor', () => ({ openProviderEditor: providerEditor.open }))

// 复审收尾：Key 快捷表单提交后，若 saveKeyFlow 的守卫恰好拦住（如官方登录等待刚好开始），
// 客户刚输入的 Key 不能被静默丢掉——留在表单里等状态恢复后重试，⛔ 逼客户重新输入。

type Doc = { activeElement: Element | null; createElement: (tag: string) => Element }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document

class Element {
  tag = ''
  textContent = ''; className = ''; disabled = false; value = ''; type = ''; name = ''
  dataset: Record<string, string> = {}; children: Element[] = []
  parent: Element | undefined
  onclick?: () => void
  oninput?: () => void
  onsubmit?: (event: { preventDefault: () => void }) => void
  private handlers: Record<string, (event?: unknown) => void> = {}
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child) } }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined } }
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
  codexMultiModel: { mode: 'single', models: [] },
  shells: {
    codex: { selected: null, officialAvailable: true, providerKeys },
    claude: { selected: null, officialAvailable: true, providerKeys },
    hermes: { selected: null, officialAvailable: true, providerKeys }
  }
})

const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); providerEditor.open.mockClear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(platform: 'codex' | 'claude-code' | 'hermes', login: { codex: string; claude: string }, overrides: Partial<AiAccessApi> = {}) {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }) })
  vi.stubGlobal('window', { toolbox: {} })
  const api = {
    status: vi.fn(async () => ({ snapshot: statusSnapshot() })),
    serviceStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ usage: [], startupError: null }) })),
    aiRouterStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ running: false, modelCount: 0, error: 'not_configured', catalog: { state: 'missing' } }) })),
    codexOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.codex }) })),
    claudeOfficialStatus: vi.fn(async () => ({ snapshot: JSON.stringify({ status: login.claude }) })),
    ...overrides
  }
  const { mountModelApi } = await import('../../app/renderer/src/platform/model-api')
  const root = new Element()
  const unmount = mountModelApi(root as unknown as HTMLElement, platform, api as unknown as AiAccessApi)
  cleanup = unmount
  await flush()
  return { api, root, login }
}

it('守卫拦下提交时，刚输入的 Key 留在表单里，而不是被静默清空', async () => {
  const x = await setup('codex', { codex: 'pending', claude: 'idle' })
  // 登录等待中 Key 表单仍可打开（input 只在 busy 时禁用）。
  const addKey = x.root.all().find(element => element.textContent === '添加API key' && element.tag === 'button')
  expect(addKey).toBeDefined()
  addKey!.onclick!()
  await flush()
  const input = x.root.all().find(element => element.tag === 'input' && element.name === 'key')
  expect(input).toBeDefined()
  input!.value = 'sk-typed-fixture-0123456789abcdef'
  input!.oninput?.()

  const form = x.root.querySelector('form')!
  form.onsubmit?.({ preventDefault: () => undefined })
  await flush()

  // saveKeyFlow 的守卫因官方登录等待拦下提交：Key 必须还在表单里（新渲染的输入框回填草稿）。
  const retained = x.root.all().find(element => element.tag === 'input' && element.name === 'key')
  expect(retained).toBeDefined()
  expect(retained!.value).toBe('sk-typed-fixture-0123456789abcdef')
})
