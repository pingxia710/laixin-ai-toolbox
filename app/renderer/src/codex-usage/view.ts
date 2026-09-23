import type { UsageStatus, UsageWindow } from '../../../main/codex-usage/types'
import { LOCAL_USAGE_DAYS, type ClaudeUsageFailureReason, type PlanUsageStatus } from '../../../shared/plan-usage-types'

export function usageEmptyState(status: UsageStatus): { title: string; description: string } {
  const states: Record<UsageStatus, { title: string; description: string }> = {
    idle: { title: '正在读取用量', description: '稍等一下，结果会自动显示。' },
    ready: { title: '暂未提供额度数据', description: '本次没有返回可显示的额度，请稍后刷新。' },
    unavailable: { title: '暂时读不到用量', description: '本次查询未完成，不代表账号未登录或额度已用完。稍后刷新即可。' },
    'not-installed': { title: '先安装 Codex', description: '安装 Codex 桌面版或 CLI 后，再回来查看账号用量。' },
    'not-added': { title: '添加账号', description: '套餐用量只读取在工具箱里登录过的账号。请到「账号总览」点「添加账号」完成一次官方登录。' },
    'signed-out': { title: '先在 Codex 中登录', description: '请使用你的 ChatGPT 账号登录 Codex，然后回到这里刷新。来信账号与 ChatGPT 账号分别使用。' },
    unsupported: { title: '当前登录方式不提供套餐用量', description: '本页显示 ChatGPT 套餐额度。当前登录方式的费用或额度请在对应服务中查看。' },
    'update-required': { title: '需要更新 Codex', description: '当前 Codex 版本还不支持用量查询。更新 Codex 后再刷新。' },
    timeout: { title: '读取时间有些长', description: '检查 Codex 能否正常联网，稍后再试。不需要重新注册或购买额度。' },
    'account-changed': { title: 'Codex 已切换账号', description: '已收起上个账号的数据。请刷新以读取当前账号的用量。' }
  }
  return states[status]
}

export function windowLabel(window: UsageWindow | null, fallback: string): string {
  const minutes = window?.windowDurationMins
  if (!minutes) return fallback
  if (minutes === 10_080) return '每周额度'
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天额度`
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`
  return `${minutes} 分钟额度`
}

export function percentText(value: number | null): string {
  return value === null ? '未知' : `${Math.round(value * 10) / 10}%`
}

export function resetText(seconds: number | null, now = Date.now()): string {
  if (seconds === null) return '重置时间暂未提供'
  if (seconds * 1_000 <= now) return '已到重置时间，等待刷新确认'
  const remaining = Math.ceil((seconds * 1_000 - now) / 60_000)
  const relative = remaining >= 1_440 ? `${Math.floor(remaining / 1_440)} 天 ${Math.floor(remaining % 1_440 / 60)} 小时`
    : remaining >= 60 ? `${Math.floor(remaining / 60)} 小时 ${remaining % 60} 分钟` : `${remaining} 分钟`
  return `${relative}后重置 · ${new Date(seconds * 1_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
}

/** Claude 官方用量没读到的四种原因各说各的话,各给客户能做的那件事(Phase 2 ④)。 */
const claudeFailureStates: Record<ClaudeUsageFailureReason, (label: string) => { title: string; description: string }> = {
  'not-installed': (label) => ({ title: `本机还没装 ${label}`, description: '装好并登录官方账号后回来刷新，这里会显示官方套餐额度。' }),
  'auth-required': (label) => ({ title: `先在 ${label} 中登录`, description: '套餐用量只读取已登录的官方账号。请完成官方登录后回来刷新；与来信账号分别使用。' }),
  'protocol-changed': (label) => ({ title: `${label} 返回了认不出的结果`, description: '官方接口的返回格式可能变了。请把客户端更新到最新版后再刷新；一直这样请联系来信客服。' }),
  timeout: () => ({ title: '读取时间有些长', description: '检查这台电脑能否正常联网，稍后再试。这次没读到不代表账号未登录或额度用完。' })
}

/** 国内壳与套餐用量：读不到的时候，屏幕上必须写清楚是哪一种读不到。 */
export function planUsageEmptyState(status: PlanUsageStatus, platformLabel: string, reason?: ClaudeUsageFailureReason): { title: string; description: string } {
  if (status === 'official-unavailable' && reason !== undefined) return claudeFailureStates[reason](platformLabel)
  const states: Record<PlanUsageStatus, { title: string; description: string }> = {
    'official-unavailable': { title: '官方套餐用量暂未读到', description: '本次查询没有完成，不代表账号未登录或额度用完。请确认 Claude Code 已更新且能联网，再刷新或打开官方页面查看。' },
    idle: { title: '正在读取用量', description: '稍等一下，结果会自动显示。' },
    plan: { title: '暂未提供额度数据', description: '本次没有返回可显示的额度，请稍后刷新。' },
    local: { title: '暂未算出本机用量', description: '本机记录里这段时间没有可统计的调用。' },
    none: { title: `${platformLabel}不提供用量查询`, description: `${platformLabel}官方没有提供查询套餐用量的接口，工具箱也就读不到。请到官方页面查看额度与重置时间。` },
    'key-missing': { title: '还没填这家的 Key', description: `在「模型接入」里填好 Key，工具箱才能替你读 ${platformLabel} 的套餐额度。也可以直接去官方页面看。` },
    'key-rejected': { title: 'Key 被服务商拒绝', description: '请确认填的是这家套餐的 Key（不是同一家开放平台的普通 API Key），改好后回来刷新。' },
    'network-error': { title: '连不上服务商', description: '这次没能连上，不代表额度用完了。检查网络后刷新即可。' },
    'invalid-reply': { title: '服务商返回的内容看不懂', description: '接口这次给的格式工具箱认不出来，稍后刷新再试；一直这样请联系来信客服。' },
    'not-installed': { title: `本机还没装 ${platformLabel}`, description: '装好并用过之后，这里才会有可统计的记录。' },
    'no-records': { title: '本机还没有使用记录', description: `用 ${platformLabel} 跑过对话之后，这里会显示最近 ${String(LOCAL_USAGE_DAYS)} 天的估算用量。` },
    unreadable: { title: '本机记录读不出来', description: '这次没读成，稍后刷新再试。记录本身不会被工具箱修改。' }
  }
  return states[status]
}

export function planResetText(at: number | null, now = Date.now()): string {
  return at === null ? '重置时间暂未提供' : resetText(Math.round(at / 1_000), now)
}

export function tokenText(tokens: number): string {
  if (tokens >= 100_000_000) return `${String(Math.round(tokens / 10_000_000) / 10)} 亿`
  if (tokens >= 10_000) return `${String(Math.round(tokens / 1_000) / 10)} 万`
  return String(tokens)
}

/**
 * 套餐额度是点数，写成「1 万」会把 10000 和 10400 抹成同一个数，客户看不出还剩多少。
 * 所以套餐这一栏原样显示（带千分位），万/亿的压缩只留给本机 Token 估算。
 */
export function quotaText(used: number | null, limit: number | null): string | null {
  if (used === null && limit === null) return null
  const amount = (value: number): string => value.toLocaleString('zh-CN')
  if (limit === null) return `已用 ${amount(used ?? 0)}`
  return `已用 ${amount(used ?? 0)} / ${amount(limit)}`
}
