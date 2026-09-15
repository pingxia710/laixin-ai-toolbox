import { afterEach, expect, it, vi } from 'vitest'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import { idleNetworkRepair, type NetworkRepairStatus } from '../../app/shared/network-repair'

type Doc = { activeElement: Element | null; createElement: (tag: string) => Element; createTextNode: (text: string) => Element }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document

function matches(node: Element, selector: string): boolean {
  return selector.split(',').some((part) => {
    const rule = part.trim()
    if (rule.startsWith('.')) return node.className.split(' ').includes(rule.slice(1))
    // 折叠区靠 details[open] 在整页重建之间保留开合，假 DOM 得认这条才分辨得出真假。
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
  currentConfig: '版本 1', pendingConfig: '', canApplyPending: false, state: '已连', message: '', source: '', authorization: '', backend: '',
  nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: ''
}
const disconnected = { ...connected, state: '已停止并恢复原设置' }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(
  status = vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(connected),
  explainRoute = vi.fn().mockResolvedValue({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT', title: '受保护域名直连', detail: '匹配受保护直连规则。' })
) {
  vi.useFakeTimers()
  const start = vi.fn().mockResolvedValue({ outcome: 'rejected', message: '配置校验未通过，请联系客服。', code: 'fixture' })
  const repairStatus = vi.fn<() => Promise<NetworkRepairStatus>>().mockResolvedValue({ ...idleNetworkRepair })
  const repair = vi.fn().mockResolvedValue({ outcome: 'started', message: '正在修复', code: '' })
  const stop = vi.fn().mockResolvedValue({ outcome: 'stopped', message: '已取消', code: '' })
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (textContent: string) => Object.assign(new Element(), { textContent }) })
  const report = vi.fn<() => Promise<{ snapshot: string }>>().mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-7K3M-9QZP', uploaded: true, message: '已上报，回执号 LX-7K3M-9QZP。把它告诉客服即可。' }) })
  vi.stubGlobal('window', { toolbox: { tunnel: { status, start, explainRoute, repairStatus, repair, stop }, diagnostics: { report } } })
  const { page } = await import('../../app/renderer/src/pages/tunnel')
  const root = new Element(); page.mount(root as unknown as HTMLElement, { tab: 'tunnel' }); cleanup = page.unmount
  await flush()
  return { page, root, status, start, explainRoute, repairStatus, repair, stop, report, text: () => root.all().map((node) => node.textContent) }
}

it('修复中禁止重复触发，取消始终可用；重进页面按主进程状态恢复', async () => {
  const x = await setup()
  const running: NetworkRepairStatus = { ...idleNetworkRepair, running: true, phase: 'restoring', outcome: 'running', message: '正在恢复来信设置' }
  x.repairStatus.mockResolvedValue(running)
  x.root.querySelector('[data-network-action="repair"]')!.click()
  await flush()
  expect(x.repair).toHaveBeenCalledTimes(1)
  expect(x.root.querySelector('[data-network-action="repair"]')!.disabled).toBe(true)
  expect(x.text()).toContain('取消修复并断开')
  x.page.unmount()
  x.page.mount(x.root as unknown as HTMLElement, { tab: 'tunnel' })
  await flush()
  expect(x.text()).toContain('正在检测并修复连接')
  x.root.querySelector('[data-network-action="primary"]')!.click()
  await flush()
  expect(x.stop).toHaveBeenCalledTimes(1)
  x.repairStatus.mockResolvedValue({ ...running, running: false, phase: 'finished', outcome: 'cancelled', message: '已取消修复' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(x.root.querySelector('[data-network-action="repair"]')!.disabled).toBe(false)
  expect(x.text()).toContain('已取消修复')
})

it('修复状态读取失败不伪装成功，也不抹掉独立的网络状态', async () => {
  const x = await setup()
  x.repairStatus.mockRejectedValue(new Error('read-failed'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(x.text()).toContain('已连接')
  expect(x.text()).toContain('修复状态暂时读不到，请稍后刷新；不要把它当作已经修好。')
  expect(x.root.querySelector('[data-network-action="repair"]')!.disabled).toBe(true)
})

it('读取暂时失败后成功恢复，当前连接状态与错误提示一起更新', async () => {
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(connected))
  expect(x.text()).toContain('状态读取失败，请稍后重试。')
  await vi.advanceTimersByTimeAsync(2000)
  expect(x.text()).toContain('已连接')
  expect(x.text()).not.toContain('状态读取失败，请稍后重试。')
})

it('读取故障与操作拒绝分别保留；成功读取只清除读取故障', async () => {
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValueOnce(disconnected).mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(connected))
  x.root.all().find((node) => node.dataset.networkAction === 'primary')!.click(); await flush()
  expect(x.start).toHaveBeenCalledOnce()
  expect(x.text()).toContain('状态读取失败，请稍后重试。')
  expect(x.text()).toContain('配置校验未通过，请联系客服。')
  await vi.advanceTimersByTimeAsync(2000)
  expect(x.text()).not.toContain('状态读取失败，请稍后重试。')
  expect(x.text()).toContain('配置校验未通过，请联系客服。')
})

it.each(['success', 'failure'] as const)('较早轮询迟到的 %s 不能覆盖新一次确认的状态', async (outcome) => {
  let resolve!: (value: TunnelStatusView) => void
  let reject!: (reason: Error) => void
  const older = new Promise<TunnelStatusView>((done, fail) => { resolve = done; reject = fail })
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValueOnce(connected).mockReturnValueOnce(older).mockResolvedValue(disconnected))
  await vi.advanceTimersByTimeAsync(4000)
  expect(x.text()).toContain('已停止并恢复原设置')
  if (outcome === 'success') resolve(connected)
  else reject(new Error('late failure'))
  await flush()
  expect(x.text()).toContain('已停止并恢复原设置')
  expect(x.text()).not.toContain('已连接')
  expect(x.text()).not.toContain('状态读取失败，请稍后重试。')
})

it('分流说明仅将用户输入的域名传给受限桥，并显示内核判断边界', async () => {
  const x = await setup()
  const input = x.root.all().find((node) => node.dataset.networkRouteInput === 'true')!
  input.value = 'api.deepseek.com'; input.trigger('input')
  x.root.all().find((node) => node.dataset.networkAction === 'route-explain')!.click(); await flush()
  expect(x.explainRoute).toHaveBeenCalledWith('api.deepseek.com')
  expect(x.text()).toContain('受保护域名直连')
  expect(x.text().some((text) => text.includes('仅说明本机规则'))).toBe(true)
})

it('分流查询连续输入不丢焦点不丢内容；轮询重建后输入与光标保留', async () => {
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValueOnce(connected)
    .mockResolvedValue({ ...connected, lastVerifiedAt: '2026-09-12T00:00:00Z' }))
  const input = x.root.all().find((node) => node.dataset.networkRouteInput === 'true')!
  input.focus()
  for (const char of ['a', 'b', 'c']) { input.value += char; input.trigger('input') }
  expect(doc().activeElement).toBe(input)
  expect(input.value).toBe('abc')
  expect(x.root.all()).toContain(input)
  expect(x.root.all().find((node) => node.dataset.networkAction === 'route-explain')?.disabled).toBe(false)
  await vi.advanceTimersByTimeAsync(2000)
  const rebuilt = x.root.all().find((node) => node.dataset.networkRouteInput === 'true')!
  expect(rebuilt.value).toBe('abc')
  expect(doc().activeElement).toBe(rebuilt)
  expect(rebuilt.selectionStart).toBe(3)
  expect(rebuilt.selectionEnd).toBe(3)
})

it('分流查询迟到的结果不渲染到重新挂载后的页面', async () => {
  let answer!: (value: { outcome: string; reasonCode: string; title: string; detail: string }) => void
  const slow = new Promise<{ outcome: string; reasonCode: string; title: string; detail: string }>((resolve) => { answer = resolve })
  const x = await setup(undefined, vi.fn().mockReturnValue(slow))
  const input = x.root.all().find((node) => node.dataset.networkRouteInput === 'true')!
  input.value = 'api.openai.com'; input.trigger('input')
  x.root.all().find((node) => node.dataset.networkAction === 'route-explain')!.click()
  await flush()

  // 查询还没回来就切走再切回：新页面的输入框是空的，旧结论不能挂在上面。
  x.page.unmount?.()
  const next = new Element()
  x.page.mount(next as unknown as HTMLElement, { tab: 'tunnel' })
  await flush()
  answer({ outcome: 'proxy', reasonCode: 'RULE_HIT', title: '走通道', detail: '命中规则 openai.com。' })
  await flush()

  expect(next.all().find((node) => node.dataset.networkRouteInput === 'true')?.value).toBe('')
  expect(next.all().map((node) => node.textContent)).not.toContain('走通道')
  cleanup = x.page.unmount
})

it('分流说明与出口 IP 默认展开，出口 IP 直接显示在连接详情里', async () => {
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue({ ...connected, exitIp: '203.0.113.7' }))

  const extra = x.root.querySelectorAll('.network-extra')[0]
  expect(extra).toBeDefined()
  expect(extra.open).toBe(true)
  expect(extra.all().some((node) => node.dataset.networkRouteInput === 'true')).toBe(true)

  const details = x.root.querySelectorAll('.network-details')[0]
  expect(details.all().map((node) => node.textContent)).toContain('203.0.113.7')
  expect(x.text()).not.toContain('已隐藏，可在更多连接信息中查看')
})

it('一键上报：⛔ 自动发，只有点了按钮才发；发出去就把回执号摆在客户眼前', async () => {
  const x = await setup()
  // 挂载、轮询都过去了，⛔ 自己发过一次。
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.report).not.toHaveBeenCalled()

  // 按之前客户就看得到发的是什么
  expect(x.text().some((line) => line.includes('不含账号密码、Key、通道凭据，也不含你访问过的网址'))).toBe(true)
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.report).toHaveBeenCalledTimes(1)
  expect(x.text()).toContain('已上报，回执号 LX-7K3M-9QZP。把它告诉客服即可。')
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
})

it('一键上报没送出去：⛔ 谎称成功，回执号照给并指出诊断包落在哪', async () => {
  const x = await setup()
  x.report.mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-2D4F-8HTV', uploaded: false,
    filePath: '/Users/someone/Library/Application Support/toolbox/reports/LX-2D4F-8HTV.json',
    message: '这次没能送出去（回执号 LX-2D4F-8HTV）。诊断包已存在本机，把这个文件发给客服，效果一样。' }) })
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.text()).toContain('这次没能送出去（回执号 LX-2D4F-8HTV）。诊断包已存在本机，把这个文件发给客服，效果一样。')
  expect(x.text().some((line) => line.includes('reports/LX-2D4F-8HTV.json'))).toBe(true)
})

it('一键上报本身失败也不能把界面卡在忙碌态', async () => {
  const x = await setup()
  x.report.mockRejectedValue(new Error('ipc-failed'))
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.root.querySelector('[data-network-action="repair-report"]')!.disabled).toBe(false)
  expect(x.text()).toContain('操作未完成，请重试或重新导入来信配置包。')
})
