import type { PageModule } from './types'
import type { AccountView, CommercialTerms } from '../../../account-types'
import { onAccountChange, requireAccount } from '../account-state'
import { requestTabNavigation } from '../navigation'
import { bundledGroupQr, invitePreview, resolveGroupQr, wecomGroupConfig, type GroupQrResolution, type WeComGroupConfig } from '../referral-config'
import './referral.css'

// 「邀请有礼 + 客户群」独立预览页：游客可见产品信息与位置占位；
// 登录后才读写真实邀请数据，复制等动作在未登录时引导去登录。
// 数值以账号条款（terms.invite）为准；条款缺失时按 R-01 定案显示 5 GB / 7 天预览值。

function textNode<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
function actionButton(label: string, action: () => void, primary = false): HTMLButtonElement {
  const button = textNode('button', label, primary ? 'primary-action' : 'secondary-action')
  button.type = 'button'; button.addEventListener('click', action); return button
}
const gb = (bytes: number): string => `${Math.round(bytes / 1024 ** 3)} GB`
const rewardAmount = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '暂时无法获取' : `${(value / 1024 ** 3).toFixed(2)} GB`
const durationText = (hours: number): string => hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`
const rewardCopy = (terms?: CommercialTerms | null): { amount: string; duration: string } =>
  terms?.invite ? { amount: gb(terms.invite.bytes), duration: durationText(terms.invite.hours) } : { amount: '5 GB', duration: '7 天' }
const previewBadge = (): HTMLElement => textNode('span', '本地预览', 'referral-preview-badge')

const rewardStateLabels: Record<string, string> = { pending: '待开通', provisioning: '正在开通', active: '可用', exhausted: '已用完', expired: '已到期', disabled: '已停用', unknown: '暂时无法确认', unavailable: '暂时无法确认' }
const rewardSourceLabels: Record<string, string> = { inviter: '邀请好友所得', invitee: '好友邀请奖励' }

function factsRow(facts: HTMLElement, label: string, value: string): void {
  const row = document.createElement('div'); row.append(textNode('dt', label), textNode('dd', value)); facts.append(row)
}

export interface InviteCardActions {
  /** 已登录时的真实复制（剪贴板）；由页面装配注入，便于测试。 */
  copyText(value: string): void
  /** 未登录时的状态变更动作统一引导去登录，登录后回到本页。 */
  goLogin(): void
}

export function buildInviteCard(view: AccountView, actions: InviteCardActions): HTMLElement {
  const card = document.createElement('section'); card.className = 'account-panel referral-card'
  const copy = rewardCopy(view.terms)
  card.append(textNode('p', '邀请有礼', 'section-eyebrow'), textNode('h2', `邀请好友，双方各得 ${copy.amount}`))
  const rules = document.createElement('ul'); rules.className = 'referral-rules'
  for (const rule of [`奖励有效期 ${copy.duration}`, '仅限一级直接邀请', '注册成功后到账']) rules.append(textNode('li', rule, 'referral-rule'))
  card.append(rules)

  const invite = view.state === 'signed-in' ? view.overview?.invite : undefined
  const status = textNode('p', '', 'account-note'); status.setAttribute('role', 'status')
  const codeActions = document.createElement('div'); codeActions.className = 'referral-actions'

  if (view.state !== 'signed-out' && !view.overview) {
    card.append(textNode('p', '暂时无法读取你的邀请信息，请稍后到「我的账号」刷新后重试。', 'account-note'))
  } else if (invite?.code) {
    const code = invite.code
    const facts = document.createElement('dl'); facts.className = 'account-facts'
    factsRow(facts, '我的邀请码', code)
    card.append(facts)
    codeActions.append(actionButton('复制邀请码', () => { actions.copyText(code); status.textContent = '已复制邀请码，可粘贴给好友。' }))
    // 0.5.3 线的 R-01 有码版移除了邀请链接（e0d6b2c）；字段仅在合成链接的主线版本存在时才出现链接按钮。
    const link = (invite as { link?: string }).link
    if (link) {
      codeActions.append(actionButton('复制邀请链接', () => { actions.copyText(link); status.textContent = '已复制邀请链接，可粘贴给好友。' }))
    }
    card.append(codeActions, status)
  } else if (view.state === 'signed-in') {
    card.append(textNode('p', '登录后这里会显示你的邀请码；邀请功能开放后即可分享给好友。', 'account-note'))
  } else {
    // 游客占位：只展示位置与形态；模拟值带「本地预览」标注，复制动作引导去登录，不提供真实值。
    const box = document.createElement('div'); box.className = 'referral-code-box'
    box.append(previewBadge(), textNode('strong', invitePreview.code))
    codeActions.append(actionButton('复制邀请码', actions.goLogin), actionButton('复制邀请链接', actions.goLogin))
    card.append(box, codeActions, textNode('p', '登录后即可生成你自己的邀请码。', 'account-note'))
  }

  card.append(textNode('h3', '邀请记录与奖励剩余', 'referral-section-title'))
  if (invite) {
    if (invite.rewards.length === 0) card.append(textNode('p', '还没有奖励记录；成功邀请好友注册后会显示在这里。', 'account-note'))
    for (const reward of invite.rewards) {
      const facts = document.createElement('dl'); facts.className = 'account-facts'
      for (const [label, value] of [
        ['奖励来源', rewardSourceLabels[reward.role] ?? '邀请奖励'],
        ['状态', rewardStateLabels[reward.state] ?? '暂时无法确认'],
        ['剩余', reward.state === 'expired' ? '0.00 GB' : rewardAmount(reward.remainingBytes)],
        ['到期', new Date(reward.expiresAt).toLocaleString('zh-CN')]
      ]) factsRow(facts, label, value)
      card.append(facts)
    }
    if (invite.rewards.some((reward) => reward.state === 'pending')) {
      card.append(actionButton('前往「我的账号」开通奖励流量', () => requestTabNavigation('account'), true))
    }
  } else if (view.state !== 'signed-out') {
    card.append(textNode('p', '暂时没有可显示的邀请记录，请稍后到「我的账号」查看。', 'account-note'))
  } else {
    // 游客占位行：示例值带「本地预览」标注；未登录不读取任何私人记录。
    const facts = document.createElement('dl'); facts.className = 'account-facts referral-sample'
    for (const [label, value] of [['奖励来源', '邀请好友所得'], ['状态', '可用'], ['剩余', invitePreview.sampleRemaining], ['到期', '发放起 7 天内']]) factsRow(facts, label, value)
    card.append(facts, previewBadge(), textNode('p', '登录后显示你的真实邀请记录与奖励剩余；以上为本地预览示例，不是真实到账。', 'account-note'))
  }
  return card
}

export function buildGroupCard(config: WeComGroupConfig, qr = bundledGroupQr(config)): HTMLElement {
  const card = document.createElement('section'); card.className = 'account-panel referral-card'
  card.append(textNode('p', config.label, 'section-eyebrow'), textNode('h2', config.title))
  card.append(textNode('p', config.description, 'referral-group-body'))
  if (qr.source !== 'unavailable') {
    const image = document.createElement('img'); image.className = 'referral-qr-image'
    image.alt = `${config.label}群二维码`; image.src = qr.imageUrl
    const note = textNode('p', qr.source === 'remote'
      ? '用微信扫码进群；这是企业微信官方群入口。'
      : '用微信扫码进群；群二维码正在使用随包备用码。', 'account-note')
    // 清单只会在图片先上传成功后替换；极少数图片读取失败时优先退回随包图。
    if (qr.source === 'remote') {
      const fallback = bundledGroupQr(config)
      image.addEventListener('error', () => {
        if (fallback.source === 'bundled') { image.src = fallback.imageUrl; note.textContent = '群二维码正在使用随包备用码。' }
        else { image.hidden = true; note.textContent = '群入口正在配置，请稍后回到本页查看。' }
      })
    }
    card.append(image, note)
  } else {
    const placeholder = document.createElement('div'); placeholder.className = 'referral-qr-placeholder'
    placeholder.append(textNode('strong', '群入口正在配置'),
      textNode('p', '管理员正在配置企业微信官方群活码，请稍后回到本页查看。'))
    card.append(placeholder)
  }
  return card
}

function paint(element: HTMLElement, view: AccountView, groupQr: GroupQrResolution): void {
  element.className = 'account-workspace referral-workspace'
  const intro = textNode('p', '', 'referral-intro')
  intro.append(previewBadge(), textNode('span', '本地预览版：邀请码与奖励为占位示例；客户群入口使用企业微信官方群活码，界面与规则以后续正式发布为准。'))
  const grid = document.createElement('div'); grid.className = 'referral-grid'
  grid.append(
    buildInviteCard(view, {
      copyText: (value) => { void navigator.clipboard?.writeText(value).catch(() => undefined) },
      goLogin: () => requireAccount('referral')
    }),
    buildGroupCard(wecomGroupConfig, groupQr)
  )
  element.replaceChildren(intro, grid)
}

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'referral.customer', tab: 'referral', order: 0,
  mount: (element) => {
    let active = true
    let latestView: AccountView | null = null
    let groupQr = bundledGroupQr()
    const render = () => { if (active && latestView) paint(element, latestView, groupQr) }
    // 账号订阅立即画出已有群活码或等待提示；官网清单返回后只重绘群码，不读取任何私人数据。
    const stop = onAccountChange((view) => { latestView = view; render() })
    void resolveGroupQr().then((next) => { if (active) { groupQr = next; render() } })
    cleanup = () => { active = false; stop(); element.replaceChildren() }
  },
  unmount: () => cleanup()
}
