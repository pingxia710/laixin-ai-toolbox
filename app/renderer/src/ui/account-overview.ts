import type { NetworkUsageView } from '../../../shared/network-usage-types'
import type { AccountView, InviteOverview, NetworkPlan, PaymentChannelName } from '../../../account-types'
import { inviteCardHint, trialCardHint, trialCardTitle, trialClaimLabel } from '../../../commercial-copy'
import { accountAction, requireAccount, selectedNetworkPlan } from '../account-state'
import type { TabId } from '../tabs'
import { openPaymentDialog } from './payment-dialog'

export function textNode<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
export function actionButton(label: string, action: () => void, primary = false): HTMLButtonElement {
  const button = textNode('button', label, primary ? 'primary-action' : 'secondary-action')
  button.type = 'button'; button.addEventListener('click', action); return button
}
const amount = (value: number | null) => value === null || !Number.isFinite(value) ? '暂时无法获取' : `${(value / 1024 ** 3).toFixed(2)} GB`
const statusLabels: Record<string, string> = { pending: '待付款', provisioning: '正在开通', active: '可用', exhausted: '已用完', expired: '已到期', disabled: '已停用', unknown: '暂时无法确认' }
const rewardStateLabels: Record<string, string> = { pending: '待开通', provisioning: '正在开通', active: '可用', exhausted: '已用完', expired: '已到期', disabled: '已停用', unknown: '暂时无法确认', unavailable: '暂时无法确认' }
const rewardSourceLabels: Record<string, string> = { inviter: '邀请好友所得', invitee: '好友邀请奖励' }

function copyButton(label: string, value: string): HTMLButtonElement {
  return actionButton(label, () => { void navigator.clipboard?.writeText(value).catch(() => undefined) })
}

/** 「邀请有礼」卡：邀请码/带码链接复制、邀请来源、每笔奖励的来源/状态/剩余/到期与开通动作。 */
function renderInviteCard(invite: InviteOverview, view: AccountView): HTMLElement {
  const card = document.createElement('section'); card.className = 'account-usage-card'
  card.append(textNode('h4', '邀请有礼'), textNode('p', inviteCardHint(view.terms)))
  if (invite.code) {
    const facts = document.createElement('dl'); facts.className = 'account-facts'
    const row = document.createElement('div'); row.append(textNode('dt', '我的邀请码'), textNode('dd', invite.code))
    facts.append(row); card.append(facts)
    const actions = document.createElement('div'); actions.className = 'account-actions'
    actions.append(copyButton('复制邀请码', invite.code))
    card.append(actions)
  }
  if (invite.invitedBy) card.append(textNode('p', `邀请来源：好友 ${invite.invitedBy}`, 'account-note'))
  for (const reward of invite.rewards) {
    const facts = document.createElement('dl'); facts.className = 'account-facts'
    for (const [label, value] of [
      ['奖励来源', rewardSourceLabels[reward.role] ?? '邀请奖励'],
      ['状态', rewardStateLabels[reward.state] ?? '暂时无法确认'],
      ['剩余', reward.state === 'expired' ? '0.00 GB' : amount(reward.remainingBytes)],
      ['到期', new Date(reward.expiresAt).toLocaleString('zh-CN')]
    ]) {
      const row = document.createElement('div'); row.append(textNode('dt', label), textNode('dd', value)); facts.append(row)
    }
    card.append(facts)
  }
  if (invite.rewards.some((reward) => reward.state === 'pending')) {
    const redeem = actionButton('开通奖励流量', () => {
      redeem.disabled = true; redeem.textContent = '正在开通，请稍候…'
      void accountAction(() => window.toolbox.account.redeemInviteRewards())
    }, true)
    redeem.disabled = !view.overview?.networkAvailable
    card.append(redeem)
  }
  card.append(textNode('p', '一级直接邀请；邀请关系绑定后不可更改。奖励流量与体验、付费套餐相互独立。', 'account-note'))
  return card
}

export function mountAccountOverview(element: HTMLElement, view: AccountView, from: TabId): void {
  element.replaceChildren()
  element.append(textNode('h3', '流量与套餐'))
  const usage = view.overview?.subscription
  const cards = document.createElement('div'); cards.className = 'account-usage-grid'
  const trialCard = document.createElement('section'); trialCard.className = 'account-usage-card'
  const paidCard = document.createElement('section'); paidCard.className = 'account-usage-card'
  trialCard.append(textNode('h4', trialCardTitle(view.terms)))
  paidCard.append(textNode('h4', '付费套餐'))
  if (view.state !== 'signed-in' || !view.overview) {
    const hint = view.state === 'signed-out' ? '登录后查看' : '暂时无法获取'
    renderEmptyUsage(trialCard, hint); renderEmptyUsage(paidCard, hint)
  } else {
    const trial = view.overview.trial
    if (trial.usage) renderUsage(trialCard, trial.usage, view.terms?.plans)
    else renderEmptyUsage(trialCard, trialCardHint(view.terms))
    if (trial.available || trial.retryable) {
      const claim = actionButton(trial.usage?.state === 'expired' ? '补发未开通的体验' : trial.usage ? '重试领取配置' : trialClaimLabel(view.terms), () => {
        claim.disabled = true; claim.textContent = '正在开通，请稍候…'; void accountAction(() => window.toolbox.account.claimTrial())
      }, true)
      claim.disabled = !view.overview.networkAvailable
      trialCard.append(claim)
    }
    if (trial.compensated) trialCard.append(textNode('p', '此体验为未开通失败后的补发记录。', 'account-note'))
    if (trial.usage?.state === 'expired' && !trial.retryable && trial.usage.measurement === 'not-requested' && trial.usage.reasonCode !== 'NETWORK_AUTHORIZATION_EXPIRED') trialCard.append(textNode('p', '体验仍未开通成功，请联系客服核对失败记录。', 'account-note'))
    if (!view.overview.networkAvailable) renderEmptyUsage(paidCard, '网络开通服务尚未连接，当前无法确认订阅状态。')
    else if (!usage) renderEmptyUsage(paidCard, '尚未购买网络套餐，可在下方选择。')
    else if (usage.state === 'pending') {
      renderEmptyUsage(paidCard, `${view.terms?.plans.find((plan) => plan.id === usage.planId)?.label ?? view.overview.plans.find((plan) => plan.id === usage.planId)?.label ?? usage.planId} · 待付款`)
      paidCard.append(textNode('p', '在下方继续付款，或直接选择其他套餐。付款成功后自动开通。', 'account-note'))
    }
    else renderUsage(paidCard, usage, view.terms?.plans ?? view.overview.plans)
  }
  const invite = view.state === 'signed-in' ? view.overview?.invite : undefined
  if (invite) cards.append(renderInviteCard(invite, view))
  cards.append(trialCard, paidCard); element.append(cards)
  element.append(textNode('p', '优先使用有效的体验流量；其后是邀请奖励流量，最后自动使用已有的可用付费套餐。各份额度和期限独立计算。', 'account-note'))
  const plans = document.createElement('div'); plans.className = 'account-plans'
  const payChannels: readonly PaymentChannelName[] = view.state === 'signed-in' ? (view.overview?.paymentChannels ?? []) : []
  const canRenew = Boolean(usage && ['expired', 'exhausted'].includes(usage.state))
  const canPay = payChannels.length > 0 && (!usage || usage.state === 'pending' || canRenew) && view.overview?.networkAvailable === true
  const planRows = view.terms?.plans ?? view.overview?.plans ?? []
  for (const plan of planRows) {
    const row = document.createElement('div'); row.className = 'account-plan'
    const info = document.createElement('div'); info.append(textNode('strong', plan.label), textNode('span', `¥${(plan.priceCents / 100).toFixed(1)} / 月`))
    row.append(info)
    if (view.state === 'signed-out') row.append(actionButton('购买', () => requireAccount(from, plan.id), true))
    else if (canPay) {
      const payGroup = document.createElement('div'); payGroup.className = 'account-pay-group'
      for (const channel of payChannels) {
        const provider = channel === 'alipay' ? '支付宝' : '微信'
        const action = usage?.state === 'pending' && usage.planId === plan.id ? '继续付款' : selectedNetworkPlan() === plan.id ? '继续购买' : '购买'
        payGroup.append(actionButton(`${provider}${action}`, () => { openPaymentDialog(plan, channel) }, true))
      }
      row.append(payGroup)
    } else {
      const unavailable = actionButton(usage?.state === 'active' ? (usage.planId === plan.id ? '当前套餐使用中' : '到期或用完后购买') : '暂时无法购买', () => undefined)
      unavailable.disabled = true; row.append(unavailable)
    }
    plans.append(row)
  }
  const planNote = textNode('p', view.state === 'signed-out'
    ? '登录后即可购买。付款成功后自动开通，有效期从实际付款日起算一个月。'
    : canPay ? '付款成功后自动开通，有效期从实际付款日起算一个月。更换套餐时会先关闭原未付款订单。'
      : usage && !canRenew && usage.state !== 'pending' ? '当前套餐到期或用完后，可在这里续费或更换套餐。套餐状态暂时无法确认时，请刷新后重试。'
        : '在线购买暂时无法使用，请稍后刷新或联系来信客服。', 'account-note')
  const options = document.createElement('section'); options.className = 'network-plans'
  options.append(textNode('h3', '购买网络套餐'), plans, planNote); element.append(options)
}

function renderEmptyUsage(element: HTMLElement, message: string): void {
  element.append(textNode('p', message))
  const facts = document.createElement('dl'); facts.className = 'account-facts'
  for (const label of ['总量', '已用', '剩余', '到期']) {
    const row = document.createElement('div'); row.append(textNode('dt', label), textNode('dd', '—')); facts.append(row)
  }
  element.append(facts)
}

function renderUsage(element: HTMLElement, usage: NetworkUsageView, plans?: readonly NetworkPlan[]): void {
  element.append(textNode('p', `${usage.kind === 'trial' ? '体验流量' : plans?.find((plan) => plan.id === usage.planId)?.label ?? usage.planId} · ${statusLabels[usage.state] ?? '暂时无法确认'}`))
  const facts = document.createElement('dl'); facts.className = 'account-facts'
  for (const [label, value] of [['总量', amount(usage.totalBytes)], ['已用', amount(usage.measurement === 'current' ? usage.usedBytes : null)], ['剩余', amount(usage.measurement === 'current' ? usage.remainingBytes : null)],
    ['到期', usage.expiresAt ? new Date(usage.expiresAt).toLocaleString('zh-CN') : '开通后确定']]) {
    const row = document.createElement('div'); row.append(textNode('dt', label), textNode('dd', value)); facts.append(row)
  }
  element.append(facts)
  if (usage.measurement === 'current' && usage.usedBytes !== null && usage.totalBytes > 0) {
    const meter = document.createElement('meter'); meter.min = 0; meter.max = usage.totalBytes; meter.value = Math.min(usage.usedBytes, usage.totalBytes)
    meter.setAttribute('aria-label', usage.kind === 'trial' ? '体验已用流量' : '本周期已用流量'); element.append(meter)
  }
}

export function trafficSummary(usage: NetworkUsageView): { remaining: string; detail: string } {
  const remaining = usage.measurement === 'current' ? amount(usage.remainingBytes) : '暂时无法获取'
  const expires = usage.expiresAt ? new Date(usage.expiresAt).toLocaleString('zh-CN') : '开通后确定有效期'
  return { remaining, detail: `${statusLabels[usage.state] ?? '暂时无法确认'} · ${expires}` }
}

export function mountTrafficSummary(element: HTMLElement, view: AccountView): void {
  element.append(textNode('p', '账号服务', 'section-eyebrow'), textNode('h2', '我的网络流量'))
  const overview = view.state === 'signed-in' ? view.overview : null
    for (const [label, usage, empty] of [
      ['体验流量', overview?.trial.usage, overview?.trial.available ? '尚未领取' : '暂无可用体验'],
      ['付费套餐', overview?.subscription, '尚未购买网络套餐']
    ] as const) {
      const row = document.createElement('section'); row.className = 'traffic-summary'
      row.append(textNode('h3', label))
      if (usage) {
        const summary = trafficSummary(usage)
        row.append(textNode('strong', summary.remaining === '暂时无法获取' ? summary.remaining : `剩余 ${summary.remaining}`), textNode('p', summary.detail))
        if (usage.measurement === 'current' && usage.usedBytes !== null && Number.isFinite(usage.usedBytes) && usage.totalBytes > 0) {
          const meter = document.createElement('meter'); meter.min = 0; meter.max = usage.totalBytes; meter.value = Math.max(0, Math.min(usage.usedBytes, usage.totalBytes))
          meter.setAttribute('aria-label', `${label}已用流量`)
          row.append(meter, textNode('p', `已用 ${amount(usage.usedBytes)} / 总量 ${amount(usage.totalBytes)}`, 'account-note'))
        }
      } else row.append(textNode('strong', '—'), textNode('p', view.state === 'signed-out' ? '登录后查看' : !overview ? '暂时无法获取流量权益' : overview.networkAvailable ? empty : '网络开通服务暂时无法连接'))
      element.append(row)
    }
  element.append(actionButton(view.state === 'signed-in' ? '查看流量与套餐' : '前往我的账号', () => requireAccount('dashboard')))
}
