import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { readNetworkDiagnosticStatus } from '../tunnel/runtime-owner'
import { probeDiagnosticUrl } from '../network-diagnostics/electron-probe'
import { isDiagnosticSoftware, runNetworkDiagnostics, type DiagnosticOptions, type DiagnosticSelection } from '../network-diagnostics/service'
import { modelProviderIds, type ModelProviderId } from '../../shared/model-providers'
import type { ApiServiceSnapshot } from '../../shared/api-service-types'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'

export function registerActions(registry: BridgeRegistry, options: DiagnosticOptions = { status: readNetworkDiagnosticStatus, probe: probeDiagnosticUrl }): void {
  let pending: Promise<{ snapshot: string }> | undefined
  let selected = ''
  const selection = options.selection ?? ((software: DiagnosticSoftware) => readSelection(registry, software))
  registry.registerAction({
    name: 'networkdiagnostics.run', paramsSchema: schema.object({ software: schema.string({ maxLength: 12 }) }),
    resultSchema: schema.object({ snapshot: schema.string({ maxLength: 10_000 }) }),
    handler: (params) => {
      const { software } = params as { software: string }
      if (!isDiagnosticSoftware(software)) throw new Error('DIAGNOSTIC_SOFTWARE_INVALID')
      if (pending) { if (selected !== software) throw new Error('DIAGNOSTIC_BUSY'); return pending }
      selected = software
      pending = runNetworkDiagnostics(software, { ...options, selection }).then((report) => ({ snapshot: JSON.stringify(report) })).finally(() => { pending = undefined })
      return pending
    }
  })
}

/** 当前选择只从已注册的 AI 接入动作读；读不到就报未知，⛔ 猜一个渠道。 */
async function readSelection(registry: BridgeRegistry, software: DiagnosticSoftware): Promise<DiagnosticSelection> {
  const unwrap = async <T>(name: string, params?: unknown): Promise<T> =>
    JSON.parse((await registry.execute(name, params) as { snapshot: string }).snapshot) as T
  try {
    const status = await unwrap<{ shells?: Record<string, { selected?: string | null }> }>('aiaccess.status')
    const mode = status.shells?.[software]?.selected ?? 'official'
    if (mode === 'official') return { mode: 'official' }
    if (!modelProviderIds.includes(mode as ModelProviderId)) return { mode: 'unknown' }
    const provider = mode as ModelProviderId
    const service = await unwrap<ApiServiceSnapshot>('aiaccess.serviceStatus')
    const configuration = await unwrap<{ endpoint?: string }>('aiaccess.providerConfiguration', { shell: software, provider })
    // 选了模型 API 就一定是经本机服务转发的；本机服务停了，路由表也是空的，⛔ 用路由表判断。
    return {
      mode: provider,
      ...(typeof configuration.endpoint === 'string' ? { endpoint: configuration.endpoint } : {}),
      routed: true,
      serviceRunning: service.running,
      observedClientCall: service.usage.find((stage) => stage.shell === software)?.observedClientCall ?? null
    }
  } catch { return { mode: 'unknown' } }
}
