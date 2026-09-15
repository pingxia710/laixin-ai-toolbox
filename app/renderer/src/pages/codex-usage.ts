import { REFRESH_INTERVAL_MS, usageMessages, type UsageBucket, type UsageReport, type UsageWindow } from '../../../main/codex-usage/types'
import { PLAN_USAGE_REFRESH_MS, localUsageNotice, planUsageMessages, planUsageProviders, type PlanQuotaWindow, type PlanUsagePlatformId, type PlanUsageReport } from '../../../shared/plan-usage-types'
import { percentText, planResetText, planUsageEmptyState, quotaText, resetText, tokenText, usageEmptyState, windowLabel } from '../codex-usage/view'
import { requestModelApiNavigation, requestPlatformDownloadNavigation } from '../navigation'
import type { CodexUsageApi } from '../../../preload/api/codex-usage'
import type { PageModule } from './types'
import { usagePlatformLabel, type UsagePlatformId } from '../tabs'
import '../codex-usage/styles.css'
import { mountPlatformPage } from '../platform/view'
import { providerKeyShellPlatform } from '../platform/model'
import { readAccessStatus } from '../platform/access-status'
import type { AccountSummary } from '../platform/overview'

let teardown = (): void => undefined

export const page: PageModule = {
  moduleId: 'codex-usage', tab: 'usage', order: 10,
  mount: (element, context) => {
    const platform = context.usagePlatform ?? 'codex'
    teardown = mountPlatformPage(element, platform, (root, onAccount, onSignedOut, accountKey) => {
      if (platform === 'codex') return mountCodexUsage(root, window.toolbox.codexusage, onAccount, onSignedOut, accountKey)
      return mountPlatformUsage(root, platform, onAccount)
    }, context.platformSection, context.modelApiProvider)
  },
  unmount: () => teardown()
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}

/**
 * 非 Codex 平台的用量：主进程已经分清「读到套餐」「只有本机记录」「官方不提供」三种结局，
 * 这里照实显示，⛔ 再出现一句「暂未接入」把三种都盖住。
 */
function mountPlatformUsage(element: HTMLElement, platform: Exclude<UsagePlatformId, 'codex'>, onAccount?: (account: AccountSummary | null) => void): () => void {
  const label = usagePlatformLabel(platform)
  const api = window.toolbox.planusage
  let mounted = true
  let busy = false
  let lastAttempt = 0
  let report: PlanUsageReport | null = null

  const root = node('div', '', 'codex-usage')
  root.dataset.usagePlatform = platform
  const header = node('div', '', 'usage-header')
  header.append(node('h2', onAccount ? '套餐用量' : `${label} 使用量`))
  const refresh = node('button', '刷新用量', 'usage-refresh primary-action')
  refresh.type = 'button'
  header.append(refresh)
  const notice = node('p', planUsageMessages.idle, 'usage-notice')
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  const content = node('div', '', 'usage-content')
  const footer = node('p', '', 'usage-footnote')
  root.append(header, notice, content, footer)
  element.replaceChildren(root)

  const render = (): void => {
    const status = report?.status ?? 'idle'
    // 只读到本机记录时，官方那一头的结局决定了说什么、以及客户该做哪一件事。
    const hint = report?.status === 'local' && report.local ? localUsageNotice(report.officialStatus, label) : null
    notice.textContent = busy ? `正在读取 ${label} 的用量…` : hint ? hint.notice : planUsageMessages[status]
    notice.dataset.state = status
    notice.dataset.officialStatus = report?.officialStatus ?? ''
    refresh.disabled = busy || !api
    refresh.textContent = busy ? '正在刷新…' : '刷新用量'
    content.replaceChildren()
    footer.textContent = status === 'local'
      ? `本机统计由工具箱按 ${label} 自己写下的记录算出，只读不改，是估算值，与官方账单可能有出入。`
      : status === 'plan' ? '数据来自服务商的官方用量接口。' : ''
    if (report?.status === 'plan' && report.plan) {
      onAccount?.({ accountLabel: '', plan: report.plan.level })
      content.append(planView(onAccount ? null : report.plan.level, report.plan.windows)); return
    }
    if (report?.status === 'local' && report.local && hint) {
      content.append(localView(report.local, hint.credits, report.partial === true))
      if (hint.action) content.append(localAction(hint.action, platform, () => { void check() }))
      return
    }
    const empty = node('div', '', 'usage-empty')
    const state = planUsageEmptyState(status, label)
    empty.append(node('h3', state.title), node('p', state.description))
    if (report && api) {
      const open = node('button', '打开官方页面', 'primary-action')
      open.type = 'button'
      open.addEventListener('click', () => { void api.openOfficialPage({ platform }) })
      empty.append(open)
    }
    content.append(empty)
  }

  const check = async (): Promise<void> => {
    if (busy || !mounted || !api) return
    busy = true
    lastAttempt = Date.now()
    render()
    try {
      const response = await api.read({ platform })
      if (!mounted) return
      const value = JSON.parse(response.snapshot) as PlanUsageReport
      report = value.status in planUsageMessages ? value : failed(platform)
    } catch {
      if (!mounted) return
      report = failed(platform)
    } finally {
      busy = false
      if (mounted) render()
    }
  }

  const visibleRefresh = (): void => {
    if (document.visibilityState === 'visible' && Date.now() - lastAttempt >= PLAN_USAGE_REFRESH_MS) void check()
  }
  const timer = setInterval(visibleRefresh, 30_000)
  refresh.addEventListener('click', () => { void check() })
  document.addEventListener('visibilitychange', visibleRefresh)
  render()
  if (api) void check()
  else { report = failed(platform); render() }

  return () => {
    mounted = false
    clearInterval(timer)
    document.removeEventListener('visibilitychange', visibleRefresh)
  }
}

function failed(platform: PlanUsagePlatformId): PlanUsageReport {
  return { platform, status: platform === 'claude-code' ? 'official-unavailable' : 'unreadable', fetchedAt: Date.now(), plan: null, local: null, officialPage: '' }
}

function planView(level: string | null, windows: readonly PlanQuotaWindow[]): HTMLElement {
  const quotas = node('div', '', 'usage-quotas')
  const bucket = node('section', '', 'usage-bucket')
  const title = node('h3', '套餐额度')
  bucket.append(title)
  if (level) bucket.append(node('span', level, 'usage-plan'))
  for (const quota of windows) bucket.append(planWindowView(quota))
  quotas.append(bucket)
  return quotas
}

function planWindowView(quota: PlanQuotaWindow): HTMLElement {
  const row = node('div', '', 'usage-window')
  row.append(node('h4', quota.name))
  const remaining = quota.remainingPercent
  const summary = node('div', '', 'usage-numbers')
  summary.append(node('strong', remaining === null ? '剩余额度未知' : `剩余 ${percentText(remaining)}`))
  const detail = quotaText(quota.used, quota.limit)
  summary.append(node('span', detail ?? `已用 ${percentText(quota.usedPercent)}`))
  row.append(summary)
  if (remaining !== null) {
    const progress = node('progress', '', 'usage-progress')
    progress.max = 100
    progress.value = remaining
    progress.dataset.level = remaining <= 10 ? 'low' : 'normal'
    progress.setAttribute('aria-label', `${quota.name}剩余 ${percentText(remaining)}`)
    row.append(progress)
  }
  row.append(node('p', planResetText(quota.resetsAt), 'usage-reset'))
  return row
}

/** 本机估算那一块。`credits` 由 `localUsageNotice` 按官方那一头的结局给出，⛔ 在这里硬写「官方没有接口」。 */
function localView(local: PlanUsageReport['local'] & object, credits: string, partial: boolean): HTMLElement {
  const quotas = node('div', '', 'usage-quotas')
  const bucket = node('section', '', 'usage-bucket')
  bucket.append(node('h3', `本机统计 · 最近 ${String(local.days)} 天`), node('span', partial ? '估算 · 不完整' : '估算', 'usage-plan'))
  const stats = node('div', '', 'usage-stats')
  for (const [name, value] of [['对话次数', `${String(local.conversations)} 次`], ['模型调用', `${String(local.requests)} 次`], ['约用 Token', tokenText(local.tokens)]] as const) {
    const item = node('div', '', 'usage-stat')
    item.append(node('span', name, 'usage-eyebrow'), node('strong', value))
    stats.append(item)
  }
  bucket.append(stats)
  // 有记录被跳过（文件太大或读不动）时，⛔ 把偏小的数字当成完整估算交给客户。
  if (partial) bucket.append(node('p', '部分记录未计入：有会话记录太大或读不出来，实际用量比这里显示的更多。', 'usage-credits'))
  bucket.append(node('p', local.newestAt === null
    ? `${credits}。`
    : `${credits}；最近一次调用 ${new Date(local.newestAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}。`, 'usage-credits'))
  quotas.append(bucket)
  return quotas
}

/**
 * 填这两家套餐 Key 的地方在接入壳（Codex / Claude Code / Hermes）的「模型 API」页里对应服务商那一行；
 * **⛔ 跳到 zcode / kimi-code 自己那页**——那页只写「工具箱不接管它的 API 配置」，客户没地方填，
 * 等于先叫他去改、再把门关上。落到哪个壳按「谁已经存了这家 Key」挑，都没有就 Codex。
 */
async function openProviderKeyEditor(platform: Exclude<UsagePlatformId, 'codex'>): Promise<void> {
  const provider = planUsageProviders[platform]
  if (!provider) return
  let status = null
  try {
    const api = window.toolbox.aiaccess
    if (api) status = readAccessStatus((await api.status()).snapshot)
  } catch { /* 状态读不到就按都没存过办，⛔ 因此不跳。 */ }
  requestModelApiNavigation(providerKeyShellPlatform(provider, status), document, provider)
}

/** 官方额度这次没读到时，给客户当下能做的那一件事：去改 Key，或者再查一次。 */
function localAction(action: 'key' | 'retry', platform: Exclude<UsagePlatformId, 'codex'>, retry: () => void): HTMLElement {
  const row = node('div', '', 'usage-empty')
  const button = node('button', action === 'key' ? '去填写 / 检查 Key' : '重新查询官方额度', 'primary-action')
  button.type = 'button'
  button.addEventListener('click', action === 'key' ? () => { void openProviderKeyEditor(platform) } : retry)
  row.append(button)
  return row
}

export function mountCodexUsage(element: HTMLElement, api: CodexUsageApi | undefined, onAccount?: (account: AccountSummary | null) => void, onSignedOut?: () => void, accountKey?: string): () => void {
  let mounted = true
  let busy = false
  let lastAttempt = 0
  let report: UsageReport = { status: 'idle', snapshot: null, checkedAt: null, nextRefreshAt: null }
  const root = node('div', '', 'codex-usage')
  root.dataset.usagePlatform = 'codex'
  const header = node('div', '', 'usage-header')
  const title = node('div')
  title.append(node('h2', onAccount ? '套餐用量' : 'Codex 使用量'))
  const refresh = node('button', '刷新用量', 'usage-refresh primary-action')
  refresh.type = 'button'
  header.append(title, refresh)
  const notice = node('p', usageMessages.idle, 'usage-notice')
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  const content = node('div', '', 'usage-content')
  const footer = node('p', '本页每 5 分钟自动刷新。显示本机 Codex 当前登录账号的套餐额度。', 'usage-footnote')
  root.append(header, notice, content, footer)
  element.replaceChildren(root)

  const updateButton = (): void => {
    const seconds = Math.max(0, Math.ceil(((report.nextRefreshAt ?? 0) - Date.now()) / 1_000))
    refresh.disabled = busy || !api || seconds > 0
    refresh.textContent = busy ? '正在刷新…' : seconds > 0 ? `${seconds} 秒后可刷新` : '刷新用量'
  }

  const render = (): void => {
    notice.textContent = usageMessages[report.status]
    notice.dataset.state = report.status
    const snapshot = report.status === 'ready' ? report.snapshot : null
    onAccount?.(snapshot)
    content.replaceChildren()
    if (!snapshot) {
      const empty = node('div', '', 'usage-empty')
      const state = usageEmptyState(report.status)
      empty.append(node('h3', state.title), node('p', state.description))
      if (report.status === 'not-installed') {
        const download = node('button', '查看下载/版本', 'primary-action'); download.type = 'button'
        download.addEventListener('click', () => requestPlatformDownloadNavigation('codex')); empty.append(download)
      }
      content.append(empty)
    } else {
      const account = node('aside', '', 'usage-account')
      account.append(node('span', '当前账号', 'usage-eyebrow'), node('h3', snapshot.accountLabel), node('span', snapshot.plan ?? '套餐暂未提供', 'usage-plan'), node('p', '在 Codex 中换号后，刷新这里的用量。'))
      const quotas = node('div', '', 'usage-quotas')
      for (const bucket of snapshot.buckets) quotas.append(bucketView(bucket))
      if (!onAccount) content.append(account)
      content.append(quotas)
      const stale = Date.now() - snapshot.fetchedAt >= REFRESH_INTERVAL_MS
      notice.textContent = `${stale ? '上次读取的数据，正在等待刷新' : '用量已更新'} · ${new Date(snapshot.fetchedAt).toLocaleTimeString('zh-CN')}`
    }
    updateButton()
  }

  const check = async (): Promise<void> => {
    if (busy || !mounted || !api) return
    busy = true
    lastAttempt = Date.now()
    updateButton()
    notice.textContent = '正在读取 Codex 最新用量…'
    try {
      const response = await (accountKey && api.refreshForAccount ? api.refreshForAccount({ accountKey }) : api.refresh())
      if (!mounted) return
      const value = JSON.parse(response.snapshot) as UsageReport
      if (!(value.status in usageMessages)) throw new Error('INVALID_USAGE_REPORT')
      if (accountKey && value.snapshot && value.snapshot.accountKey !== accountKey) throw new Error('ACCOUNT_CHANGED')
      report = value
      if (value.status === 'signed-out' || value.status === 'unsupported') queueMicrotask(() => { if (mounted) onSignedOut?.() })
    } catch {
      if (!mounted) return
      report = { status: 'unavailable', snapshot: null, checkedAt: Date.now(), nextRefreshAt: Date.now() + 30_000 }
    } finally {
      busy = false
      if (mounted) render()
    }
  }

  const visibleRefresh = (): void => {
    if (document.visibilityState === 'visible' && Date.now() - lastAttempt >= REFRESH_INTERVAL_MS) void check()
  }
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    updateButton()
    content.querySelectorAll<HTMLElement>('[data-reset-at]').forEach((line) => { line.textContent = resetText(Number(line.dataset.resetAt)) })
    if (Date.now() - lastAttempt >= REFRESH_INTERVAL_MS) void check()
  }, 1_000)
  refresh.addEventListener('click', check)
  document.addEventListener('visibilitychange', visibleRefresh)
  render()
  if (api) void check()
  else { report = { ...report, status: 'unavailable' }; render() }

  return () => {
    mounted = false
    clearInterval(timer)
    refresh.removeEventListener('click', check)
    document.removeEventListener('visibilitychange', visibleRefresh)
  }
}

function bucketView(bucket: UsageBucket): HTMLElement {
  const section = node('section', '', 'usage-bucket')
  section.append(node('h3', bucket.name))
  section.append(windowView(bucket.primary, '主要额度'), windowView(bucket.secondary, '其他周期额度'))
  if (bucket.credits) section.append(node('p', bucket.credits.unlimited ? '额外点数：不限量' : `额外点数：${bucket.credits.balance ?? '暂未提供'}`, 'usage-credits'))
  return section
}

function windowView(window: UsageWindow | null, fallback: string): HTMLElement {
  const row = node('div', '', 'usage-window')
  const label = windowLabel(window, fallback)
  row.append(node('h4', label))
  if (window === null) { row.append(node('p', '厂商暂未提供此周期的额度', 'usage-muted')); return row }
  const remaining = window.remainingPercent
  const summary = node('div', '', 'usage-numbers')
  summary.append(node('strong', remaining === null ? '剩余额度未知' : `剩余 ${percentText(remaining)}`), node('span', `已用 ${percentText(window.usedPercent)}`))
  row.append(summary)
  if (remaining !== null) {
    const progress = node('progress', '', 'usage-progress')
    progress.max = 100
    progress.value = remaining
    progress.dataset.level = remaining <= 10 ? 'low' : 'normal'
    progress.setAttribute('aria-label', `${label}剩余 ${percentText(remaining)}`)
    row.append(progress)
  }
  const reset = node('p', resetText(window.resetsAt), 'usage-reset')
  if (window.resetsAt !== null) reset.dataset.resetAt = String(window.resetsAt)
  row.append(reset)
  return row
}
