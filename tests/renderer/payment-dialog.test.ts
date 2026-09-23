import { afterEach, expect, it, vi } from 'vitest'
import type { PaymentChannelName, PaymentOrderView } from '../../app/account-types'

class Element {
  textContent = ''; className = ''; id = ''; type = ''; open = false; disabled = false
  children: Element[] = []; handlers = new Map<string, () => void>(); attributes = new Map<string, string>()
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler) }
  showModal() { this.open = true }
  close() { this.open = false; this.handlers.get('close')?.() }
  remove() {}
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())] }
}
const order: PaymentOrderView = { orderId: 'a'.repeat(32), applicationId: 'lx-' + 'b'.repeat(32), planId: '20g', channel: 'wechat', amountFen: 1990, status: 'open', paidAt: null, redirect: null, confirmError: null }
const view = { state: 'signed-in', account: { id: 'fixture', username: 'fixture' }, code: '', message: '', overview: null }
const snapshot = JSON.stringify(view)
const plan = { id: '20g', label: '20 GB 月套餐', priceCents: 1990, bytes: 20 * 1024 ** 3 }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function setup(pay = vi.fn(async () => ({ snapshot, order: JSON.stringify(order), openedBrowser: false })), product = plan, channel: PaymentChannelName = 'wechat') {
  vi.resetModules(); vi.useFakeTimers()
  const body = new Element()
  const navigate = vi.fn()
  vi.stubGlobal('document', { createElement: () => new Element(), createElementNS: () => new Element(), body, dispatchEvent: navigate })
  const pollPayment = vi.fn(async () => ({ order: JSON.stringify(order) }))
  const status = vi.fn(async () => ({ snapshot }))
  vi.stubGlobal('window', { toolbox: { account: { pay, pollPayment, status } } })
  const { openPaymentDialog } = await import('../../app/renderer/src/ui/payment-dialog')
  const controls = openPaymentDialog(product, channel)
  await vi.advanceTimersByTimeAsync(0)
  return { dialog: body.children[0], controls, pollPayment, status, navigate }
}

it('建单失败也始终保留关闭按钮，不把客户困在付款窗口', async () => {
  const x = await setup(vi.fn(async () => { throw new Error('fixture failure') }))
  expect(x.dialog.all().some((node) => node.textContent === '关闭')).toBe(true)
  x.controls.close(); expect(x.dialog.open).toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.pollPayment).not.toHaveBeenCalled()
})

it('慢查询不重叠；关闭后迟到的成功响应不会刷新另一页面的账号', async () => {
  const x = await setup()
  let resolve!: (value: { order: string }) => void
  x.pollPayment.mockImplementation(() => new Promise((done) => { resolve = done }))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  x.controls.close()
  resolve({ order: JSON.stringify({ ...order, status: 'confirmed' }) })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  expect(x.status).not.toHaveBeenCalled()
})

it('服务端确认后显示开通成功并停止继续查单', async () => {
  const x = await setup()
  x.pollPayment.mockResolvedValue({ order: JSON.stringify({ ...order, status: 'confirmed' }) })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.dialog.all().some((node) => node.textContent === '支付成功，套餐已开通。可到「AI网络」页连接。')).toBe(true)
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  expect(x.status).toHaveBeenCalledTimes(1)
})

it('客服记录退款后撤下付款载体、说明结果并停止查单，不误报开通', async () => {
  const x = await setup()
  x.pollPayment.mockResolvedValue({ order: JSON.stringify({ ...order, status: 'refunded' }) })
  await vi.advanceTimersByTimeAsync(10_000)
  const content = x.dialog.all().map((node) => node.textContent).join('\n')
  expect(content).toContain('该订单已记录退款。到账情况请查看原支付渠道；套餐权益以「我的账号」为准。')
  expect(content).not.toContain('套餐已开通')
  expect(content).not.toContain('等待支付结果')
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  expect(x.status).toHaveBeenCalledTimes(1)
})

it('打开时已退款的订单不启动轮询，仍能关闭', async () => {
  const x = await setup(vi.fn(async () => ({ snapshot, order: JSON.stringify({ ...order, status: 'refunded' }), openedBrowser: false })))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.dialog.all().some((node) => node.textContent.includes('该订单已记录退款'))).toBe(true)
  expect(x.pollPayment).not.toHaveBeenCalled()
  x.controls.close(); expect(x.dialog.open).toBe(false)
})

it.each([true, false])('支付宝查单不返回链接时保留浏览器打开结果：%s', async (openedBrowser) => {
  const pending = { ...order, channel: 'alipay', expiresAt: Date.now() + 60_000 }
  const created = { ...pending, redirect: { kind: 'url', data: 'https://openapi.alipay.com/gateway.do?fixture=1', expiresAt: pending.expiresAt } }
  const x = await setup(vi.fn(async () => ({ snapshot, order: JSON.stringify(created), openedBrowser })), plan, 'alipay')
  const expected = openedBrowser ? '已在浏览器打开支付宝付款页' : '未能自动打开支付宝付款页'
  expect(x.dialog.all().some((node) => node.textContent.includes(expected))).toBe(true)
  x.pollPayment.mockResolvedValue({ order: JSON.stringify(pending) })
  await vi.advanceTimersByTimeAsync(3000)
  expect(x.dialog.all().some((node) => node.textContent.includes(expected))).toBe(true)
  expect(x.dialog.all().some((node) => node.textContent.includes('付款入口已过期'))).toBe(false)
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  x.pollPayment.mockResolvedValue({ order: JSON.stringify({ ...pending, status: 'confirmed' }) })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.dialog.all().some((node) => node.textContent.includes('套餐已开通'))).toBe(true)
  expect(x.pollPayment).toHaveBeenCalledTimes(2)
  x.controls.close()
})

it.each(['expired', 'cancelling'])('支付宝订单 %s 后不能继续提示在浏览器付款', async (state) => {
  const pending = { ...order, channel: 'alipay', expiresAt: Date.now() + 60_000 }
  const x = await setup(vi.fn(async () => ({ snapshot, order: JSON.stringify(pending), openedBrowser: true })), plan, 'alipay')
  x.pollPayment.mockResolvedValue({ order: JSON.stringify({ ...pending,
    expiresAt: state === 'expired' ? Date.now() - 1 : pending.expiresAt, cancelPending: state === 'cancelling' }) })
  await vi.advanceTimersByTimeAsync(3000)
  const content = x.dialog.all().map((node) => node.textContent).join('\n')
  expect(content).not.toContain('已在浏览器打开支付宝付款页')
  expect(content).toContain(state === 'expired' ? '付款入口已过期' : '已申请取消')
  x.controls.close()
})

it('订单已创建但权益刷新失败时仍显示有效二维码、查单并确认成功', async () => {
  const paymentOrder = { ...order, expiresAt: Date.now() + 60_000,
    redirect: { kind: 'qrcode', data: 'weixin://wxpay/bizpayurl?pr=fixture', expiresAt: Date.now() + 60_000 } }
  const unavailable = { ...view, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '订单已创建，完成支付后自动开通。' }
  const x = await setup(vi.fn(async () => ({ snapshot: JSON.stringify(unavailable), order: JSON.stringify(paymentOrder), openedBrowser: false })))
  expect(x.dialog.all().some((node) => node.attributes.get('aria-label') === '微信支付二维码')).toBe(true)
  const { accountSnapshot } = await import('../../app/renderer/src/account-state')
  expect(accountSnapshot().code).toBe('ACCOUNT_SERVICE_UNAVAILABLE')
  x.pollPayment.mockResolvedValue({ order: JSON.stringify({ ...order, status: 'confirmed' }) })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.dialog.all().some((node) => node.textContent === '支付成功，套餐已开通。可到「AI网络」页连接。')).toBe(true)
  expect(x.pollPayment).toHaveBeenCalledTimes(1)
  expect(x.status).toHaveBeenCalledTimes(1)
  x.controls.close()
})

it.each([
  ['signed-out', 'ACCOUNT_LOGIN_REQUIRED', true],
  ['unavailable', 'ACCOUNT_SERVICE_UNAVAILABLE', true],
  ['signed-in', 'ACCOUNT_STORAGE_UNAVAILABLE', true],
  ['signed-in', 'PAYMENT_ORDER_BUSY', true],
  ['signed-in', 'ACCOUNT_SERVICE_UNAVAILABLE', false]
])('账号 %s / %s / 有订单 %s 时不得绕过错误开放付款', async (state, code, hasOrder) => {
  const paymentOrder = { ...order, redirect: { kind: 'qrcode', data: 'weixin://wxpay/bizpayurl?pr=fixture', expiresAt: Date.now() + 60_000 } }
  const x = await setup(vi.fn(async () => ({ snapshot: JSON.stringify({ ...view, state, code, message: '请重试' }),
    order: hasOrder ? JSON.stringify(paymentOrder) : '', openedBrowser: false })))
  expect(x.dialog.all().some((node) => node.attributes.get('aria-label') === '微信支付二维码')).toBe(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.pollPayment).not.toHaveBeenCalled()
  x.controls.close()
})
