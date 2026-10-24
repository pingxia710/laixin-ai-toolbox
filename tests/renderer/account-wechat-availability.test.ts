import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms, WechatPanelMode } from '../../app/account-types'
import { accountAction, finishAccountNavigation } from '../../app/renderer/src/account-state'

const state = vi.hoisted(() => ({ view: null as unknown, onMode: undefined as ((mode: WechatPanelMode) => void) | undefined,
  onPanelError: undefined as (() => void) | undefined, notify: undefined as ((view: AccountView) => void) | undefined }))
vi.mock('../../app/renderer/src/account-state', () => ({
  accountAction: vi.fn(), cancelAccountNavigation: vi.fn(), finishAccountNavigation: vi.fn(), refreshAccount: vi.fn(),
  takeAccountEntryMode: () => 'login',
  onAccountChange: (listener: (view: AccountView) => void) => { state.notify = listener; listener(state.view as AccountView); return () => { state.notify = undefined } }
}))
vi.mock('../../app/renderer/src/ui/account-overview', () => ({
  mountAccountOverview: vi.fn(),
  actionButton: (label: string, action: () => void, primary = false) => {
    const button = document.createElement('button'); button.textContent = label; button.className = primary ? 'primary-action' : 'secondary-action'; button.addEventListener('click', action); return button
  },
  textNode: (tag: string, text: string, className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node
  }
}))
vi.mock('../../app/renderer/src/ui/account-security', () => ({ mountAccountSecurity: vi.fn() }))
vi.mock('../../app/renderer/src/ui/wechat-login-panel', () => ({ mountWechatLoginPanel: (_slot: unknown, onError: () => void, onMode: (mode: WechatPanelMode) => void) => { state.onMode = onMode; state.onPanelError = onError; return () => undefined } }))
vi.mock('../../app/renderer/src/ui/device-report', () => ({ mountDeviceReport: () => () => undefined }))
vi.mock('../../app/renderer/src/ui/account-services', () => ({ mountAccountServices: vi.fn() }))
vi.mock('../../app/renderer/src/support-widget', () => ({ revealSupport: vi.fn() }))
vi.mock('../../app/commercial-copy', () => ({ inviteFieldHint: () => '' }))

class Element {
  textContent = ''; className = ''; type = ''; name = ''; value = ''; id = ''; autocomplete = ''; required = false; disabled = false
  readOnly = false; rows = 0; minLength = 0; maxLength = 0; checked = false; isConnected = true
  scrollIntoView = vi.fn()
  dataset: Record<string, string> = {}; children: Element[] = []; parentElement: Element | null = null
  private handlers = new Map<string, Array<(event: { preventDefault(): void }) => void>>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren(...children: Element[]) { for (const child of this.all().slice(1)) child.isConnected = false; this.children = []; this.append(...children) }
  after(...nodes: Element[]) {
    if (!this.parentElement) return
    const index = this.parentElement.children.indexOf(this)
    for (const node of nodes) node.parentElement = this.parentElement
    this.parentElement.children.splice(index + 1, 0, ...nodes)
  }
  setAttribute() {}
  addEventListener(event: string, handler: (event: { preventDefault(): void }) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  dispatch(event: string) { if (!this.disabled) for (const handler of this.handlers.get(event) ?? []) handler({ preventDefault() {} }) }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  focus() {}; select() {}; close() {}; remove() {}; showModal() {}
}

vi.stubGlobal('document', {
  createElement: (tag: string) => new Element(tag),
  createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  body: new Element('body')
})
beforeEach(() => {
  let complete: ((response: { snapshot: string; recoveryCode: string }) => void) | undefined
  vi.stubGlobal('window', { toolbox: { account: {
    wechatInlineLogin: vi.fn(() => new Promise((resolve) => { complete = resolve })),
    cancelWechatLogin: vi.fn(async () => { complete?.({ snapshot: JSON.stringify(guest(true)), recoveryCode: '' }); complete = undefined; return { cancelled: true } })
  } } })
  vi.mocked(accountAction).mockImplementation(async (action) => JSON.parse((await action()).snapshot) as AccountView)
})

const terms = (wechatLoginAvailable?: boolean): CommercialTerms => ({
  plans: [], toolbox: { id: 'toolbox', priceCents: 1990, subject: '来信 AI 工具箱' },
  trial: { bytes: 5 * 1024 ** 3, hours: 48, perAccount: 1 }, deviceLimit: 3,
  ...(wechatLoginAvailable === undefined ? {} : { wechatLoginAvailable })
})

const guest = (wechatLoginAvailable?: boolean): AccountView => ({
  state: 'signed-out', code: '', message: '', terms: terms(wechatLoginAvailable), account: null, overview: null
})

const signedIn = (available: boolean, bound?: boolean): AccountView => ({
  state: 'signed-in', code: '', message: '', terms: terms(available),
  account: { id: `acct_${'2'.repeat(32)}`, username: 'fixture' },
  overview: { trial: { available: false, usage: null }, recoveryReady: true, subscription: null,
    plans: [], networkAvailable: true, paymentChannels: [], ...(bound === undefined ? {} : { wechatBound: bound }) }
})

async function render(view: AccountView): Promise<Element> {
  state.view = view
  const { page } = await import('../../app/renderer/src/pages/account')
  const root = new Element('section')
  page.mount(root as unknown as HTMLElement, { tab: 'account' })
  return root
}

afterEach(async () => {
  const { page } = await import('../../app/renderer/src/pages/account')
  page.unmount?.()
  vi.clearAllMocks()
})

it('只在后台明确开启微信登录时显示扫码入口', async () => {
  const hasEntry = (root: Element) => root.all().some((node) => node.className === 'account-wechat-frame')
  expect(hasEntry(await render(guest()))).toBe(false)
  expect(hasEntry(await render(guest(false)))).toBe(false)
  expect(hasEntry(await render(guest(true)))).toBe(true)
})

it('登录时账密在左、微信在右，套餐在两种登录入口之后', async () => {
  const root = await render(guest(true))
  const columns = root.all().find((node) => node.className === 'account-login-columns')
  expect(columns).toBeDefined()
  const [credentials, wechat] = columns!.children
  expect(credentials.all().some((node) => node.name === 'username')).toBe(true)
  expect(credentials.all().some((node) => node.name === 'password')).toBe(true)
  expect(credentials.all().find((node) => node.type === 'submit')?.className).toBe('primary-action')
  expect(wechat.all().some((node) => node.className === 'account-wechat-frame')).toBe(true)
  expect(wechat.all().some((node) => node.tag === 'button' && node.textContent === '微信登录')).toBe(false)
  expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(1)
  expect(wechat.all().some((node) => node.tag === 'input')).toBe(false)
  expect(credentials.all().some((node) => node.textContent === '返回')).toBe(false)
  expect(root.all().find((node) => node.className === 'account-entry-heading')?.all().some((node) => node.textContent === '返回')).toBe(true)
  expect(root.all().findIndex((node) => node === wechat)).toBeLessThan(root.all().findIndex((node) => node.className.includes('account-entitlements')))
})

it('微信未开放时保留右侧说明和可用的账密表单', async () => {
  const root = await render(guest(false))
  const panel = root.all().find((node) => node.className === 'account-wechat-panel')
  expect(panel?.all().some((node) => node.textContent.includes('暂未开放微信登录'))).toBe(true)
  expect(root.all().find((node) => node.type === 'submit')?.disabled).toBe(false)
})

it('快捷确认和扫码状态使用对应标题，取消为弱化文本且切换不重启验证', async () => {
  const root = await render(guest(true))
  state.onMode?.('quick')
  expect(root.all().some(node => node.tag === 'h3' && node.textContent === '微信快捷登录')).toBe(true)
  state.onMode?.('qr')
  expect(root.all().some(node => node.tag === 'h3' && node.textContent === '微信扫码登录')).toBe(true)
  expect(root.all().find(node => node.textContent === '取消本次验证')?.className).toBe('account-text-action')
  expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(1)
})

it.each<WechatPanelMode>(['loading', 'quick', 'qr', 'confirm'])('微信 %s 状态不重复显示识别、扫码或首次注册说明', async (mode) => {
  const root = await render(guest(true))
  state.onMode?.(mode)
  const text = root.all().map(node => node.textContent).join('\n')
  for (const removed of ['已识别电脑微信', '首次使用可直接注册', '无需设置密码', '可扫码，也可使用电脑微信确认', '打开手机微信，扫一扫上方二维码', '请完成微信验证后的确认']) {
    expect(text).not.toContain(removed)
  }
  expect(root.all().some(node => node.className === 'account-wechat-frame')).toBe(true)
  expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(1)
})

it('去掉常驻说明后，微信加载失败和取消失败仍显示明确反馈', async () => {
  const root = await render(guest(true))
  state.onPanelError?.()
  expect(root.all().some(node => node.textContent === '微信登录暂时无法显示，请取消后刷新重试。')).toBe(true)
  vi.mocked(window.toolbox.account.cancelWechatLogin).mockResolvedValueOnce({ cancelled: false })
  root.all().find(node => node.textContent === '取消本次验证')!.dispatch('click')
  await vi.waitFor(() => expect(root.all().some(node => node.textContent === '暂未取消，请稍后重试。')).toBe(true))
  vi.mocked(window.toolbox.account.cancelWechatLogin).mockRejectedValueOnce(new Error('local fixture'))
  root.all().find(node => node.textContent === '取消本次验证')!.dispatch('click')
  await vi.waitFor(() => expect(root.all().some(node => node.textContent === '暂时无法取消，请稍后重试。')).toBe(true))
})

it('已登录时继续显示账号与权益，不显示登录选择栏', async () => {
  const root = await render(signedIn(true, true))
  expect(root.all().some((node) => node.className === 'account-login-columns')).toBe(false)
  expect(root.dataset.accountMode).toBe('overview')
})

it('同一账号页面退出登录后自动发起新二维码，取消或失败则不会自动重试', async () => {
  const root = await render(guest(true))
  expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(1)
  await window.toolbox.account.cancelWechatLogin()
  await vi.waitFor(() => {
    state.notify?.(guest(true))
    expect(root.all().some(node => node.textContent.includes('本次微信验证已结束'))).toBe(true)
  })
  await Promise.resolve()
  expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(1)
  state.notify?.(signedIn(true, true))
  state.notify?.(guest(true))
  await vi.waitFor(() => expect(window.toolbox.account.wechatInlineLogin).toHaveBeenCalledTimes(2))
  expect(root.all().some(node => node.textContent.includes('本次微信验证已结束'))).toBe(false)
})

it('进入和刷新微信登录时将扫码区带到可见位置，后台刷新不抢走滚动位置', async () => {
  const root = await render(guest(true))
  const slot = () => root.all().find(node => node.className === 'account-wechat-frame')!
  expect(slot().scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
  state.notify?.(guest(true)); await Promise.resolve()
  expect(slot().scrollIntoView).not.toHaveBeenCalled()
  await window.toolbox.account.cancelWechatLogin()
  await vi.waitFor(() => {
    state.notify?.(guest(true))
    expect(root.all().some(node => node.textContent === '刷新二维码')).toBe(true)
  })
  root.all().find(node => node.textContent === '刷新二维码')!.dispatch('click')
  await Promise.resolve()
  expect(slot().scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
})

it('等待微信时可以改用密码，先取消扫码再登录且不重复发起微信', async () => {
  let resolveWechat!: (response: { snapshot: string; recoveryCode: string }) => void
  const wechatLogin = vi.fn(() => new Promise<{ snapshot: string; recoveryCode: string }>((resolve) => { resolveWechat = resolve }))
  const cancelWechatLogin = vi.fn(async () => {
    resolveWechat({ snapshot: JSON.stringify(guest(true)), recoveryCode: '' })
    return { cancelled: true }
  })
  const login = vi.fn(async () => ({ snapshot: JSON.stringify(signedIn(true, true)) }))
  vi.stubGlobal('window', { toolbox: { account: { wechatInlineLogin: wechatLogin, cancelWechatLogin, login } } })
  vi.mocked(accountAction).mockImplementation(async (action) => JSON.parse((await action()).snapshot) as AccountView)
  const root = await render(guest(true))
  expect(wechatLogin).toHaveBeenCalledTimes(1)
  root.all().find((node) => node.name === 'username')!.value = 'local-ui09'
  root.all().find((node) => node.name === 'password')!.value = 'local-fixture-only'
  root.all().find((node) => node.tag === 'form')!.dispatch('submit')
  await vi.waitFor(() => expect(login).toHaveBeenCalledWith({ username: 'local-ui09', password: 'local-fixture-only', inviteCode: '' }))
  expect(cancelWechatLogin).toHaveBeenCalledTimes(1)
  expect(finishAccountNavigation).toHaveBeenCalledTimes(1)
})

it('注册和找回入口仍可切换并回到双栏登录', async () => {
  const root = await render(guest(true))
  root.all().find((node) => node.textContent === '没有账号，去注册')!.dispatch('click')
  expect(root.all().some((node) => node.name === 'confirmation')).toBe(true)
  expect(root.all().some((node) => node.className === 'account-login-columns')).toBe(false)
  root.all().find((node) => node.textContent === '已有账号，去登录')!.dispatch('click')
  root.all().find((node) => node.textContent === '忘记密码')!.dispatch('click')
  expect(root.all().some((node) => node.name === 'recoveryCode')).toBe(true)
  root.all().find((node) => node.textContent === '已有账号，去登录')!.dispatch('click')
  expect(root.all().some((node) => node.className === 'account-login-columns')).toBe(true)
})

it('绑定入口同时要求后台已开启且明确回报尚未绑定', async () => {
  expect((await render(signedIn(false, false))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true, true))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true, false))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(true)
})
