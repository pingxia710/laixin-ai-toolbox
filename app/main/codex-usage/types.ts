export type UsageStatus = 'idle' | 'ready' | 'unavailable' | 'not-installed' | 'signed-out' | 'unsupported' | 'update-required' | 'timeout' | 'account-changed'

export interface UsageWindow {
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
}

export interface UsageBucket {
  readonly id: string
  readonly name: string
  readonly primary: UsageWindow | null
  readonly secondary: UsageWindow | null
  readonly credits: { readonly unlimited: boolean; readonly balance: string | null } | null
}

export interface UsageSnapshot {
  readonly accountKey?: string
  readonly accountLabel: string
  readonly plan: string | null
  readonly fetchedAt: number
  readonly buckets: readonly UsageBucket[]
}

export interface UsageReport {
  readonly status: UsageStatus
  readonly snapshot: UsageSnapshot | null
  readonly checkedAt: number | null
  readonly nextRefreshAt: number | null
}

export interface UsageBridgeResponse {
  readonly snapshot: string
}

export const REFRESH_INTERVAL_MS = 5 * 60_000
export const REFRESH_COOLDOWN_MS = 30_000

export const usageMessages: Readonly<Record<UsageStatus, string>> = {
  idle: '正在读取 Codex 账号用量…',
  ready: '用量已更新',
  unavailable: '暂时无法获取用量，请稍后刷新。',
  'not-installed': '未找到可读取用量的 Codex。请先安装 Codex 桌面版或 Codex CLI，然后刷新。',
  'signed-out': '请先在 Codex 中登录 ChatGPT 账号，再回到这里刷新。',
  unsupported: '当前登录方式不提供 ChatGPT 套餐额度。请在 Codex 中使用 ChatGPT 账号登录。',
  'update-required': '当前 Codex 版本不支持用量查询，请更新 Codex 后重试。',
  timeout: '读取用量超时，请检查 Codex 是否可以正常联网后重试。',
  'account-changed': '检测到 Codex 账号发生变化，请重新刷新。'
}
