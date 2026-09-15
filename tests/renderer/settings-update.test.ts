import { afterEach, expect, it, vi } from 'vitest'
import type { UpdateView } from '../../app/desktop-types'

class Element {
  textContent = ''; className = ''; type = ''; id = ''; htmlFor = ''; value = ''
  disabled = false; hidden = false; checked = false; max = 0; open = false
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly children: Element[] = []
  private handlers = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children.splice(0, this.children.length, ...children) }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  click() { if (!this.disabled) this.handlers.get('click')?.forEach((handler) => handler()) }
  change() { this.handlers.get('change')?.forEach((handler) => handler()) }
  showModal() { this.open = true }
  close() { this.open = false; this.handlers.get('close')?.forEach((handler) => handler()) }
  remove() {}
  querySelector<T extends Element>(selector: string): T | null {
    const className = selector.startsWith('.') ? selector.slice(1) : ''
    return (this.all().find((node) => className !== '' && node.className.split(' ').includes(className)) ?? null) as T | null
  }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  label(): string { return this.children.map((child) => child.textContent).join('') }
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
let stop = (): void => undefined
afterEach(() => { stop(); vi.unstubAllGlobals(); vi.resetModules() })

const current: UpdateView = { state: 'current', version: '', notes: '', progress: 0, message: '当前已是最新可用版本。' }

async function mountSettings(desktop: Record<string, unknown>) {
  const body = new Element('body')
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    documentElement: { dataset: {} as Record<string, string | undefined> },
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
    body
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, setInterval, clearInterval,
    toolbox: {
      desktop: { status: async () => ({ preferences: { zoom: 1, quotaNotifications: true, autoUpdate: true }, backgroundAvailable: true, alerts: [], update: current }),
        // FB-1 新开关的缺省读数;个别用例可传入同名方法覆盖。
        failureReportEnabled: async () => ({ enabled: true, supported: true }), ...desktop },
      app: { info: async () => ({ version: '0.4.9' }) }
    }
  })
  const { page } = await import('../../app/renderer/src/pages/settings')
  const root = new Element('div')
  page.mount(root as unknown as HTMLElement, { tab: 'settings' } as never)
  stop = () => page.unmount?.()
  await flush()
  const find = (label: string) => root.all().find((node) => node.tag === 'button' && node.label() === label)!
  const findDialog = (label: string) => body.all().find((node) => node.tag === 'button' && node.label() === label)!
  return { root, body, find, findDialog, text: () => root.all().map((node) => node.textContent) }
}

// 桥本身失败时主进程没机会返回 error 视图，渲染层得自己把「检查更新」放开，
// 否则文案说「请重试」却要等 15 秒轮询才点得动（核实 C2）。
it('「检查更新」失败后按钮立即可点，与「请重试」文案一致', async () => {
  const checkUpdate = vi.fn(async () => { throw new Error('bridge unavailable') })
  const x = await mountSettings({ checkUpdate })

  const check = x.find('检查更新')
  expect(check.disabled).toBe(false)
  check.click()
  await flush()

  expect(checkUpdate).toHaveBeenCalledOnce()
  expect(x.text()).toContain('操作未完成，请重试。')
  expect(check.disabled).toBe(false)
})

it('下载进行中「检查更新」仍保持禁用，⛔ 被恢复逻辑放开', async () => {
  const available: UpdateView = { state: 'available', version: '0.5.2', notes: '修复\n\n• 更新弹窗', progress: 0, message: '发现新版 V0.52' }
  const downloading: UpdateView = { state: 'downloading', version: '0.5.0', notes: '', progress: 12, message: '正在下载新版' }
  const x = await mountSettings({ status: async () => ({ preferences: { zoom: 1, quotaNotifications: true, autoUpdate: true }, backgroundAvailable: true, alerts: [], update: available }), downloadUpdate: vi.fn(async () => downloading) })

  const check = x.find('检查更新')
  expect(x.body.all().some((node) => node.textContent === '发现新版本')).toBe(true)
  expect(x.body.all().some((node) => node.textContent === 'v0.5.2')).toBe(true)
  expect(x.body.all().some((node) => node.textContent === '修复\n\n• 更新弹窗')).toBe(true)
  x.findDialog('立即更新').click()
  await flush()

  expect(check.disabled).toBe(true)
})

// 常驻开关（0.5.0）：它的价值全在「意外退出也不断网」，所以渲染层三条要钉住——
// 读到什么就显示什么、保存失败要把开关拨回真实状态、文案 ⛔ 出现客户不认识的词。
it('常驻开关按主进程读回来的状态显示，保存失败要拨回真实状态并说「没保存成功」', async () => {
  const residentEnabled = vi.fn(async () => ({ enabled: true, supported: true, active: true }))
  // 客户关掉它，但常驻没撤掉：主进程照实回 supported=false、enabled 仍是 true
  const setResidentEnabled = vi.fn(async () => ({ enabled: true, supported: false, active: true }))
  const x = await mountSettings({ residentEnabled, setResidentEnabled })

  const row = x.root.all().find((node) => node.tag === 'label' && node.label().includes('工具箱意外退出时，网络不断'))!
  const toggle = row.children.find((child) => child.tag === 'input')!
  expect(toggle.checked).toBe(true)
  expect(x.text().some((line) => line.includes('工具箱意外退出时，网络不断'))).toBe(true)
  // ⛔ 把实现词摆给客户
  for (const jargon of ['常驻', '守护', 'LaunchAgent', '计划任务']) {
    expect(x.text().some((line) => line.includes(jargon)), `文案 ⛔ 出现「${jargon}」`).toBe(false)
  }

  toggle.checked = false
  toggle.change()
  await flush()

  expect(setResidentEnabled).toHaveBeenCalledWith({ enabled: false })
  expect(toggle.checked).toBe(true)
  expect(toggle.disabled).toBe(false)
  expect(x.text().some((line) => line.includes('没有保存成功'))).toBe(true)
})

it('这台机器用不了时开关置灰并说明，⛔ 让客户点了没反应', async () => {
  const x = await mountSettings({ residentEnabled: async () => ({ enabled: false, supported: false, active: false }) })
  expect(x.text().some((line) => line.includes('当前安装暂不支持这项设置。'))).toBe(true)
})

// 0.4.10 的开机自启就坏在这个形状上：控件创建时是禁用的，只有读成功那一支解禁，
// catch 那一支只改文案。读一失败就永久点不了，而文案写着「暂时」——没人会发现。
it('读状态失败后跟着轮询自己恢复，⛔ 把开关永久留在禁用态', async () => {
  vi.useFakeTimers()
  let failing = true
  const residentEnabled = vi.fn(async () => {
    if (failing) throw new Error('bridge unavailable')
    return { enabled: true, supported: true, active: true }
  })
  // 开机自启读成功，这样页面上任何「正在重试」都只可能来自本条开关
  const x = await mountSettings({ residentEnabled, loginItem: async () => ({ enabled: false, supported: true }) })

  const row = x.root.all().find((node) => node.tag === 'label' && node.label().includes('工具箱意外退出时，网络不断'))!
  const toggle = row.children.find((child) => child.tag === 'input')!
  // 读失败期间：开关还锁着，但文案说明在重试（⛔ 说成「暂时无法读取」然后再也不试）
  expect(toggle.disabled).toBe(true)
  expect(x.text().some((line) => line.includes('正在重试'))).toBe(true)
  // 正向证据：确实读过，⛔ 只是「没红」
  const whileFailing = residentEnabled.mock.calls.length
  expect(whileFailing).toBeGreaterThan(0)

  failing = false
  await vi.advanceTimersByTimeAsync(20_000)
  await flush()
  vi.useRealTimers()

  // 正向证据：轮询确实又读了一次，而且开关真的解锁并拿到了真实状态
  expect(residentEnabled.mock.calls.length).toBeGreaterThan(whileFailing)
  expect(toggle.disabled).toBe(false)
  expect(toggle.checked).toBe(true)
  expect(x.text().some((line) => line.includes('正在重试'))).toBe(false)
})

// 缩放 / 额度提醒 / 自动更新三项跟两个开关是同一个坏法：创建时禁用，原来只有首次 status()
// 成功那一支解禁，失败就永久禁用、轮询也不补。
it('首次读设置失败后，缩放/提醒/自动更新跟着轮询恢复可用，⛔ 永久禁用', async () => {
  vi.useFakeTimers()
  let failing = true
  const status = vi.fn(async () => {
    if (failing) throw new Error('bridge unavailable')
    return { preferences: { zoom: 1.25, quotaNotifications: false, autoUpdate: true }, backgroundAvailable: true, alerts: [], update: current }
  })
  const x = await mountSettings({ status, loginItem: async () => ({ enabled: false, supported: true }), residentEnabled: async () => ({ enabled: true, supported: true, active: true }) })

  const zoom = x.root.all().find((node) => node.id === 'zoom-select')!
  const auto = x.root.all().find((node) => node.id === 'auto-update')!
  expect(zoom.disabled).toBe(true)
  expect(auto.disabled).toBe(true)
  expect(x.text().some((line) => line.includes('正在重试'))).toBe(true)
  const whileFailing = status.mock.calls.length
  expect(whileFailing).toBeGreaterThan(0) // 正向证据：确实读过，⛔ 只是没红

  failing = false
  await vi.advanceTimersByTimeAsync(20_000)
  await flush()
  vi.useRealTimers()

  expect(status.mock.calls.length).toBeGreaterThan(whileFailing)
  expect(zoom.disabled).toBe(false)
  expect(auto.disabled).toBe(false)
  // 恢复那一次要把后台真实的值也带上来，⛔ 只解禁不填值（客户会对着错的值以为那就是当前设置）
  expect(zoom.value).toBe('1.25')
  expect(auto.checked).toBe(true)
})

// 自愈那一改带来的新窗口：轮询「只要还锁着就补一次」，而保存进行中三项**正是锁着的**。
// 没有 saving 闸的话，保存途中来一轮轮询就会提前解禁，并且拿后台还没更新的旧值
// 把客户刚改的选择盖回去——客户会看到自己改的东西自己弹回去。
it('保存途中的轮询 ⛔ 提前解禁，也 ⛔ 拿后台旧值盖掉客户刚改的选择', async () => {
  vi.useFakeTimers()
  let release: () => void = () => undefined
  const configure = vi.fn(async () => {
    await new Promise<void>((resolve) => { release = resolve })
    return { preferences: { zoom: 1.5, quotaNotifications: true, autoUpdate: true }, backgroundAvailable: true, alerts: [], update: current }
  })
  // 后台这一侧还是旧值：保存还没落地，轮询读到的就是 1
  const status = vi.fn(async () => ({ preferences: { zoom: 1, quotaNotifications: true, autoUpdate: true }, backgroundAvailable: true, alerts: [], update: current }))
  const x = await mountSettings({ status, configure, loginItem: async () => ({ enabled: false, supported: true }), residentEnabled: async () => ({ enabled: true, supported: true, active: true }) })

  const zoom = x.root.all().find((node) => node.id === 'zoom-select')!
  expect(zoom.disabled).toBe(false) // 正向证据：初次读成功、已解禁
  zoom.value = '1.5'
  zoom.change()
  await flush()
  expect(configure).toHaveBeenCalledTimes(1) // 正向证据：保存确实开始了，而且还悬着
  expect(zoom.disabled).toBe(true)

  await vi.advanceTimersByTimeAsync(20_000)
  await flush()
  expect(status.mock.calls.length).toBeGreaterThan(1) // 正向证据：轮询确实又跑了一轮

  expect(zoom.disabled).toBe(true)
  expect(zoom.value).toBe('1.5')

  release()
  await flush()
  vi.useRealTimers()
  expect(zoom.disabled).toBe(false)
})

// 客户选了开、但常驻这次没装上：开关显示着开而那件事并没有发生 —— 就是假装成功。
// 主进程那一侧已经如实回了 active=false，界面这一侧不能把它又装回去（只写日志等于
// 把诚实停在没人看得见的地方）。
it('选了开但没生效：说出来，⛔ 把开关拨回去、⛔ 弹窗', async () => {
  const x = await mountSettings({
    residentEnabled: async () => ({ enabled: true, supported: true, active: false }),
    loginItem: async () => ({ enabled: false, supported: true })
  })
  const row = x.root.all().find((node) => node.tag === 'label' && node.label().includes('工具箱意外退出时，网络不断'))!
  const toggle = row.children.find((child) => child.tag === 'input')!

  // 开关留在客户选的那一档，也没被置灰（拨回去 = 替客户改了他的选择，比静默失败更糟）
  expect(toggle.checked).toBe(true)
  expect(toggle.disabled).toBe(false)
  expect(x.text().some((line) => line.includes('这次没能生效'))).toBe(true)
  expect(x.text().some((line) => line.includes('网络本身不受影响'))).toBe(true)
  // 正向证据：默认那句「打开后……网络都照常连着」不能同时还挂着，否则两句话互相打架
  expect(x.text().some((line) => line.includes('网络都照常连着'))).toBe(false)
})

it('装上了就不提这一句（⛔ 一直挂着一句吓人的话）', async () => {
  const x = await mountSettings({
    residentEnabled: async () => ({ enabled: true, supported: true, active: true }),
    loginItem: async () => ({ enabled: false, supported: true })
  })
  expect(x.text().some((line) => line.includes('网络都照常连着'))).toBe(true) // 正向证据：常驻那段确实渲染了
  expect(x.text().some((line) => line.includes('这次没能生效'))).toBe(false)
})
