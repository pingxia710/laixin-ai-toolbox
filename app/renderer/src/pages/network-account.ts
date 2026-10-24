import type { PageModule } from './types'
import type { AccountView } from '../../../account-types'
import { onAccountChange, refreshAccount, requireAccount } from '../account-state'
import { actionButton, mountAccountOverview, textNode } from '../ui/account-overview'

export function networkAllowance(view: AccountView): { remaining: string; expiry: string } {
  const overview = view.state === 'signed-in' ? view.overview : null
  if (!overview) return { remaining: '暂无数据', expiry: '到期时间：暂无数据' }
  if (!overview?.networkAvailable) return { remaining: '暂时无法确认', expiry: '请刷新账号状态后重试。' }
  const usages = [overview.trial.usage, ...(overview.subscriptions ?? (overview.subscription ? [overview.subscription] : []))]
    .filter(usage => usage !== null).map(usage => ({ ...usage, current: usage.measurement === 'current' }))
  const rewards = (overview.invite?.rewards ?? []).map(reward => ({ ...reward, current: reward.remainingBytes !== null }))
  const items = [...usages, ...rewards].filter(item => !['expired', 'exhausted', 'disabled'].includes(item.state))
  const pending = items.some(item => ['pending', 'queued', 'provisioning'].includes(item.state))
  const active = items.filter(item => !['pending', 'queued', 'provisioning'].includes(item.state))
  if (active.some(item => item.state !== 'active' || !item.current || item.remainingBytes === null || !Number.isFinite(item.remainingBytes) || item.remainingBytes < 0)) {
    return { remaining: '暂时无法确认', expiry: '部分用量尚未确认，请展开明细查看；无需重复付款。' }
  }
  const remaining = active.reduce((sum, item) => sum + item.remainingBytes!, 0)
  const expiries = active.filter(item => item.remainingBytes! > 0).map(item => item.expiresAt)
  const expiry = expiries.length === 0 ? pending ? '有流量正在开通，完成后计入可用额度。' : '暂无可用流量，可查看体验资格或购买套餐。'
    : expiries.some(value => value === null) ? '部分有效期尚未确认，请查看明细。'
      : `最近一份到期：${new Date(Math.min(...expiries as number[])).toLocaleString('zh-CN')}；各份流量独立到期。`
  return { remaining: `${(remaining / 1024 ** 3).toFixed(2)} GB`, expiry }
}

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'network.account', tab: 'tunnel', order: 5,
  mount: (element) => {
    cleanup()
    element.className = 'network-account'
    cleanup = onAccountChange((view) => {
      const opened = new Set(Array.from(element.querySelectorAll<HTMLDetailsElement>('details[open]')).map(detail => detail.className))
      const header = document.createElement('div'); header.className = 'network-account-header'
      const refresh = actionButton('刷新流量', () => { if (view.state === 'signed-out') requireAccount('tunnel'); else void refreshAccount() })
      refresh.className = 'text-action'
      header.append(textNode('h3', '我的流量'), refresh); element.replaceChildren(header)
      const summary = networkAllowance(view)
      element.append(textNode('p', '当前可用', 'account-note'), textNode('strong', summary.remaining, 'network-remaining'), textNode('p', summary.expiry, 'account-note'))
      const details = document.createElement('details'); details.className = 'network-allowance-details'; details.open = opened.has(details.className)
      details.append(textNode('summary', '查看流量明细与购买套餐'))
      const content = document.createElement('div')
      mountAccountOverview(content, view, 'tunnel')
      details.append(content); element.append(details)
      if (view.state !== 'signed-out' && view.message) { const message = textNode('p', view.message); message.setAttribute('role', 'status'); element.prepend(message) }
    })
    void refreshAccount()
  }, unmount: () => cleanup()
}
