import type { NetworkPlan, PaymentChannelName, PaymentOrderView } from '../../../account-types'
import { accountAction, refreshAccount } from '../account-state'
import { createLocalQrCode } from '../components/help-contact/qr'

const POLL_INTERVAL_MS = 3000

interface PaymentDialogControls { close: () => void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}

/** 在线付款对话框：微信显示二维码、支付宝跳系统浏览器；每 3 秒轮询订单，
 * 开通或退款后刷新权益并停止轮询。关闭对话框即停止轮询。 */
export function openPaymentDialog(plan: NetworkPlan, channel: PaymentChannelName): PaymentDialogControls {
  const dialog = document.createElement('dialog'); dialog.className = 'recovery-dialog payment-dialog'
  const title = el('h2', channel === 'alipay' ? '支付宝付款' : '微信付款')
  title.id = 'payment-title'; dialog.setAttribute('aria-labelledby', title.id)
  const amountLine = el('p', `${plan.label} · ¥${(plan.priceCents / 100).toFixed(2)} / 月`)
  const status = el('p', '正在创建订单…'); status.setAttribute('role', 'status')
  const holder = document.createElement('div'); holder.className = 'payment-holder'
  const actions = document.createElement('div'); actions.className = 'account-actions'
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let polling = false
  let openedBrowser = false
  let order: PaymentOrderView | null = null
  let consecutiveFailures = 0

  const terminal = () => Boolean(order && ['confirmed', 'partially_refunded', 'refunded', 'cancelled'].includes(order.status))
  const closeButton = el('button', '关闭', 'secondary-action'); closeButton.type = 'button'
  closeButton.addEventListener('click', () => dialog.close())
  actions.append(closeButton)

  const render = (): void => {
    holder.replaceChildren()
    actions.replaceChildren(closeButton)
    if (!order) return
    const canPay = !order.cancelPending && (order.expiresAt == null || order.expiresAt > Date.now())
    const redirect = canPay ? order.redirect : null
    if (order.status === 'open') {
      const cancel = el('button', '取消此订单', 'secondary-action'); cancel.type = 'button'
      cancel.addEventListener('click', () => {
        cancel.disabled = true
        void accountAction(() => window.toolbox.account.cancelPayment({ orderId: order!.orderId })).then((view) => { if (!closed) { status.textContent = view.message; void tick() } })
      })
      actions.replaceChildren(cancel, closeButton)
    }
    if (order.status === 'open' && redirect?.kind === 'qrcode') {
      status.textContent = '请用手机微信扫码支付，完成后本窗口自动确认。'
      holder.append(buildQr(redirect.data))
    } else if (order.status === 'open' && order.channel === 'alipay' && canPay) {
      status.textContent = openedBrowser ? '已在浏览器打开支付宝付款页，请在浏览器中完成支付；完成后回到本窗口自动确认。' : '未能自动打开支付宝付款页。请关闭窗口后，在原套餐选择“支付宝继续付款”重试。'
    } else if (order.status === 'open') {
      status.textContent = order.cancelPending ? '已申请取消，等待渠道确认；确认后可以更换支付方式。' : '付款入口已过期或暂未返回，正在向渠道核对。'
    }
    if (order.status === 'paid') status.textContent = '支付成功，正在开通套餐…'
    if (terminal()) {
      status.textContent = order.status === 'cancelled' ? '订单已取消，可以重新选择支付方式。' : order.status === 'partially_refunded' ? `该订单已部分退款 ¥${((order.refundedFen ?? 0) / 100).toFixed(2)}，请查看原支付渠道。` : order.status === 'refunded'
        ? '该订单已记录退款。到账情况请查看原支付渠道；套餐权益以「我的账号」为准。'
        : '支付成功，套餐已开通。可到「AI网络」页连接。'
      void refreshAccount()
      const done = el('button', '完成', 'primary-action'); done.type = 'button'
      done.addEventListener('click', () => dialog.close())
      actions.replaceChildren(done, closeButton)
    } else if (order.confirmError) {
      status.textContent = '支付已成功，套餐暂未开通。请联系来信客服核对，勿重复付款。'
    }
  }

  const tick = async (): Promise<void> => {
    if (closed || polling || !order || terminal()) return
    polling = true
    try {
      const response = await window.toolbox.account.pollPayment({ orderId: order.orderId })
      if (closed) return
      if (!response?.order) throw new Error('poll_failed')
      const next = JSON.parse(response.order) as PaymentOrderView | null
      if (!next) throw new Error('poll_invalid')
      consecutiveFailures = 0
      order = next
      render()
      if (terminal()) stop()
    } catch {
      if (closed) return
      consecutiveFailures++
      if (consecutiveFailures === 5) status.textContent = '暂时无法确认支付结果，仍在重试；请不要关闭正在付款的页面。'
    } finally {
      polling = false
    }
  }

  const startPolling = (): void => {
    stop()
    if (terminal()) return
    timer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }
  const stop = (): void => {
    if (timer) { clearInterval(timer); timer = undefined }
  }

  dialog.append(title, amountLine, status, holder, actions)
  dialog.addEventListener('close', () => { closed = true; stop(); dialog.remove() })
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close() })
  document.body.append(dialog); dialog.showModal()

  void (async () => {
    try {
      const view = await accountAction(async () => {
        const response = await window.toolbox.account.pay({ planId: plan.id, channel })
        openedBrowser = response.openedBrowser
        order = response.order ? JSON.parse(response.order) as PaymentOrderView : null
        return { snapshot: response.snapshot }
      })
      if (closed) return
      if (view.code === 'ACCOUNT_LOGIN_REQUIRED') { status.textContent = '请先登录来信账号再付款。'; return }
      // A failed entitlement refresh must not hide an already-created order.
      if (view.code && !(order && view.state === 'signed-in' && view.code === 'ACCOUNT_SERVICE_UNAVAILABLE')) { status.textContent = view.message; return }
      if (!order) { status.textContent = '暂时无法创建订单，请稍后重试或联系客服。'; return }
      render(); startPolling()
    } catch {
      if (!closed) status.textContent = '暂时无法创建订单，请稍后重试或联系客服。'
    }
  })()

  return { close: () => dialog.close() }
}

function buildQr(data: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  let modules: readonly (readonly boolean[])[]
  try {
    modules = createLocalQrCode(data).modules
  } catch {
    svg.setAttribute('aria-label', '二维码生成失败')
    return svg
  }
  const size = modules.length
  svg.setAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`)
  svg.setAttribute('width', '220'); svg.setAttribute('height', '220')
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '微信支付二维码')
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('x', '-4'); background.setAttribute('y', '-4')
  background.setAttribute('width', String(size + 8)); background.setAttribute('height', String(size + 8))
  background.setAttribute('fill', 'white')
  const dots = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  dots.setAttribute('fill', 'black')
  dots.setAttribute('d', modules.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1H${x}z` : '')))
    .filter((path) => path !== '').join(''))
  svg.append(background, dots)
  return svg
}
