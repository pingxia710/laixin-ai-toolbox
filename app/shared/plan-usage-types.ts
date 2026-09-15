/**
 * 国内三壳与套餐用量：一个平台一份报告。
 * 三种结局各自有自己的状态，⛔ 用同一句「暂未接入」盖过去：
 * 读到官方套餐配额 → plan；只读到本机记录 → local；官方压根不提供 → none。
 */
import type { ModelProviderId } from './model-providers'

export type PlanUsagePlatformId = 'claude-code' | 'hermes' | 'deepseek-harness' | 'zcode' | 'kimi-code'

export const planUsagePlatformIds: readonly PlanUsagePlatformId[] = ['claude-code', 'hermes', 'deepseek-harness', 'zcode', 'kimi-code']

/**
 * 哪个平台的套餐额度要用哪家服务商的 Key。主进程按它取 Key，界面按它决定「去填写 / 检查 Key」落到哪一行——
 * 两边必须是同一张表，⛔ 各写一份。填 Key 的地方在接入壳（Codex / Claude Code / Hermes）的「模型 API」页里，
 * **⛔ 在 zcode / kimi-code 自己那页**：那两页只说「工具箱不接管它的 API 配置」，一个输入口都没有。
 */
export const planUsageProviders: Readonly<Partial<Record<PlanUsagePlatformId, ModelProviderId>>> = {
  zcode: 'zhipu',
  'kimi-code': 'kimi'
}

export type PlanUsageStatus =
  | 'idle'
  | 'plan'
  | 'local'
  | 'none'
  | 'key-missing'
  | 'key-rejected'
  | 'network-error'
  | 'invalid-reply'
  | 'not-installed'
  | 'no-records'
  | 'unreadable'
  | 'official-unavailable'

export interface PlanQuotaWindow {
  readonly id: string
  readonly name: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly used: number | null
  readonly limit: number | null
  /** 下次重置时间（epoch 毫秒）。 */
  readonly resetsAt: number | null
}

export interface PlanQuota {
  /** 套餐等级，服务商没给就是 null。 */
  readonly level: string | null
  readonly windows: readonly PlanQuotaWindow[]
}

/** 本机离线统计：只读壳自己写的记录，是估算，⛔ 当账单。 */
export interface LocalUsage {
  readonly days: number
  readonly conversations: number
  readonly requests: number
  readonly tokens: number
  readonly newestAt: number | null
}

/**
 * 官方那一头这次的结局。本机估算顶上来时它必须跟着一起送到界面：
 * ⛔ 让「Key 被拒 / 连不上 / 还没填 Key」在屏幕上都长成「这家官方不提供用量接口」。
 */
export type OfficialUsageStatus = Extract<PlanUsageStatus,
  'plan' | 'none' | 'key-missing' | 'key-rejected' | 'network-error' | 'invalid-reply' | 'official-unavailable'>

export interface PlanUsageReport {
  readonly platform: PlanUsagePlatformId
  readonly status: PlanUsageStatus
  readonly fetchedAt: number
  readonly plan: PlanQuota | null
  readonly local: LocalUsage | null
  /** 读不到时让客户自己去看的官方页面。 */
  readonly officialPage: string
  /** 官方那一头这次是什么结局；只读到本机记录时，屏幕上靠它说清原因。 */
  readonly officialStatus?: OfficialUsageStatus
  /** 本机记录只读到一部分（有文件太大或读不动被跳过）：数字偏小，界面要说出来。 */
  readonly partial?: boolean
}

export const LOCAL_USAGE_DAYS = 7
export const PLAN_USAGE_CACHE_MS = 60_000
export const PLAN_USAGE_REFRESH_MS = 5 * 60_000

export const planUsageMessages: Readonly<Record<PlanUsageStatus, string>> = {
  'official-unavailable': '暂时无法读取官方套餐用量，请刷新或到官方页面查看。',
  idle: '正在读取用量…',
  plan: '套餐用量已更新',
  local: '官方没有提供用量接口，下面是工具箱按本机记录算的估算值',
  none: '该平台不提供用量查询，请到官方页面查看',
  'key-missing': '还没在工具箱填这家的 Key，填好后这里才能读到套餐用量',
  'key-rejected': 'Key 被服务商拒绝了，请确认填的是这家套餐的 Key',
  'network-error': '连不上服务商，请检查网络后重试',
  'invalid-reply': '服务商返回的内容看不懂，请稍后重试',
  'not-installed': '本机还没装这个软件，装好并用过之后才有用量',
  'no-records': '本机还没有这个软件的使用记录',
  'unreadable': '本机记录读不出来，请稍后重试'
}

export interface LocalUsageNotice {
  /** 顶上那句提示。 */
  readonly notice: string
  /** 本机统计块下面那句出处说明（不带句末标点，由页面接上时间）。 */
  readonly credits: string
  /** 客户这时能做的那一件事：去改 Key，还是重试一次。 */
  readonly action: 'key' | 'retry' | null
}

/** 官方那一头读失败的原因，写成客户看得懂的半句话。 */
const officialFailureReasons: Readonly<Partial<Record<OfficialUsageStatus, string>>> = {
  'key-rejected': 'Key 被服务商拒绝',
  'network-error': '连不上服务商',
  'invalid-reply': '服务商返回的内容看不懂',
  'official-unavailable': '本次查询没有完成'
}

/**
 * 只读到本机记录时屏幕上说什么。官方那一头是「这次没读到」「还没填 Key」还是「真的没有接口」，
 * 说法和客户该做的事都不一样：⛔ 一律写成「官方没有提供用量接口」——
 * 那会让 Key 填错或断网的客户以为永远看不到官方额度，不再回去修。
 */
export function localUsageNotice(official: OfficialUsageStatus | undefined, platformLabel: string): LocalUsageNotice {
  const estimate = '以下是工具箱按本机记录算的估算值'
  if (official === 'key-missing') {
    return { notice: `还没在工具箱填 ${platformLabel} 的 Key，${estimate}`, credits: '以上按本机记录估算；填好这家的 Key 后，这里会显示官方额度', action: 'key' }
  }
  // 只有真没有接口的平台（以及拿不到官方结局的旧报告）才保留「官方不提供」这句话。
  if (official === undefined || official === 'none') {
    return { notice: planUsageMessages.local, credits: `${platformLabel}官方没有用量查询接口，以上按本机记录估算`, action: null }
  }
  const reason = officialFailureReasons[official]
  return {
    notice: `本次未读到官方额度${reason ? `（${reason}）` : ''}，${estimate}`,
    credits: `以上按本机记录估算，不是官方额度${reason ? `（${reason}）` : ''}`,
    action: official === 'key-rejected' ? 'key' : 'retry'
  }
}

export interface PlanUsageBridgeResponse {
  readonly snapshot: string
}

export function isPlanUsagePlatformId(value: unknown): value is PlanUsagePlatformId {
  return typeof value === 'string' && (planUsagePlatformIds as readonly string[]).includes(value)
}

export function emptyPlanUsageReport(platform: PlanUsagePlatformId, officialPage: string): PlanUsageReport {
  return { platform, status: 'idle', fetchedAt: 0, plan: null, local: null, officialPage }
}
