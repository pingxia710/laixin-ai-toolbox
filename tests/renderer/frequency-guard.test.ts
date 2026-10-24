import { afterEach, expect, it, vi } from 'vitest'

class Element {
  textContent = ''; className = ''; type = ''; disabled = false; hidden = false; value = ''
  readonly style: Record<string, string> = {}
  readonly children: Element[] = []
  private handlers = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children.splice(0, this.children.length, ...children) }
  setAttribute(name: string) { void name }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  click() { if (!this.disabled) this.handlers.get('click')?.forEach((handler) => handler()) }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

const stubDom = (overrides: Record<string, unknown> = {}) => {
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    documentElement: { dataset: {} as Record<string, string | undefined> },
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    ...overrides
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, toolbox: {} })
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

const mountDeviceReportUi = async (state: () => string, onSend?: () => void) => {
  const deviceReportStatus = vi.fn(async () => ({
    state: state(),
    message: state() === 'syncing' ? '正在发送基本电脑配置…'
      : state() === 'synced' ? '已发送给来信客服（回执号 DR-XXXX-XXXX，2026/9/15 12:00:00）。'
      : state() === 'failed' ? '基本电脑配置发送未完成，可重试；你也可以继续使用工具箱。'
      : '基本电脑配置尚未发送。'
  }))
  const sendDeviceReport = vi.fn(async () => { onSend?.(); return { state: 'syncing', message: '正在发送基本电脑配置…' } })
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, toolbox: { account: { deviceReportStatus, sendDeviceReport } } })
  const { mountDeviceReport } = await import('../../app/renderer/src/ui/device-report')
  const root = new Element('div')
  const stop = mountDeviceReport(root as unknown as HTMLElement)
  const text = () => root.all().map((el) => el.textContent).join()
  const button = () => root.all().find((el) => el.tag === 'button')!
  return { stop, text, button, deviceReportStatus, sendDeviceReport }
}

it('客服协助:未发送明示“尚未发送”,点击发送才上报,连点只发一次,回执后停轮询', async () => {
  vi.useFakeTimers()
  stubDom()
  let state = 'local'
  const ui = await mountDeviceReportUi(() => state, () => { state = 'syncing' })
  await vi.advanceTimersByTimeAsync(0)
  expect(ui.deviceReportStatus).toHaveBeenCalledTimes(1)
  expect(ui.text()).toContain('尚未发送')
  expect(ui.button().disabled).toBe(false)

  ui.button().click(); ui.button().click()
  await vi.advanceTimersByTimeAsync(0)
  expect(ui.sendDeviceReport).toHaveBeenCalledTimes(1)
  expect(ui.text()).toContain('正在发送')

  await vi.advanceTimersByTimeAsync(10_000)
  const callsWhileSyncing = ui.deviceReportStatus.mock.calls.length
  expect(callsWhileSyncing).toBeGreaterThan(1)
  expect(ui.button().disabled).toBe(true)

  state = 'synced'
  await vi.advanceTimersByTimeAsync(2_000)
  await vi.advanceTimersByTimeAsync(10_000)
  const callsAfterTerminal = ui.deviceReportStatus.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(ui.deviceReportStatus.mock.calls.length).toBe(callsAfterTerminal)
  expect(ui.text()).toContain('回执')
  expect(ui.button().disabled).toBe(true)
  ui.stop()
})

it('发送失败时明示可重试且不说已发送,按钮可再次发送', async () => {
  vi.useFakeTimers()
  stubDom()
  const state = 'failed'
  const ui = await mountDeviceReportUi(() => state)
  await vi.advanceTimersByTimeAsync(0)
  expect(ui.text()).toContain('重试')
  expect(ui.text()).not.toContain('已发送')
  expect(ui.button().disabled).toBe(false)
  ui.button().click()
  await vi.advanceTimersByTimeAsync(0)
  expect(ui.sendDeviceReport).toHaveBeenCalledTimes(1)
  ui.stop()
})

it('二维码按付款数据记忆化:同一 data 复用同一 SVG,不再重复编码', async () => {
  stubDom()
  const { renderPaymentQr } = await import('../../app/renderer/src/subscription/view')
  const first = renderPaymentQr('weixin://wxpay/fixture-1')
  const again = renderPaymentQr('weixin://wxpay/fixture-1')
  const other = renderPaymentQr('weixin://wxpay/fixture-2')
  expect(again).toBe(first)
  expect(other).not.toBe(first)
})

it('设置页空闲 15 秒一查、下载中 1 秒一查、页面隐藏时暂停', async () => {
  vi.useFakeTimers()
  stubDom()
  let updateState = 'current'
  const status = vi.fn(async () => ({
    preferences: { zoom: 1, quotaNotifications: true, autoUpdate: true },
    backgroundAvailable: true, alerts: [],
    update: { state: updateState, version: '', notes: '', progress: 0, message: '当前已是最新可用版本。' }
  }))
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, toolbox: { desktop: { status, checkUpdate: async () => ({} as never), downloadUpdate: async () => ({} as never), installUpdate: async () => ({} as never), configure: async () => ({} as never) }, app: { info: async () => ({ version: '0.4.7' }) } } })
  const { page } = await import('../../app/renderer/src/pages/settings')
  const root = new Element('div')
  page.mount(root as unknown as HTMLElement, { tab: 'settings' } as never)
  await vi.advanceTimersByTimeAsync(0)
  const initialCalls = status.mock.calls.length
  await vi.advanceTimersByTimeAsync(14_000)
  expect(status.mock.calls.length - initialCalls).toBeLessThanOrEqual(1)
  await vi.advanceTimersByTimeAsync(16_000)
  const idleCalls = status.mock.calls.length

  updateState = 'downloading'
  await vi.advanceTimersByTimeAsync(15_000)
  const beforeFast = status.mock.calls.length
  await vi.advanceTimersByTimeAsync(3_000)
  expect(status.mock.calls.length - beforeFast).toBeGreaterThanOrEqual(2)

  stubDom({ visibilityState: 'hidden' })
  const beforeHidden = status.mock.calls.length
  await vi.advanceTimersByTimeAsync(30_000)
  expect(status.mock.calls.length).toBeGreaterThanOrEqual(beforeHidden)
  expect(idleCalls).toBeGreaterThan(initialCalls)
  page.unmount?.()
})
