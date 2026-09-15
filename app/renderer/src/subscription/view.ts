import type { SubscriptionCatalog, SubscriptionDelivery, SubscriptionIssue, SubscriptionOrderView, SubscriptionPayment, SubscriptionProduct, SubscriptionSoftware, SubscriptionStatus } from '../../../subscription-types'
import type { SubscriptionResult } from '../../../preload/api/subscription'
import { accountSnapshot, onAccountChange, requireAccount } from '../account-state'
import { markServiceAvailability } from '../navigation'
import { revealSupport } from '../support-widget'
import { mountQrCountdown, renderPaymentQr } from './qr-countdown'
import { renderSecretFields } from './secret-fields'
import { planCard } from '../ui/plan-card'
import './style.css'

export { renderPaymentQr }

export const statusLabels: Record<SubscriptionStatus, string> = { pending_payment: '等待付款', queued: '已付款 · 等待办理', processing: '正在办理', ready: '账号已备好 · 待领取核对', completed: '已确认完成', problem: '订单问题处理中', cancel_requested: '取消申请处理中', refund_pending: '等待人工退款', refunded: '已记录退款', cancelled: '已取消' }
const money = (n: number) => `¥${(n / 100).toFixed(2)}`
const date = (n: number | null) => n ? new Date(n).toLocaleString('zh-CN') : '尚未确定'
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
async function result<T>(request: Promise<SubscriptionResult>): Promise<T> {
  const response = await request
  if (response.error || !response.data) throw new Error(response.error || '暂时无法读取，请稍后重试。')
  return JSON.parse(response.data) as T
}
export function mountSubscriptions(root: HTMLElement): () => void {
  const api = window.toolbox.subscription
  let active = true; let busy = false; let generation = 0; let accountId = accountSnapshot().account?.id
  let catalog: SubscriptionCatalog | undefined; let orders: SubscriptionOrderView[] = []
  let nextCursor = ''
  let selected: SubscriptionOrderView | undefined; let checkout: SubscriptionProduct | undefined
  let payment: SubscriptionPayment | undefined; let secret: SubscriptionDelivery | undefined
  let message = ''; let showOrders = false
  let software: SubscriptionSoftware = 'codex'
  let qrStop: (() => void) | undefined
  const requests = new Map<string, string>()
  const clearSecret = () => { secret = undefined; generation++; if (active) render() }
  const hideOnBlur = () => { generation++; if (secret) { secret = undefined; if (active) render() } }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    busy = true; message = ''; root.setAttribute('aria-busy', 'true')
    try { await action() } catch (error) { if (active) message = error instanceof Error ? error.message : '操作未完成，请刷新后重试。' }
    finally { busy = false; root.removeAttribute('aria-busy'); if (active) render() }
  }
  const button = (label: string, action: () => void | Promise<void>, primary = false) => {
    const b = el('button', label, primary ? 'primary-action' : 'secondary-action'); b.type = 'button'; b.disabled = busy
    b.onclick = () => { void action() }; return b
  }
  const refresh = async (cursor = '') => {
    const identity = accountSnapshot().account?.id
    if (!identity) { orders = []; return }
    const response = await result<{ orders: SubscriptionOrderView[]; nextCursor: string }>(api.list({ cursor }))
    if (active && identity === accountSnapshot().account?.id) { orders = cursor ? [...orders, ...response.orders] : response.orders; nextCursor = response.nextCursor }
  }
  const open = async (id: string) => {
    const response = await result<SubscriptionOrderView>(api.detail({ orderId: id }))
    if (active && accountSnapshot().account) { selected = response; checkout = undefined; showOrders = true; secret = undefined; generation++; payment = undefined }
  }
  const pay = async () => {
    if (!selected) return
    const id = selected.id; const response = await result<SubscriptionPayment>(api.pay({ orderId: id }))
    if (active && selected?.id === id) { payment = response; selected = response.order }
  }
  const act = async (action: 'complete' | 'cancel' | 'report', issue?: SubscriptionIssue) => {
    if (!selected) return
    const id = selected.id
    const response = await result<SubscriptionOrderView>(action === 'report' ? api.report({ orderId: id, issue: issue! }) : api[action]({ orderId: id }))
    if (active && selected?.id === id) { selected = response; secret = undefined; generation++; payment = undefined; await refresh() }
  }
  function terms(section: HTMLElement, product: SubscriptionProduct): void {
    section.append(el('h3', product.name), el('p', `${money(product.priceCents)} · ${product.term}`, 'sub-price'),
      el('p', `总价已含账号订阅服务费 ${money(product.serviceFeeCents)}，网络费用另计。`), el('p', product.description),
      el('p', `交付：付款后 ${product.deliveryHours} 小时内。${product.fulfillmentTerms}`),
      el('p', `账号控制与找回：${product.recoveryTerms}`), el('p', `取消与退款：${product.cancellationTerms}`))
  }
  function renderCheckout(product: SubscriptionProduct): HTMLElement {
    const section = el('section', '', 'sub-detail'); terms(section, product)
    const form = el('form'); const label = el('label', '付款方式'); const select = el('select'); select.name = 'channel'
    for (const channel of catalog?.channels ?? []) { const option = el('option', ({ alipay: '支付宝', wechat: '微信支付', manual: '联系客服人工办理付款' })[channel]); option.value = channel; select.append(option) }
    label.append(select)
    const consent = el('label', '', 'sub-check'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.required = true
    consent.append(checkbox, document.createTextNode('我已阅读套餐、交付、账号找回及取消说明。'))
    const submit = el('button', '确认下单', 'primary-action'); submit.disabled = busy || !catalog?.channels.length
    form.append(label, consent, submit, button('返回套餐', () => { checkout = undefined; render() }))
    form.onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const key = `${product.id}:${select.value}`; const requestId = requests.get(key) ?? crypto.randomUUID(); requests.set(key, requestId)
      const order = await result<SubscriptionOrderView>(api.create({ productId: product.id, channel: select.value, requestId }))
      requests.delete(key)
      if (!active || !accountSnapshot().account) return
      selected = order; checkout = undefined; showOrders = true; await refresh()
      if (order.channel !== 'manual' && order.status === 'pending_payment') await pay()
    }) }
    section.append(form); return section
  }
  function renderOrder(order: SubscriptionOrderView): HTMLElement {
    const section = el('section', '', 'sub-detail')
    section.append(button('返回我的订单', () => { selected = undefined; payment = undefined; clearSecret() }), el('p', statusLabels[order.status], 'sub-status'))
    terms(section, order.product)
    section.append(el('p', `订单 ${order.id}`, 'sub-muted'), el('p', `下单 ${date(order.createdAt)} · 付款 ${date(order.paidAt)}`, 'sub-muted'))
    if (order.dueAt) section.append(el('p', `承诺交付时间：${date(order.dueAt)}${order.dueAt < Date.now() && ['queued', 'processing', 'problem'].includes(order.status) ? ' · 已超时，可通过下方客服入口查询处理进展。' : ''}`))
    if (order.expiresAt) section.append(el('p', `实际权益：${date(order.startsAt)} 至 ${date(order.expiresAt)}。领取不会重新起算。`))
    if (order.issue) section.append(el('p', '订单问题已记录，可通过下方客服入口补充情况，请勿发送密码。'))
    if (order.status === 'pending_payment') {
      if (order.channel === 'manual') section.append(el('p', '请通过下方企业微信客服办理，并提供订单编号；核对实际付款后更新进度。'))
      else section.append(button('继续付款', () => run(pay), true))
      if (payment?.payment?.redirect?.kind === 'qrcode') {
        qrStop?.()
        const block = el('div', '', 'sub-qr')
        const countdown = mountQrCountdown(block, payment.payment.redirect, { regenerate: () => run(pay) })
        qrStop = countdown.stop
        section.append(block)
      }
      if (payment?.payment?.redirect?.kind === 'url') section.append(el('p', '已在系统浏览器打开支付宝，请完成付款后返回这里。'))
    }
    if (['ready', 'completed', 'problem'].includes(order.status) && order.deliveredAt) {
      section.append(button(secret ? '隐藏账号资料' : '查看交付的账号资料', () => secret ? clearSecret() : run(async () => {
        const current = generation
        const response = await result<SubscriptionDelivery>(api.reveal({ orderId: order.id }))
        if (active && current === generation && selected?.id === order.id && document.visibilityState !== 'hidden') { secret = response; selected = { ...order, revealedAt: Date.now() } }
      }), true))
      if (secret) {
        const area = el('div', '', 'sub-secret'); area.append(el('p', '仅本人查看。离开本页、切换账号或窗口失去焦点后隐藏。'))
        renderSecretFields(area, [
          { name: '账号', value: secret.username, rows: 2 },
          { name: '密码', value: secret.password, rows: 2 },
          { name: '登录说明', value: secret.instructions, rows: 4 }
        ])
        section.append(area)
      }
      if (order.status === 'ready') { const complete = button('已登录并核对套餐，确认完成', () => run(() => act('complete'))); complete.disabled ||= !order.revealedAt; section.append(complete) }
      const problems = el('div', '', 'sub-actions'); problems.append(el('span', '交付有问题：'))
      for (const [issue, label] of [['cannot_login', '无法登录'], ['wrong_entitlement', '套餐或有效期不符'], ['other', '其他问题']] as const) problems.append(button(label, () => run(() => act('report', issue))))
      section.append(problems)
    }
    if (order.status === 'refund_pending') section.append(el('p', '等待人工办理退款，实际到账以原支付渠道为准。'))
    if (order.status === 'refunded') section.append(el('p', `运营已于 ${date(order.refundAt)} 记录退款，请核对原支付渠道到账。`))
    const controls = el('div', '', 'sub-actions'); controls.append(button('刷新进度', () => run(() => open(order.id))))
    if (!['cancel_requested', 'refund_pending', 'refunded', 'cancelled'].includes(order.status)) controls.append(button(order.status === 'pending_payment' ? '取消未付款订单' : '申请取消 / 退款', () => run(() => act('cancel'))))
    const history = el('ol', '', 'sub-history'); for (const event of order.events) history.append(el('li', `${date(event.at)} · ${statusLabels[event.status]}`))
    section.append(controls, history); return section
  }
  function render(): void {
    if (!active) return
    qrStop?.(); qrStop = undefined
    root.classList.add('subscription-page')
    const canOrder = catalog?.products.some((product) => product.enabled) === true
    if (catalog) markServiceAvailability('purchase', !canOrder)
    const header = el('div', '', 'sub-header')
    header.append(el('h2', 'Codex / Claude Code 账号订阅'))
    if (showOrders) header.append(button(canOrder ? '选择套餐' : '服务说明', () => { showOrders = false; selected = undefined; checkout = undefined; clearSecret() }))
    else header.append(button('我的订单', () => {
      if (accountSnapshot().state !== 'signed-in') { requireAccount('purchase'); return }
      showOrders = true; selected = undefined; checkout = undefined; clearSecret(); void run(refresh)
    }))
    const notice = el('p', message); notice.setAttribute('role', 'status')
    root.replaceChildren(header, el('p', '选择官方套餐，由人工代为办理。已有适用账号可直接使用，无需重复购买。', 'sub-muted'), notice)
    if (checkout) { root.append(renderCheckout(checkout)); return }
    if (selected) { root.append(renderOrder(selected)); return }
    if (!showOrders) {
      if (!catalog) root.append(el('p', message ? '暂时无法读取套餐。' : '正在读取可办理的套餐…'), button('重新读取套餐', () => run(async () => { catalog = await result<SubscriptionCatalog>(api.catalog()) })))
      else if (!catalog.products.length) {
        const empty = el('section', '', 'sub-detail'); empty.append(el('h3', '账号订阅暂未开放'), el('p', 'Codex 使用 ChatGPT 官方套餐；Claude Code 使用 Claude 官方套餐。'), el('p', '开放后会在这里显示套餐、总价和交付时间。已有订单仍可在“我的订单”中查看。'), button('联系来信客服', revealSupport)); root.append(empty)
      } else {
        const switcher = el('div', '', 'plan-switch'); switcher.setAttribute('role', 'tablist'); switcher.setAttribute('aria-label', '套餐软件')
        const entries: [SubscriptionSoftware, string][] = [['codex', 'Codex'], ['claude', 'Claude Code']]
        entries.forEach(([id, label]) => {
          const tab = el('button', label); tab.type = 'button'; tab.dataset.planSoftware = id
          tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(software === id)); tab.tabIndex = software === id ? 0 : -1
          tab.onclick = () => { software = id; checkout = undefined; render() }
          switcher.append(tab)
        })
        switcher.onkeydown = (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : software === 'codex' ? 1 : 0
          software = entries[index]![0]; checkout = undefined; render()
          root.querySelector<HTMLButtonElement>(`.plan-switch [data-plan-software="${software}"]`)?.focus()
        }
        root.append(switcher)
        const products = catalog.products.filter((product) => product.software === software)
        if (!products.length) root.append(el('p', software === 'codex' ? 'Codex 套餐暂时无可办理档位，可先看 Claude Code 或联系来信客服。' : 'Claude Code 套餐暂时无可办理档位，可先看 Codex 或联系来信客服。', 'sub-muted'))
        const cards = el('div', '', 'plan-cards')
        for (const product of products) {
          cards.append(planCard({
            name: product.name, description: product.description, price: money(product.priceCents), termSuffix: ` · ${product.term}`,
            cta: product.enabled ? '查看套餐与办理说明' : '暂未开放', disabled: busy || !product.enabled,
            onChoose: () => { if (accountSnapshot().state !== 'signed-in') { requireAccount('purchase'); return } checkout = product; render() },
            features: [`付款后 ${product.deliveryHours} 小时内人工办理交付`, `已含账号订阅服务费 ${money(product.serviceFeeCents)}，网络费用另计`, '官方套餐权益，由来信代为办理并交付账号', '交付、找回与取消退款的完整约定见办理说明']
          }))
        }
        if (products.length) root.append(cards)
      }
    } else {
      root.append(button('刷新订单', () => run(refresh)))
      if (!orders.length) root.append(el('p', '还没有账号订阅订单。'))
      for (const order of orders) { const row = el('article', '', 'sub-order-row'); row.append(el('strong', order.product.name), el('span', statusLabels[order.status]), el('span', money(order.product.priceCents)), button('查看订单', () => run(() => open(order.id)))); root.append(row) }
      if (nextCursor) root.append(button('查看更早的订单', () => run(() => refresh(nextCursor))))
    }
  }
  const stopAccount = onAccountChange((view) => { if (view.account?.id !== accountId || view.state !== 'signed-in') { accountId = view.account?.id; orders = []; nextCursor = ''; selected = undefined; checkout = undefined; payment = undefined; requests.clear(); clearSecret() } })
  const visibility = () => { if (document.visibilityState === 'hidden') hideOnBlur() }
  document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hideOnBlur)
  const timer = setInterval(() => {
    if (!active || busy || secret || selected?.status !== 'pending_payment' || selected.channel === 'manual' || document.visibilityState === 'hidden') return
    const id = selected.id
    void run(async () => { const response = await result<SubscriptionOrderView>(api.detail({ orderId: id })); if (active && selected?.id === id) selected = response })
  }, 5000)
  render(); void run(async () => { catalog = await result<SubscriptionCatalog>(api.catalog()) })
  return () => { active = false; qrStop?.(); qrStop = undefined; secret = undefined; generation++; clearInterval(timer); stopAccount(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hideOnBlur); root.replaceChildren(); root.classList.remove('subscription-page') }
}
