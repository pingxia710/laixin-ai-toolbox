import type { AccountView, PaymentOrderView } from '../../../account-types'
import type { SharingOrderView } from '../../../sharing-types'
import type { SubscriptionOrderView } from '../../../subscription-types'
import { accountAction } from '../account-state'
import { requestTabNavigation } from '../navigation'
import { revealSupport } from '../support-widget'
import { statusLabels as sharingStatusLabels } from '../sharing/view'
import { statusLabels as subscriptionStatusLabels } from '../subscription/view'
import { actionButton, textNode } from './account-overview'

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`
const day = (value?: number | null) => value ? new Date(value).toLocaleDateString('zh-CN') : ''
const channelLabels: Record<string, string> = { alipay: '支付宝', wechat: '微信支付', manual: '人工办理' }

const networkStatusLabels: Record<PaymentOrderView['status'], string> = {
  open: '待付款', paid: '付款异常，套餐未开通', confirmed: '付款已确认', partially_refunded: '部分退款', refunded: '全部退款', cancelled: '已取消'
}
const networkActive = (status: PaymentOrderView['status']): boolean => status === 'open' || status === 'paid'
const subscriptionActive = (status: SubscriptionOrderView['status']): boolean => !['completed', 'refunded', 'cancelled'].includes(status)
const sharingActive = (status: SharingOrderView['status']): boolean => !['expired', 'refunded', 'cancelled'].includes(status)

/** 轻量历史摘要的条数上限；完整历史仍在各服务自己的页面。 */
const NETWORK_HISTORY_LIMIT = 5
const SERVICE_HISTORY_LIMIT = 3

function sectionRow(title: string, note: string): HTMLElement {
  const row = document.createElement('section'); row.className = 'account-installation'
  row.append(textNode('strong', title), textNode('p', note, 'account-note'))
  return row
}

function serviceGroup(parent: HTMLElement, title: string): HTMLElement {
  const group = document.createElement('section')
  const body = document.createElement('section')
  parent.append(group)
  group.append(textNode('h4', title), body)
  return body
}

export function mountAccountServices(element: HTMLElement, view: AccountView): void {
  const profile = view.overview?.profile
  if (view.state !== 'signed-in') {
    for (const [title, note] of [['工具箱', '工具箱免费。可查看 AI 官方下载与版本并配置模型；网络流量与 AI 厂商收费各自独立。'], ['支付与服务', '登录后查看付款、交付和售后记录。']]) {
      const card = document.createElement('section'); card.className = 'account-service'
      card.append(textNode('h3', title), textNode('p', view.state === 'signed-out' ? note : '账号状态暂时无法读取，请刷新后查看。', 'account-note'))
      element.append(card)
    }
    return
  }
  const toolbox = document.createElement('section'); toolbox.className = 'account-service'
  toolbox.append(textNode('h3', '工具箱'), textNode('p', '工具箱免费。下载、安装和模型 API 配置无需购买；网络流量与 AI 厂商收费各自独立。', 'account-note'))
  const record = profile?.toolbox
  if (!profile) toolbox.append(textNode('p', '暂时无法获取账号记录，请刷新账号。', 'account-note'))
  else if (record?.status === 'paid') toolbox.append(textNode('p', `历史记录：曾购买工具箱使用权 · ${new Date(record.paidAt!).toLocaleDateString('zh-CN')}。仅供售后核对，工具箱现已免费。`))
  else if (record?.status === 'refunded') toolbox.append(textNode('p', '历史记录：此工具箱订单已退款，仅供售后核对。'))
  else if (record) toolbox.append(textNode('p', '历史记录：有未付款的旧购买申请；工具箱已免费，无需付款。', 'account-note'))
  if (record) {
    if (record.refundedFen) toolbox.append(textNode('p', `累计已退 ¥${(record.refundedFen / 100).toFixed(2)}。到账请核对原付款渠道。`, 'account-note'))
    toolbox.append(actionButton('联系售后', revealSupport))
  }
  element.append(toolbox)
  const services = document.createElement('section'); services.className = 'account-service'
  services.append(textNode('h3', '支付与服务'))
  element.append(services)
  const planLabel = (planId: string): string =>
    planId === 'toolbox' ? '工具箱使用权（历史订单）' : view.terms?.plans?.find((plan) => plan.id === planId)?.label ?? planId
  mountNetworkServices(services, planLabel)
  mountSubscriptionServices(services)
  mountSharingServices(services)
}

/** 网络套餐订单只作历史与售后记录；新购买统一从套餐卡片创建新订单。 */
function mountNetworkServices(parent: HTMLElement, planLabel: (planId: string) => string): void {
  const body = serviceGroup(parent, '网络套餐')
  const load = (): void => {
    body.replaceChildren(textNode('p', '正在读取…', 'account-note'))
    window.toolbox.account.paymentOrders().then((response) => {
      if (!body.isConnected) return
      const items = (JSON.parse(response.orders) as PaymentOrderView[]).slice()
        .sort((a, b) => (b.createdAt ?? b.paidAt ?? 0) - (a.createdAt ?? a.paidAt ?? 0))
      const active = items.filter((order) => networkActive(order.status))
      const history = items.filter((order) => !networkActive(order.status))
      body.replaceChildren()
      if (!items.length) { body.append(textNode('p', '暂无网络套餐付款记录。', 'account-note')); return }
      for (const order of [...active, ...history.slice(0, NETWORK_HISTORY_LIMIT)]) body.append(networkRow(order, planLabel))
      if (history.length > NETWORK_HISTORY_LIMIT) body.append(textNode('p', `另有 ${history.length - NETWORK_HISTORY_LIMIT} 笔更早记录未逐条列出。`, 'account-note'))
    }).catch(() => {
      if (!body.isConnected) return
      body.replaceChildren(
        textNode('p', '网络付款记录暂时无法读取，不代表没有待付款或已开通的套餐；可稍后重试。', 'account-note'),
        actionButton('重试读取', load))
    })
  }
  load()
}

function networkRow(order: PaymentOrderView, planLabel: (planId: string) => string): HTMLElement {
  const row = sectionRow(`${planLabel(order.planId)} · ${money(order.amountFen)} · ${networkStatusLabels[order.status]}`,
    `订单 ${order.orderId}${order.createdAt ? ` · 创建于 ${day(order.createdAt)}` : ''} · ${channelLabels[order.channel] ?? '线上支付'}`)
  if (order.refundedFen) row.append(textNode('p', `累计已退 ¥${(order.refundedFen / 100).toFixed(2)}；到账请核对原付款渠道。`))
  if (order.planId === 'toolbox') {
    // 旧 ¥19.9 使用权订单只读:工具箱已免费,历史订单不能再付款,只能取消待付款的残留单。
    if (order.status === 'open') row.append(textNode('p', '工具箱已免费，此历史订单无需付款；可取消以清理记录。', 'account-note'),
      actionButton('取消此订单', () => { void accountAction(() => window.toolbox.account.cancelPayment({ orderId: order.orderId })) }))
    return row
  }
  if (order.status === 'open') {
    row.append(textNode('p', order.cancelPending ? '等待渠道确认取消，请稍后刷新。' : '这是未完成的历史订单；如需购买，请回到套餐列表重新点击购买。', 'account-note'),
      actionButton('取消此订单', () => { void accountAction(() => window.toolbox.account.cancelPayment({ orderId: order.orderId })) }))
  } else if (order.status === 'paid') {
    row.append(textNode('p', '付款已确认，但本订单套餐未正常写入，这是处理异常；请联系客服核对，勿重复付款。', 'account-note'))
  }
  return row
}

/** 账号订阅摘要：状态与跳转由订阅模块真实状态驱动；付款、交付、售后仍在订阅页完成。 */
function mountSubscriptionServices(parent: HTMLElement): void {
  const body = serviceGroup(parent, '账号订阅')
  const load = (): void => {
    body.replaceChildren(textNode('p', '正在读取…', 'account-note'))
    window.toolbox.subscription.list().then((response) => {
      if (!body.isConnected) return
      if (response.error || !response.data) throw new Error(response.error || 'SUBSCRIPTION_UNAVAILABLE')
      const orders = (JSON.parse(response.data) as { orders: SubscriptionOrderView[] }).orders.slice().sort((a, b) => b.createdAt - a.createdAt)
      const active = orders.filter((order) => subscriptionActive(order.status))
      const history = orders.filter((order) => !subscriptionActive(order.status))
      body.replaceChildren()
      if (!orders.length) { body.append(textNode('p', '暂无账号订阅订单。', 'account-note')); return }
      for (const order of active) body.append(subscriptionRow(order))
      for (const order of history.slice(0, SERVICE_HISTORY_LIMIT)) body.append(subscriptionRow(order, false))
      if (history.length > SERVICE_HISTORY_LIMIT) body.append(textNode('p', '更多历史记录可在账号订阅页查看。', 'account-note'))
    }).catch(() => {
      if (!body.isConnected) return
      body.replaceChildren(
        textNode('p', '账号订阅记录暂时无法读取，不代表没有待付款或办理中的订单；可稍后重试或前往账号订阅页查看。', 'account-note'),
        actionButton('重试读取', load), actionButton('前往账号订阅页', () => requestTabNavigation('purchase')))
    })
  }
  load()
}

function subscriptionRow(order: SubscriptionOrderView, actions = true): HTMLElement {
  const row = sectionRow(`${order.product.name} · ${money(order.product.priceCents)} · ${subscriptionStatusLabels[order.status]}`,
    `订单 ${order.id} · 创建于 ${day(order.createdAt)} · ${channelLabels[order.channel] ?? order.channel}` +
    (order.paidAt ? ` · 已付款 ${day(order.paidAt)}` : '') +
    (order.dueAt && subscriptionActive(order.status) ? ` · 交付截止 ${day(order.dueAt)}` : ''))
  if (actions) row.append(actionButton(order.status === 'pending_payment' ? '去账号订阅页付款' : '查看账号订阅进度', () => requestTabNavigation('purchase')))
  return row
}

/** 账号分享租单摘要：只解释状态与入口，不展示交付资料，也不代办租单动作。 */
function mountSharingServices(parent: HTMLElement): void {
  const body = serviceGroup(parent, '账号分享')
  const load = (): void => {
    body.replaceChildren(textNode('p', '正在读取…', 'account-note'))
    window.toolbox.sharing.list().then((response) => {
      if (!body.isConnected) return
      if (response.error || !response.data) throw new Error(response.error || 'SHARING_UNAVAILABLE')
      const orders = (JSON.parse(response.data) as { orders: SharingOrderView[] }).orders.slice().sort((a, b) => b.createdAt - a.createdAt)
      const active = orders.filter((order) => sharingActive(order.status))
      const history = orders.filter((order) => !sharingActive(order.status))
      body.replaceChildren()
      if (!orders.length) { body.append(textNode('p', '暂无账号分享租单。', 'account-note')); return }
      for (const order of active) body.append(sharingRow(order))
      for (const order of history.slice(0, SERVICE_HISTORY_LIMIT)) body.append(sharingRow(order, false))
      if (history.length > SERVICE_HISTORY_LIMIT) body.append(textNode('p', '更多历史租单可在账号分享页查看。', 'account-note'))
    }).catch(() => {
      if (!body.isConnected) return
      body.replaceChildren(
        textNode('p', '账号分享租单暂时无法读取，不代表没有待付款或租用中的租单；可稍后重试或前往账号分享页查看。', 'account-note'),
        actionButton('重试读取', load), actionButton('前往账号分享页', () => requestTabNavigation('sharing')))
    })
  }
  load()
}

function sharingRow(order: SharingOrderView, actions = true): HTMLElement {
  const row = sectionRow(`${order.listing.name} · ${money(order.listing.priceCents)} · ${sharingStatusLabels[order.status]}`,
    `租单 ${order.id} · 创建于 ${day(order.createdAt)} · ${channelLabels[order.channel] ?? order.channel}` +
    (order.paidAt ? ` · 已付款 ${day(order.paidAt)}` : '') +
    (order.status === 'active' && order.expiresAt ? ` · 租期至 ${day(order.expiresAt)}` : '') +
    (order.status === 'pending_payment' && order.dueAt ? ` · 交付截止 ${day(order.dueAt)}` : ''))
  if (actions) row.append(actionButton(order.status === 'pending_payment' ? '去账号分享页付款' : '查看账号分享租单', () => requestTabNavigation('sharing')))
  return row
}
