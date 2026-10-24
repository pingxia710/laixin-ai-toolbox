/**
 * 一个平台一份用量报告：先问官方接口，问不到退到本机记录，两头都没有就如实说不提供。
 * 顺序是固定的，⛔ 让「读不到」和「官方没有」显示成同一句话。
 */
import type { ModelProviderId } from '../../shared/model-providers'
import { planUsageProviders, type PlanUsagePlatformId, type PlanUsageReport } from '../../shared/plan-usage-types'
import { readKimiCodeLocalUsage, readZcodeLocalUsage, type LocalUsageResult } from './local-usage'
import type { PlanQuotaResult, PlanQuotaSource } from './plan-usage'
import type { ClaudeQuotaResult } from './claude-usage'

export interface PlatformUsageDeps {
  readonly home: string
  readonly readQuota: (source: PlanQuotaSource, key: string | undefined) => Promise<PlanQuotaResult>
  readonly providerKey: (provider: ModelProviderId) => Promise<string | undefined>
  readonly officialPage: (platform: PlanUsagePlatformId) => string
  readonly readLocal?: (platform: 'zcode' | 'kimi-code') => Promise<LocalUsageResult>
  readonly now?: () => number
  readonly readClaude?: () => Promise<ClaudeQuotaResult>
}

/** 哪个平台吃哪家套餐；没列进来的平台官方就是不提供用量查询。Key 归哪家服务商见共享的 `planUsageProviders`。 */
const planSources: Readonly<Partial<Record<PlanUsagePlatformId, PlanQuotaSource>>> = {
  zcode: 'zhipu',
  'kimi-code': 'kimi'
}

export async function readPlatformUsage(platform: PlanUsagePlatformId, deps: PlatformUsageDeps): Promise<PlanUsageReport> {
  const fetchedAt = (deps.now ?? Date.now)()
  const officialPage = deps.officialPage(platform)
  if (platform === 'claude-code') {
    const result = deps.readClaude ? await deps.readClaude() : { status: 'official-unavailable' as const, plan: null }
    return { platform, fetchedAt, officialPage, ...result, officialStatus: result.status, local: null }
  }
  const source = planSources[platform]
  const provider = planUsageProviders[platform]
  if (!source || !provider) return { platform, status: 'none', fetchedAt, plan: null, local: null, officialPage, officialStatus: 'none' }

  const quota = await deps.readQuota(source, await deps.providerKey(provider))
  if (quota.status === 'plan' && quota.quota) return { platform, status: 'plan', fetchedAt, plan: quota.quota, local: null, officialPage, officialStatus: 'plan' }

  const local = await readLocalUsage(platform as 'zcode' | 'kimi-code', deps)
  // 本机估算顶上来时，官方那一头为什么没读到必须一起送出去：
  // ⛔ 让 Key 填错、断网、没填 Key 的客户在屏幕上都看到「这家官方不提供用量接口」。
  if (local.status === 'local' && local.usage) {
    const report = { platform, status: 'local' as const, fetchedAt, plan: null, local: local.usage, officialPage, officialStatus: quota.status }
    return local.partial === true ? { ...report, partial: true } : report
  }

  // Key 被拒、连不上、返回看不懂都是客户能处理的事，必须盖过「本机没记录」说出来。
  const status = quota.status === 'key-missing' ? local.status : quota.status
  return { platform, status, fetchedAt, plan: null, local: null, officialPage, officialStatus: quota.status }
}

function readLocalUsage(platform: 'zcode' | 'kimi-code', deps: PlatformUsageDeps): Promise<LocalUsageResult> {
  if (deps.readLocal) return deps.readLocal(platform)
  const options = deps.now ? { now: deps.now } : {}
  return platform === 'zcode' ? readZcodeLocalUsage(deps.home, options) : readKimiCodeLocalUsage(deps.home, options)
}
