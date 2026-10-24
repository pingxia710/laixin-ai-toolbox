import { afterEach, expect, it, vi } from 'vitest'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import type { NetworkActivity } from '../../app/renderer/src/ui/network-activity'
import { page } from '../../app/renderer/src/pages/dashboard'

const feed = vi.hoisted(() => ({ listen: (value: NetworkActivity) => { void value }, value: {} as NetworkActivity }))
vi.mock('../../app/renderer/src/ui/network-activity', () => ({
  observeNetworkActivity: (listen: typeof feed.listen) => { feed.listen = listen; listen(feed.value); return () => {} },
  refreshNetworkActivity: async () => feed.listen(feed.value), renderTrafficMeter: () => {}
}))
vi.mock('../../app/renderer/src/account-state', () => ({ accountSnapshot: () => ({}), onAccountChange: () => () => {} }))
vi.mock('../../app/renderer/src/ui/network-onboarding', () => ({ buildNetworkOnboarding: () => ({}), renderNetworkOnboarding: () => {} }))
vi.mock('../../app/renderer/src/ui/account-overview', () => ({ mountTrafficSummary: () => {} }))
vi.mock('../../app/renderer/src/icons', () => ({ icon: () => document.createElement('span') }))
vi.mock('../../app/renderer/src/platform-icons', () => ({ platformIcon: () => document.createElement('span') }))

class Element {
  textContent = ''; className = ''; disabled = false
  dataset: Record<string, string> = {}; children: Element[] = []; attributes = new Map<string, string>()
  classList = { add: () => {} }
  handlers: Record<string, () => void> = {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) }
  addEventListener(event: string, handler: () => void) { this.handlers[event] = handler }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())] }
  querySelector(selector: string) { return this.all().find(node => selector === `.${node.className}`) }
  click() { if (!this.disabled) this.handlers.click?.() }
}
const connected: TunnelStatusView = {
  pauseReason: '', currentConfig: '1', pendingConfig: '', canApplyPending: false, state: '已连', message: '',
  source: '', authorization: '', backend: '', nodeLabel: '', exitIp: '', pathSource: 'laixin',
  lastVerifiedAt: '', configVersion: '1', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: ''
}
const restored = { ...connected, state: '已停止并恢复原设置', recoveryState: 'idle' as const }
afterEach(() => { page.unmount(); vi.unstubAllGlobals() })

async function setup(code = '') {
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('document', { activeElement: null, createElement: () => new Element() })
  const stop = vi.fn().mockResolvedValue({ outcome: 'stopped', code, message: '已断开,原设置恢复中' })
  vi.stubGlobal('window', { toolbox: { tunnel: { stop } } })
  feed.value = { kind: 'ready', status: connected, samples: [] }
  const root = new Element()
  page.mount(root as unknown as HTMLElement, { tab: 'dashboard' })
  root.querySelector('.dashboard-power')!.click()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(stop).toHaveBeenCalledOnce()
  const update = (status: TunnelStatusView) => feed.listen({ kind: 'ready', status, samples: [] })
  return { update, feedback: () => root.querySelector('.dashboard-action-feedback')?.textContent }
}

it('断开反馈直到确认恢复才消失，读取失败或不完整恢复不冒充完成', async () => {
  const ui = await setup()
  expect(ui.feedback()).toContain('恢复中')
  feed.listen({ kind: 'unavailable', samples: [] })
  expect(ui.feedback()).toContain('恢复中')
  for (const incomplete of [
    { ...restored, recoveryState: 'running' as const },
    { ...restored, recoveryState: 'required' as const },
    { ...restored, unrestored: 'proxy pending' },
    { ...restored, componentMissing: 'core missing' }
  ]) {
    ui.update(incomplete)
    expect(ui.feedback()).toContain('恢复中')
  }
  ui.update(restored)
  expect(ui.feedback()).toBeUndefined()
})

it('有错误码的断开结果不被正常状态静默清除', async () => {
  const ui = await setup('RESTORE_FAILED')
  ui.update(restored)
  expect(ui.feedback()).toContain('恢复中')
})
