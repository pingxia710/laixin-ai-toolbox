// N-26:「启动」与「暂停使用」拆成两颗卡。原来一张 actionCard 按 stop 布尔在「连接通道/断开与恢复」
// 之间换脸(pages/tunnel.ts:547),客户不敢点、分不清暂停后会不会自己连回去。
// 轻暂停语义(创始人 09-18 定):暂停 = 断开通道 + 恢复原设置 + 开机不自动接续(复用 user-disconnected
// 意图,动作走既有 tunnel.stop() 链路),差异只在呈现——两卡并存、暂停态明说「已暂停使用」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import { idleNetworkRepair, type NetworkRepairStatus } from '../../app/shared/network-repair'

type Doc = { activeElement: Element | null; createElement: (tag: string) => Element; createTextNode: (text: string) => Element }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document

// 与 tunnel-lifecycle.test.ts 同一套假 DOM:tunnel 页只依赖这份子集。
function matches(node: Element, selector: string): boolean {
  return selector.split(',').some((part) => {
    const rule = part.trim()
    if (rule.startsWith('.')) return node.className.split(' ').includes(rule.slice(1))
    const tag = /^([a-z]+)(\[open\])?$/.exec(rule)
    if (tag) return node.tag === tag[1] && (tag[2] === undefined || node.open)
    const attribute = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(rule)
    if (!attribute) return false
    const value = node.dataset[attribute[1].replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())]
    return attribute[2] === undefined ? value !== undefined : value === attribute[2]
  })
}

class Element {
  tag = ''
  textContent = ''; className = ''; disabled = false; value = ''; open = false
  dataset: Record<string, string> = {}; children: Element[] = []
  parent: Element | undefined
  selectionStart: number | null = null; selectionEnd: number | null = null
  private handlers: Record<string, () => void> = {}
  setAttribute() {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child) } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined }
  replaceChildren(...children: Element[]) {
    const active = doc().activeElement
    const losesFocus = (node: Element): boolean => active === node || node.children.some(losesFocus)
    for (const child of this.children) if (losesFocus(child)) doc().activeElement = null
    this.children = []
    this.append(...children)
  }
  addEventListener(event: string, call: () => void) { this.handlers[event] = call }
  contains(node: Element | null): boolean { return node === this || this.children.some((child) => child.contains(node)) }
  focus() { doc().activeElement = this }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
  querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0] }
  querySelectorAll(selector: string): Element[] { return this.all().filter((node) => matches(node, selector)) }
  click() { if (!this.disabled) this.handlers.click?.() }
  trigger(event: string) { this.handlers[event]?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

const connected: TunnelStatusView = {
  pauseReason: '',
  currentConfig: '版本 1', pendingConfig: '', canApplyPending: false, state: '已连', message: '', source: '', authorization: '', backend: '',
  nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: ''
}
// 旧用户主动断开与已停止状态沿用暂停文案；新的恢复在途状态由 N-48 单独验证。
const pausedSettled = { ...connected, state: '已停止并恢复原设置' }
const pausedRestoring = { ...connected, state: '用户主动断开' }

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(statusResponse: TunnelStatusView, repairResponse: NetworkRepairStatus = idleNetworkRepair, signedIn = false) {
  vi.useFakeTimers()
  const start = vi.fn().mockResolvedValue({ outcome: 'started', message: '连接中', code: '' })
  const stop = vi.fn().mockResolvedValue({ outcome: 'stopped', message: '已断开,原设置恢复中', code: '' })
  const repair = vi.fn().mockResolvedValue({ outcome: 'started', message: '正在修复', code: '' })
  const syncAccountConfig = vi.fn().mockResolvedValue({ outcome: 'unchanged', message: '配置已更新', code: '' })
  const status = vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(statusResponse)
  const repairStatus = vi.fn<() => Promise<NetworkRepairStatus>>().mockResolvedValue(repairResponse)
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (textContent: string) => Object.assign(new Element(), { textContent }) })
  vi.stubGlobal('window', { toolbox: { tunnel: { status, start, stop, explainRoute: vi.fn(), repairStatus, repair, syncAccountConfig, importConfig: vi.fn(), applyPending: vi.fn() }, diagnostics: { report: vi.fn() } } })
  if (signedIn) {
    const { accountAction } = await import('../../app/renderer/src/account-state')
    await accountAction(async () => ({ snapshot: JSON.stringify({ state: 'signed-in', account: { id: 'local-customer', username: '测试账号' },
      overview: null, code: '', message: '' }) }))
  }
  const tunnelPage = await import('../../app/renderer/src/pages/tunnel')
  // 启动/暂停两颗卡在「手动配置」动作区,由 mountTunnelDetails 挂到独立宿主——两处都要挂。
  const advanced = new Element(); const unmountAdvanced = tunnelPage.mountTunnelDetails(advanced as unknown as HTMLElement)
  const root = new Element(); tunnelPage.page.mount(root as unknown as HTMLElement, { tab: 'tunnel' })
  cleanup = () => { tunnelPage.page.unmount(); unmountAdvanced() }
  await flush()
  return { root, advanced, start, stop, repair, syncAccountConfig, text: () => [...root.all(), ...advanced.all()].map((node) => node.textContent) }
}

describe('N-26 启动与暂停拆两颗卡', () => {
  it('活动态两卡并存且暂停可点:连接通道卡禁用,暂停卡点了走既有 stop', async () => {
    const x = await setup(connected)
    const pause = x.advanced.querySelector('[data-network-action="暂停使用"]')
    const resume = x.advanced.querySelector('[data-network-action="连接通道"]')
    expect(pause).toBeTruthy()
    expect(resume).toBeTruthy()
    expect(pause!.disabled).toBe(false)
    expect(resume!.disabled).toBe(true)
    pause!.click()
    await flush()
    expect(x.stop).toHaveBeenCalledTimes(1)
    expect(x.start).not.toHaveBeenCalled()
  })

  it('暂停落定后状态卡明说「已暂停使用」和「开机不会自动连接」,恢复进行中也一样', async () => {
    const settled = await setup(pausedSettled)
    expect(settled.text().some((text) => text.includes('已暂停使用'))).toBe(true)
    expect(settled.text().some((text) => text.includes('开机不会自动连接'))).toBe(true)
    const restoring = await setup(pausedRestoring)
    expect(restoring.text().some((text) => text.includes('已暂停使用'))).toBe(true)
  })

  it('暂停态恢复换文案:恢复使用可点并走既有 start,暂停卡禁用', async () => {
    const x = await setup(pausedSettled)
    const resume = x.advanced.querySelector('[data-network-action="恢复使用"]')
    const pause = x.advanced.querySelector('[data-network-action="暂停使用"]')
    expect(resume).toBeTruthy()
    expect(pause).toBeTruthy()
    expect(resume!.disabled).toBe(false)
    expect(pause!.disabled).toBe(true)
    resume!.click()
    await flush()
    expect(x.start).toHaveBeenCalledTimes(1)
    expect(x.stop).not.toHaveBeenCalled()
  })
})

describe('N-48 断开在途', () => {
  it('主入口和手动连接、重复暂停都不可点，即使旧授权显示等待重查', async () => {
    const x = await setup({ ...connected, state: '断开中', authorization: '等待重新确认账号权益',
      pauseReason: 'entitlement-denied', message: '后台权益校验未通过，网络正在暂停并恢复原网络设置。' })
    const primary = x.root.querySelector('[data-network-action="primary"]')
    const connect = x.advanced.querySelector('[data-network-action="连接通道"]')
    const pause = x.advanced.querySelector('[data-network-action="暂停使用"]')
    const repair = x.root.querySelector('[data-network-action="repair"]')
    expect(primary?.disabled).toBe(true)
    expect(connect?.disabled).toBe(true)
    expect(pause?.disabled).toBe(true)
    expect(repair?.disabled).toBe(true)
    expect(x.text().some((text) => text.includes('权益校验未通过，正在暂停网络'))).toBe(true)
    primary!.click(); connect!.click(); pause!.click(); repair!.click()
    await flush()
    expect(x.start).not.toHaveBeenCalled()
    expect(x.stop).not.toHaveBeenCalled()
    expect(x.repair).not.toHaveBeenCalled()
  })

  it('修复任务仍报告 running 时也以断开在途为准，主入口不能重复取消', async () => {
    const x = await setup({ ...connected, state: '断开中' }, { ...idleNetworkRepair, running: true,
      phase: 'restoring', outcome: 'running', message: '正在恢复原设置' })
    const primary = x.root.querySelector('[data-network-action="primary"]')
    expect(primary?.disabled).toBe(true)
    expect(x.text().some((text) => text.includes('正在断开网络'))).toBe(true)
    primary!.click()
    await flush()
    expect(x.stop).not.toHaveBeenCalled()
  })

  it('已登录账号在断开中也不能通过快捷或手动同步配置改写停止意图', async () => {
    const x = await setup({ ...connected, state: '断开中' }, idleNetworkRepair, true)
    const shortcut = x.root.querySelector('[data-network-action="同步配置"]')
    const manual = x.advanced.querySelector('[data-network-action="同步账号配置"]')
    expect(shortcut?.disabled).toBe(true)
    expect(manual?.disabled).toBe(true)
    shortcut!.click(); manual!.click()
    await flush()
    expect(x.syncAccountConfig).not.toHaveBeenCalled()
  })
})
