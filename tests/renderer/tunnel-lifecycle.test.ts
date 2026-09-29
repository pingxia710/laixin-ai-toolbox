import { afterEach, expect, it, vi } from 'vitest'
import { unknownLocalEgressEvidence } from '../../app/shared/local-egress-evidence'
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
  pauseReason: '',
  currentConfig: '版本 1', pendingConfig: '', canApplyPending: false, state: '已连', message: '', source: '', authorization: '', backend: '',
  nodeLabel: '', exitIp: '', pathSource: '' as const, lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false, unrestored: '', componentMissing: ''
}
const disconnected = { ...connected, state: '已停止并恢复原设置' }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
let cleanup = () => undefined as void
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function setup(
  status = vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(connected),
  explainRoute = vi.fn().mockResolvedValue({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT', title: '受保护域名直连', detail: '匹配受保护直连规则。' }),
  withDiagnosticSession = true
) {
  vi.useFakeTimers()
  const start = vi.fn().mockResolvedValue({ outcome: 'rejected', message: '配置校验未通过，请联系客服。', code: 'fixture' })
  const repairStatus = vi.fn<() => Promise<NetworkRepairStatus>>().mockResolvedValue({ ...idleNetworkRepair })
  const repair = vi.fn().mockResolvedValue({ outcome: 'started', message: '正在修复', code: '' })
  const stop = vi.fn().mockResolvedValue({ outcome: 'stopped', message: '已取消', code: '' })
  vi.stubGlobal('document', { activeElement: null, createElement: (tag: string) => Object.assign(new Element(), { tag }), createTextNode: (textContent: string) => Object.assign(new Element(), { textContent }) })
  const copy = vi.fn<(_params: { id: string }) => Promise<{ snapshot: string }>>().mockResolvedValue({ snapshot: JSON.stringify({ copied: true }) })
  const diagnostic = async ({ software }: { software: string }) => ({
    snapshot: JSON.stringify({ id: 'DG-FEDCBA-654321', software, text: '本次诊断', collectedAt: new Date().toISOString(),
      errors: [], faults: [], network: { software, checkedAt: Date.now() },
      localEgress: unknownLocalEgressEvidence(process.platform, Date.now()),
      attempts: [], attemptsTotal: 0, attemptsComplete: true })
  })
  const run = vi.fn<(_params: { software: string }) => Promise<{ snapshot: string }>>().mockImplementation(diagnostic)
  const runForReport = vi.fn<(_params: { software: string }) => Promise<{ snapshot: string }>>().mockImplementation(diagnostic)
  const report = vi.fn<(_params: { id: string }) => Promise<{ snapshot: string }>>().mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-7K3M-9QZP', uploaded: true, message: '已上报，回执号 LX-7K3M-9QZP。把它告诉客服即可。' }) })
  const reportIncomplete = vi.fn<(_params: { software: string }) => Promise<{ snapshot: string }>>().mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-7K3M-9QZP', uploaded: true, message: '已上报，回执号 LX-7K3M-9QZP。把它告诉客服即可。' }) })
  vi.stubGlobal('window', { toolbox: { tunnel: { status, start, explainRoute, repairStatus, repair, stop }, diagnostics: { run, runForReport, copy, report, reportIncomplete } } })
  if (withDiagnosticSession) {
    const { rememberDiagnosticSession } = await import('../../app/renderer/src/diagnostic-session')
    rememberDiagnosticSession({ id: 'DG-ABCDEF-123456', software: 'codex', checkedAt: Date.now() })
  }
  const { page } = await import('../../app/renderer/src/pages/tunnel')
  const root = new Element(); page.mount(root as unknown as HTMLElement, { tab: 'tunnel' }); cleanup = page.unmount
  await flush()
  return { page, root, status, start, explainRoute, repairStatus, repair, stop, run, runForReport, copy, report, reportIncomplete,
    text: () => root.all().map((node) => node.textContent) }
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

it('通道异常时主按钮直接启动修复，不把重新连接当作主动作', async () => {
  const broken = { ...connected, state: '异常', message: '原网络设置已恢复，但后台通道未能停止' }
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(broken))
  expect(x.text()).toContain('检测并修复连接')
  x.root.querySelector('[data-network-action="primary"]')!.click()
  await flush()
  expect(x.repair).toHaveBeenCalledOnce()
  expect(x.start).not.toHaveBeenCalled()
})

it.each([
  ['来信出口', 'laixin', '203.0.113.8'],
  ['复用现有外网', 'reused', '']
] as const)('%s 健康连接仅遇账号后台暂不可达时收起醒目告警，详情仍保留降级', async (_route, pathSource, exitIp) => {
  const notice = '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验'
  const continued: TunnelStatusView = {
    ...connected, message: notice, authorization: '本地配置有效期内，等待重新核验',
    backend: '后台暂不可达，按本地有效期继续',
    lastVerifiedAt: new Date().toISOString(), exitIp, pathSource,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(continued))
  expect(x.text()).toContain(pathSource === 'reused' ? '网络可用' : '已连接')
  expect(x.root.querySelectorAll('.network-feedback').flatMap((node) => node.all().map((child) => child.textContent))).not.toContain(notice)
  const details = x.root.querySelectorAll('.network-extra')[0]
  expect(details.all().map((node) => node.textContent)).toContain(continued.authorization)
  expect(details.all().map((node) => node.textContent)).toContain(continued.backend)
})

it.each([
  ['过期', -91_000],
  ['未来', 60_000]
] as const)('最近复验时间戳%s时，账号后台告警仍应醒目可见', async (_case, offset) => {
  const now = Date.now()
  const notice = '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验'
  const continued: TunnelStatusView = {
    ...connected, message: notice, authorization: '本地配置有效期内，等待重新核验',
    backend: '后台暂不可达，按本地有效期继续',
    lastVerifiedAt: new Date(now + offset).toISOString(), exitIp: '203.0.113.8', pathSource: 'laixin',
    expiresAt: new Date(now + 120_000).toISOString()
  }
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(continued))
  expect(x.root.querySelectorAll('.network-feedback').flatMap((node) => node.all().map((child) => child.textContent))).toContain(notice)
})

it('守护仍报告已连但复验停滞跨过 90 秒时，轮询应重新显示账号后台告警', async () => {
  const now = Date.now()
  const notice = '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验'
  const continued: TunnelStatusView = {
    ...connected, message: notice, authorization: '本地配置有效期内，等待重新核验',
    backend: '后台暂不可达，按本地有效期继续',
    lastVerifiedAt: new Date(now - 89_000).toISOString(), exitIp: '203.0.113.8', pathSource: 'laixin',
    expiresAt: new Date(now + 120_000).toISOString()
  }
  const x = await setup(vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValue(continued))
  const feedback = () => x.root.querySelectorAll('.network-feedback').flatMap((node) => node.all().map((child) => child.textContent))
  expect(feedback()).not.toContain(notice)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(feedback()).toContain(notice)
})

it('掉线、过期或代理未恢复时仍醒目提示，普通连接告警也不被误收起', async () => {
  const notice = '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验'
  const base: TunnelStatusView = {
    ...connected, message: notice, authorization: '本地配置有效期内，等待重新核验',
    backend: '后台暂不可达，按本地有效期继续',
    lastVerifiedAt: new Date().toISOString(), exitIp: '203.0.113.8', pathSource: 'laixin',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }
  const status = vi.fn<() => Promise<TunnelStatusView>>().mockResolvedValueOnce({ ...base, state: '异常' })
    .mockResolvedValueOnce({ ...base, expiresAt: new Date(Date.now() - 1_000).toISOString() })
    .mockResolvedValueOnce({ ...base, unrestored: 'WinINET/ProxyServer 未恢复' })
    .mockResolvedValueOnce({ ...base, message: '出口复验失败' })
  const x = await setup(status)
  for (const expected of [notice, notice, notice]) {
    expect(x.root.querySelectorAll('.network-feedback').flatMap((node) => node.all().map((child) => child.textContent))).toContain(expected)
    await vi.advanceTimersByTimeAsync(2000)
  }
  expect(x.root.querySelectorAll('.network-feedback').flatMap((node) => node.all().map((child) => child.textContent))).toContain('出口复验失败')
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
  // N-26:暂停落定态(已停止并恢复原设置)的状态卡文案是「已暂停使用」。
  expect(x.text()).toContain('已暂停使用')
  if (outcome === 'success') resolve(connected)
  else reject(new Error('late failure'))
  await flush()
  expect(x.text()).toContain('已暂停使用')
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
  expect(x.runForReport).not.toHaveBeenCalled()
  expect(x.report).not.toHaveBeenCalled()

  // 按之前客户就看得到发的是什么
  expect(x.text().some((line) => line.includes('可能包含账号/设备编号、出口 IP'))).toBe(true)
  expect(x.text().some((line) => line.includes('仍可能保留部分地址'))).toBe(true)
  expect(x.text().some((line) => line.includes('不含你访问过的网址'))).toBe(false)
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.runForReport).toHaveBeenCalledExactlyOnceWith({ software: 'codex' })
  expect(x.run).not.toHaveBeenCalled()
  expect(x.report).toHaveBeenCalledTimes(1)
  expect(x.report).toHaveBeenCalledWith({ id: 'DG-FEDCBA-654321' })
  expect(x.text()).toContain('已上报，回执号 LX-7K3M-9QZP。把它告诉客服即可。')
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
})

it('网络页首次直接复制和上报，不要求客户先去另一页生成诊断编号', async () => {
  const x = await setup(undefined, undefined, false)
  x.root.querySelector('[data-network-action="repair-copy"]')!.click()
  await flush()
  expect(x.copy).toHaveBeenCalledWith({ id: '' })
  expect(x.text()).toContain('当前网络信息已复制，可粘贴给来信客服。')

  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.runForReport).toHaveBeenCalledExactlyOnceWith({ software: 'codex' })
  expect(x.report).toHaveBeenCalledWith({ id: 'DG-FEDCBA-654321' })
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
})

it('客户选 Claude Code 时重新诊断 Claude；旧 Codex 快照不能冒充本次结果', async () => {
  const x = await setup()
  const select = x.root.querySelector('[data-network-action="repair-report-software"]')!
  expect(select.value).toBe('codex')
  select.value = 'claude'
  select.trigger('change')
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.runForReport).toHaveBeenCalledExactlyOnceWith({ software: 'claude' })
  expect(x.report).toHaveBeenCalledExactlyOnceWith({ id: 'DG-FEDCBA-654321' })
  expect(x.report).not.toHaveBeenCalledWith({ id: 'DG-ABCDEF-123456' })
})

it('本次诊断抛错后仍报当前状态日志，界面明示五项诊断未完成', async () => {
  const x = await setup()
  x.runForReport.mockRejectedValue(new Error('fixture diagnosis failed'))
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.reportIncomplete).toHaveBeenCalledExactlyOnceWith({ software: 'codex' })
  expect(x.report).not.toHaveBeenCalled()
  expect(x.text().some((line) => line.includes('本次诊断未完成'))).toBe(true)
})

it('另一页面同软件检查仍卡住时，报障不等旧结果且保留所选软件和本机报告', async () => {
  const x = await setup()
  const select = x.root.querySelector('[data-network-action="repair-report-software"]')!
  select.value = 'hermes'; select.trigger('change')
  x.runForReport.mockRejectedValue(new Error('ACTION_FAILED'))
  x.reportIncomplete.mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-2D4F-8HTV', uploaded: false,
    filePath: '/tmp/reports/LX-2D4F-8HTV.json', message: '本机已保存当次状态与日志。' }) })
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.runForReport).toHaveBeenCalledExactlyOnceWith({ software: 'hermes' })
  expect(x.report).not.toHaveBeenCalled()
  expect(x.reportIncomplete).toHaveBeenCalledExactlyOnceWith({ software: 'hermes' })
  expect(x.root.querySelector('[data-receipt="LX-2D4F-8HTV"]')).toBeDefined()
  expect(x.text().some((line) => line.includes('本次诊断未完成'))).toBe(true)
})

it('报障期间切离再返回，旧任务只提交一次且完成后回执仍可见', async () => {
  const x = await setup()
  let finish!: (value: { snapshot: string }) => void
  x.runForReport.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  x.page.unmount()
  x.page.mount(x.root as unknown as HTMLElement, { tab: 'tunnel' })
  await flush()
  const trigger = x.root.querySelector('[data-network-action="repair-report"]')!
  expect(trigger.disabled).toBe(true)
  trigger.click()
  expect(x.runForReport).toHaveBeenCalledTimes(1)
  finish({ snapshot: JSON.stringify({ id: 'DG-FEDCBA-654321', software: 'codex', text: '本次诊断',
    collectedAt: new Date().toISOString(), errors: [], faults: [], network: { software: 'codex', checkedAt: Date.now() },
    localEgress: unknownLocalEgressEvidence(process.platform, Date.now()),
    attempts: [], attemptsTotal: 0, attemptsComplete: true }) })
  await flush()
  expect(x.report).toHaveBeenCalledExactlyOnceWith({ id: 'DG-FEDCBA-654321' })
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
})

it('Claude 报障回执跨重挂载保留时，旁边的软件选择仍是 Claude', async () => {
  const x = await setup()
  const select = x.root.querySelector('[data-network-action="repair-report-software"]')!
  select.value = 'claude'; select.trigger('change')
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
  x.page.unmount()
  x.page.mount(x.root as unknown as HTMLElement, { tab: 'tunnel' })
  await flush()
  expect(x.root.querySelector('[data-network-action="repair-report-software"]')!.value).toBe('claude')
  expect(x.root.querySelector('[data-receipt="LX-7K3M-9QZP"]')).toBeDefined()
})

it('本次诊断超时也保留报障入口，旧诊断不进入报告', async () => {
  const x = await setup()
  x.runForReport.mockImplementation(() => new Promise(() => undefined))
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.root.querySelector('[data-network-action="repair-report"]')!.disabled).toBe(true)
  expect(x.report).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(30_000)
  await flush()
  expect(x.reportIncomplete).toHaveBeenCalledExactlyOnceWith({ software: 'codex' })
  expect(x.report).not.toHaveBeenCalled()
  expect(x.text().some((line) => line.includes('本次诊断未完成'))).toBe(true)
})

it('诊断后状态在打包前改变时改报即时状态，不把过期诊断带进包', async () => {
  const x = await setup()
  x.report.mockResolvedValueOnce({ snapshot: JSON.stringify({ uploaded: false, stale: true, message: '诊断已失效' }) })
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.report).toHaveBeenNthCalledWith(1, { id: 'DG-FEDCBA-654321' })
  expect(x.reportIncomplete).toHaveBeenCalledExactlyOnceWith({ software: 'codex' })
  expect(x.text().some((line) => line.includes('本次诊断未完成'))).toBe(true)
})

it('再次点击上报会重新检查并改用第二次的诊断编号', async () => {
  const x = await setup()
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  x.runForReport.mockResolvedValueOnce({ snapshot: JSON.stringify({ id: 'DG-123456-ABCDEF', software: 'codex', text: '第二次诊断',
    collectedAt: new Date().toISOString(), errors: [], faults: [], network: { software: 'codex', checkedAt: Date.now() },
    localEgress: unknownLocalEgressEvidence(process.platform, Date.now()),
    attempts: [], attemptsTotal: 0, attemptsComplete: true }) })
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.runForReport).toHaveBeenCalledTimes(2)
  expect(x.report).toHaveBeenNthCalledWith(2, { id: 'DG-123456-ABCDEF' })
})

it('网络页首次上报没送达时，仍显示同一个回执号和本机文件', async () => {
  const x = await setup(undefined, undefined, false)
  x.report.mockResolvedValue({ snapshot: JSON.stringify({ receipt: 'LX-2D4F-8HTV', uploaded: false,
    filePath: '/tmp/reports/LX-2D4F-8HTV.json', message: '这次没能送出去（回执号 LX-2D4F-8HTV）。诊断包已存在本机。' }) })
  x.root.querySelector('[data-network-action="repair-report"]')!.click()
  await flush()
  expect(x.report).toHaveBeenCalledWith({ id: 'DG-FEDCBA-654321' })
  expect(x.root.querySelector('[data-receipt="LX-2D4F-8HTV"]')).toBeDefined()
  expect(x.text().some((line) => line.includes('/tmp/reports/LX-2D4F-8HTV.json'))).toBe(true)
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
  expect(x.text()).toContain('上报未完成，请重试；若本次检查失败，诊断结果也未生成。')
})
