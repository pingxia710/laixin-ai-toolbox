import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, CommercialTerms } from '../../app/account-types'

const state = vi.hoisted(() => ({ view: null as unknown }))
vi.mock('../../app/renderer/src/account-state', () => ({
  accountAction: vi.fn(), cancelAccountNavigation: vi.fn(), finishAccountNavigation: vi.fn(), refreshAccount: vi.fn(),
  takeAccountEntryMode: () => 'login',
  onAccountChange: (listener: (view: unknown) => void) => { listener(state.view); return () => undefined }
}))
vi.mock('../../app/renderer/src/ui/account-overview', () => ({
  mountAccountOverview: vi.fn(),
  actionButton: (label: string, action: () => void) => {
    const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', action); return button
  },
  textNode: (tag: string, text: string, className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node
  }
}))
vi.mock('../../app/renderer/src/ui/account-security', () => ({ mountAccountSecurity: vi.fn() }))
vi.mock('../../app/renderer/src/ui/device-report', () => ({ mountDeviceReport: () => () => undefined }))
vi.mock('../../app/renderer/src/ui/account-services', () => ({ mountAccountServices: vi.fn() }))
vi.mock('../../app/renderer/src/support-widget', () => ({ revealSupport: vi.fn() }))
vi.mock('../../app/commercial-copy', () => ({ inviteFieldHint: () => '' }))

class Element {
  textContent = ''; className = ''; type = ''; name = ''; value = ''; id = ''; autocomplete = ''; required = false; disabled = false
  readOnly = false; rows = 0; minLength = 0; maxLength = 0; checked = false
  dataset: Record<string, string> = {}; children: Element[] = []; parentElement: Element | null = null
  private handlers = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children) }
  after(...nodes: Element[]) {
    if (!this.parentElement) return
    const index = this.parentElement.children.indexOf(this)
    for (const node of nodes) node.parentElement = this.parentElement
    this.parentElement.children.splice(index + 1, 0, ...nodes)
  }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]) }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
  focus() {}; select() {}; close() {}; remove() {}; showModal() {}
}

vi.stubGlobal('document', {
  createElement: (tag: string) => new Element(tag),
  createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  body: new Element('body')
})
vi.stubGlobal('window', { toolbox: { account: {} } })

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
  expect((await render(guest())).all().some((node) => node.textContent === '微信登录')).toBe(false)
  expect((await render(guest(false))).all().some((node) => node.textContent === '微信登录')).toBe(false)
  expect((await render(guest(true))).all().some((node) => node.textContent === '微信登录')).toBe(true)
})

it('绑定入口同时要求后台已开启且明确回报尚未绑定', async () => {
  expect((await render(signedIn(false, false))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true, true))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(false)
  expect((await render(signedIn(true, false))).all().some((node) => node.textContent === '绑定微信到当前账号')).toBe(true)
})
