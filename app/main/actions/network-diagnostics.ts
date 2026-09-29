import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { readNetworkDiagnosticStatus } from '../tunnel/runtime-owner'
import { probeDiagnosticUrl, readDiagnosticPathContext } from '../network-diagnostics/electron-probe'
import { DiagnosticProbeError, isDiagnosticSoftware, runNetworkDiagnostics, type DiagnosticOptions, type DiagnosticSelection } from '../network-diagnostics/service'
import type { AiAccessService } from '../ai-access/service'
import { modelProviderIds, type ModelProviderId } from '../../shared/model-providers'
import type { ApiServiceSnapshot } from '../../shared/api-service-types'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'

export function registerActions(registry: BridgeRegistry, options: DiagnosticOptions = {
  status: readNetworkDiagnosticStatus, probe: probeDiagnosticUrl, pathContext: readDiagnosticPathContext
}): void {
  let pending: Promise<{ snapshot: string }> | undefined
  let selected = ''
  const selection = options.selection ?? ((software: DiagnosticSoftware) => readSelection(registry, software))
  const probeIsolated = options.probeIsolated ?? (async (software: DiagnosticSoftware, revision: string) => {
    const result = await registry.execute('aiaccess.probeDiagnosticPath', { shell: software, revision }) as { snapshot: string }
    const response = JSON.parse(result.snapshot) as Awaited<ReturnType<AiAccessService['probeDiagnosticPath']>>
    if ('failure' in response) throw new DiagnosticProbeError(response.failure, response.durationMs)
    return response
  })
  const paramsSchema = schema.object({ software: schema.string({ maxLength: 12 }) })
  const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 10_000 }) })
  const run = (fresh: boolean) => (params: unknown) => {
    const { software } = params as { software: string }
    if (!isDiagnosticSoftware(software)) throw new Error('DIAGNOSTIC_SOFTWARE_INVALID')
    if (pending) { if (fresh || selected !== software) throw new Error('DIAGNOSTIC_BUSY'); return pending }
    selected = software
    pending = runNetworkDiagnostics(software, { ...options, selection, probeIsolated }).then((report) => ({ snapshot: JSON.stringify(report) })).finally(() => { pending = undefined })
    return pending
  }
  registry.registerAction({ name: 'networkdiagnostics.run', paramsSchema, resultSchema, handler: run(false) })
  registry.registerAction({ name: 'networkdiagnostics.runFresh', paramsSchema, resultSchema, handler: run(true) })
}

/** 当前选择只从已注册的 AI 接入动作读；读不到就报未知，⛔ 猜一个渠道。 */
export async function readSelection(registry: BridgeRegistry, software: DiagnosticSoftware): Promise<DiagnosticSelection> {
  const unwrap = async <T>(name: string, params?: unknown): Promise<T> =>
    JSON.parse((await registry.execute(name, params) as { snapshot: string }).snapshot) as T
  try {
    const status = await unwrap<{ shells?: Record<string, { selected?: string | null }> }>('aiaccess.status')
    const mode = status.shells?.[software]?.selected ?? 'official'
    if (mode === 'official') return { mode: 'official' }
    if (!modelProviderIds.includes(mode as ModelProviderId)) return { mode: 'unknown' }
    const provider = mode as ModelProviderId
    // 每次诊断都先读真实托管配置；serviceStatus 的 configuration/成功调用证据是缓存，
    // 客户在两次检查之间用其它工具删改配置时，不能拿旧成功记录判定当前正常。
    await unwrap<unknown>('aiaccess.verifyConfiguration')
    const service = await unwrap<ApiServiceSnapshot>('aiaccess.serviceStatus')
    const configuration = await unwrap<{ endpoint?: string }>('aiaccess.providerConfiguration', { shell: software, provider })
    const usage = service.usage.find((stage) => stage.shell === software)
    const route = service.routes?.find(item => item.shell === software && item.provider === provider)
    // 选了模型 API 就一定是经本机服务转发的；本机服务停了，路由表也是空的，⛔ 用路由表判断。
    return {
      mode: provider,
      ...(typeof configuration.endpoint === 'string' ? { endpoint: route?.isolated === true ? route.upstream : configuration.endpoint } : {}),
      ...(route?.isolated === true ? { isolated: true } : {}),
      ...(route?.revision === undefined ? {} : { routeRevision: route.revision }),
      routed: true,
      serviceRunning: service.running,
      observedClientCall: usage?.lastObservedClientCall === undefined ? usage?.observedClientCall ?? null : usage.lastObservedClientCall,
      lastClientAttempt: usage?.lastClientAttempt ?? null,
      ...(usage?.configuration ? { configuration: usage.configuration } : {})
    }
  } catch { return { mode: 'unknown' } }
}
