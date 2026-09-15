import { app, shell } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { createPlanQuotaCache } from '../ai-access/plan-usage'
import { readPlatformUsage, type PlatformUsageDeps } from '../ai-access/platform-usage'
import { aiAccessShells } from '../ai-access/service'
import { modelProviders, type ModelProviderId } from '../../shared/model-providers'
import { isPlanUsagePlatformId, type PlanUsagePlatformId } from '../../shared/plan-usage-types'
import { productionAiAccessService } from './ai-access'
import { recipeStore, shellInventory } from '../shells/context'
import { trustedCliExecutable } from '../shells/inventory'
import { readClaudeQuota } from '../ai-access/claude-usage'
import { readClaudeOfficialAccount } from '../ai-access/official-account'
import { downloadTunnelSnapshot } from '../download/tunnel-runtime'

const paramsSchema = schema.object({ platform: schema.string({ maxLength: 40 }) })
const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 100_000 }) })

export function registerPlanUsageActions(
  registry: BridgeRegistry,
  deps: PlatformUsageDeps,
  open: (url: string) => Promise<void> = async (url) => { await shell.openExternal(url) }
): void {
  registry.registerAction({
    name: 'planusage.read', paramsSchema, resultSchema,
    handler: async (params) => ({ snapshot: JSON.stringify(await readPlatformUsage(readPlatform(params), deps)) })
  })
  // 界面只报平台名，地址由主进程解析：⛔ 让渲染层把任意网址递到 openExternal。
  registry.registerAction({
    name: 'planusage.openOfficialPage', paramsSchema, resultSchema,
    handler: async (params) => { await open(deps.officialPage(readPlatform(params))); return { snapshot: '{}' } }
  })
}

function readPlatform(params: unknown): PlanUsagePlatformId {
  const platform = (params as { readonly platform: string }).platform
  if (!isPlanUsagePlatformId(platform)) throw new Error('PLAN_USAGE_PLATFORM_INVALID')
  return platform
}

export function registerActions(registry: BridgeRegistry): void {
  const quota = createPlanQuotaCache()
  const access = productionAiAccessService()
  const requests = new Set<AbortController>()
  registry.registerShutdownHook('claude-usage', () => { requests.forEach(controller => controller.abort()) })
  registerPlanUsageActions(registry, {
    home: app.getPath('home'),
    readClaude: async () => {
      const home = app.getPath('home'), env = shellInventory().environment()
      const tunnel = downloadTunnelSnapshot()
      const environment = tunnel.state === 'connected' && tunnel.localProxyUrl ? { ...env, HTTP_PROXY: tunnel.localProxyUrl, HTTPS_PROXY: tunnel.localProxyUrl } : env
      const executable = await trustedCliExecutable('claude-code', process.platform, home, environment)
      if (executable === undefined) return { status: 'official-unavailable', plan: null }
      const before = await readClaudeOfficialAccount(executable, home, environment)
      if (before.state !== 'signed-in') return { status: 'official-unavailable', plan: null }
      const controller = new AbortController(); requests.add(controller)
      let result
      try { result = await readClaudeQuota({ executable }, home, environment, 30_000, controller.signal) }
      finally { requests.delete(controller) }
      const after = await readClaudeOfficialAccount(executable, home, environment)
      return after.state === 'signed-in' && before.accountKey === after.accountKey ? result : { status: 'official-unavailable', plan: null }
    },
    readQuota: (source, key) => quota.read(source, key),
    // Key 按壳分开存，客户填在哪个壳下都算数：挨个问，谁先有用谁的。
    providerKey: async (provider: ModelProviderId) => {
      for (const shell of aiAccessShells) {
        const key = await access.providerKey(shell, provider)
        if (key) return key
      }
      return undefined
    },
    officialPage: (platform) => officialPage(platform)
  })
}

/** 读不到用量时给客户的去处：能指到用量控制台的就指控制台，指不到的退回软件官网。 */
function officialPage(platform: PlanUsagePlatformId): string {
  const console: Partial<Record<PlanUsagePlatformId, ModelProviderId>> = {
    zcode: 'zhipu', 'kimi-code': 'kimi', 'deepseek-harness': 'deepseek'
  }
  const provider = console[platform]
  if (provider) return modelProviders[provider].keyUrl
  return recipeStore().current().shells[platform].officialPage
}
