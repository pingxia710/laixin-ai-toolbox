import { afterEach, expect, it, vi } from 'vitest'
import type { AiAccessApi } from '../../app/preload/api/ai-access'
import { mountModelApi } from '../../app/renderer/src/platform/model-api'

class Element {
  textContent = ''; className = ''; disabled = false; type = ''; value = ''; tag = ''
  dataset: Record<string, string> = {}; children: Element[] = []
  onclick?: () => void
  parent?: Element
  setAttribute() {}
  addEventListener() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child) } }
  prepend(...children: Element[]) { this.children.unshift(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
  querySelector() { return undefined }
  querySelectorAll() { return [] }
  classList = { add() {}, toggle() {} }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
let unmount = () => {}
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function setup(code: 'RESTORE_FAILED' | 'RESTORED' | 'AVAILABLE') {
  vi.useFakeTimers()
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }) })
  vi.stubGlobal('window', { toolbox: {} })
  const providerKeys = { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false }
  const shell = { selected: null, officialAvailable: true, providerKeys }
  const isolation = { application: 'codex', scope: 'model-api-egress', capability: 'http-connect',
    mode: code === 'RESTORED' ? 'disabled' : 'application-only', systemNetwork: 'unmanaged',
    phase: code === 'RESTORE_FAILED' ? 'limited' : code === 'RESTORED' ? 'restored' : 'available',
    action: 'recover', intentGeneration: 1, available: code === 'AVAILABLE', code }
  const snapshot = async () => ({ snapshot: JSON.stringify(isolation) })
  const api = {
    status: async () => ({ snapshot: JSON.stringify({ shells: { codex: shell, claude: shell, hermes: shell }, codexMultiModel: { mode: 'single', models: [] } }) }),
    serviceStatus: async () => ({ snapshot: JSON.stringify({ usage: [], startupError: null }) }),
    codexOfficialStatus: async () => ({ snapshot: JSON.stringify({ status: 'idle' }) }),
    codexIsolationStatus: snapshot, enableCodexIsolation: vi.fn(snapshot), disableCodexIsolation: vi.fn(snapshot)
  }
  const root = new Element()
  unmount = mountModelApi(root as unknown as HTMLElement, 'codex', api as unknown as AiAccessApi)
  await flush()
  expect(root.all().some(item => item.textContent === '模型配置暂时无法读取，请重试。')).toBe(false)
  const section = () => root.all().find(item => item.className.includes('codex-isolation'))!
  const button = () => section().all().find(item => item.tag === 'button')!
  return { root, section, button, api }
}

it('恢复失败只阻止 Codex 隔离重新启用，不把应用作用域误报成系统未接管', async () => {
  const x = await setup('RESTORE_FAILED')
  const message = x.section().all().map(item => item.textContent).join(' ')
  expect(message).toContain('恢复失败')
  expect(message).toContain('重新打开工具箱')
  expect(message).not.toContain('系统网络未接管')
})

it('恢复失败的启用按钮和迟到事件都被阻止', async () => {
  const x = await setup('RESTORE_FAILED')
  expect(x.button().disabled).toBe(true)
  expect(x.button().textContent).toBe('恢复未完成，暂不能启用')
  x.button().onclick?.() // 迟到事件也不能绕过动作守卫。
  await flush()
  expect(x.api.enableCodexIsolation).not.toHaveBeenCalled()
})

it('已恢复后可启用，已验证可用后仍可停止，不能一律禁用按钮', async () => {
  const restored = await setup('RESTORED')
  expect(restored.button().disabled).toBe(false)
  restored.button().onclick?.()
  await flush()
  expect(restored.api.enableCodexIsolation).toHaveBeenCalledOnce()
  unmount()
  const available = await setup('AVAILABLE')
  expect(available.button().disabled).toBe(false)
  expect(available.section().all().map(item => item.textContent).join(' ')).not.toContain('工具箱未接管系统网络')
  available.button().onclick?.()
  await flush()
  expect(available.api.disableCodexIsolation).toHaveBeenCalledOnce()
})
