import type { DiagnosticCheck, DiagnosticSoftware, NetworkDiagnosticReport } from '../../network-diagnostics-types'
import { connectivityTargets } from '../precheck/network-targets'
import { modelProviders, type ModelProviderId } from '../../shared/model-providers'

/** 没有选模型 API 时的落点：Codex / Claude 查各自官方站点，Hermes 按默认接 DeepSeek。 */
export const officialDiagnosticTargets = {
  codex: { url: 'https://chatgpt.com/', route: 'tunnel', label: 'Codex 官方' },
  claude: { url: 'https://api.anthropic.com/', route: 'tunnel', label: 'Claude 官方' },
  hermes: { url: 'https://api.deepseek.com/', route: 'direct', label: 'DeepSeek API' }
} as const
export const domesticDiagnosticUrl = connectivityTargets.find((target) => target.id === 'domestic')!.url

export interface DiagnosticTarget {
  readonly url: string
  readonly route: 'direct' | 'tunnel'
  /** 客户看得懂的名字，进检查文案。 */
  readonly label: string
}

/** 这个壳此刻实际在用哪一路；数据源是 ai-access 的状态快照与配方解析出的 endpoint。 */
export interface DiagnosticSelection {
  readonly mode: 'official' | ModelProviderId | 'unknown'
  /** 配方解析后的上游地址；没给就用内置地址。 */
  readonly endpoint?: string
  /** 这个壳是否已经把请求指向工具箱的本机 API 服务。 */
  readonly routed?: boolean
  /** 本机 API 服务是否在运行。 */
  readonly serviceRunning?: boolean
  /** 首次观察到这个 AI 自己发出的请求成功的时间。 */
  readonly observedClientCall?: string | null
}

function originUrl(endpoint: string): string | undefined {
  try { const url = new URL(endpoint); return url.protocol === 'https:' ? `https://${url.host}/` : undefined } catch { return undefined }
}

// Pending native-client combinations deliberately have no endpoint. Keep the diagnostic allowlist
// to valid HTTPS origins so a pending product cannot turn module loading or diagnostics into a crash.
const providerEndpointOrigins = Object.values(modelProviders)
  .flatMap((provider) => Object.values(provider.endpoints))
  .map(originUrl)
  .filter((endpoint): endpoint is string => endpoint !== undefined)
const domesticProviderHosts = new Set(providerEndpointOrigins.map((endpoint) => new URL(endpoint).host))

/** 诊断目标由该壳当前的选择决定，⛔ 再按软件名固定映射。 */
export function resolveDiagnosticTarget(software: DiagnosticSoftware, selection?: DiagnosticSelection): DiagnosticTarget {
  const mode = selection?.mode
  if (mode === undefined || mode === 'official' || mode === 'unknown') return officialDiagnosticTargets[software]
  const definition = modelProviders[mode]
  const url = originUrl(selection?.endpoint ?? '') ?? originUrl(definition.endpoints[software])
  if (url === undefined) return officialDiagnosticTargets[software]
  return { url, route: domesticProviderHosts.has(new URL(url).host) ? 'direct' : 'tunnel', label: definition.title }
}

/** 探测只允许打这些地址：国内基准点、三壳官方站点、四家服务商地址（含签名配方下发的地址）。 */
export function diagnosticProbeAllowed(url: string, route: 'direct' | 'tunnel', extraEndpoints: readonly string[] = []): boolean {
  if (url === domesticDiagnosticUrl) return route === 'direct'
  if (Object.values(officialDiagnosticTargets).some((target) => target.url === url && target.route === route)) return true
  const target = originUrl(url)
  // `probe()` uses this value verbatim. A provider origin in the allowlist must not authorize
  // an arbitrary customer-supplied path or query beneath that host.
  if (target === undefined || target !== url) return false
  const allowed = [...providerEndpointOrigins, ...extraEndpoints.map(originUrl).filter((endpoint): endpoint is string => endpoint !== undefined)]
  return allowed.includes(target) && (domesticProviderHosts.has(new URL(target).host) ? route === 'direct' : route === 'tunnel')
}

export interface DiagnosticTunnel {
  readonly state: string
  readonly lastVerifiedAt: string
  readonly configVersion: string
  readonly nodeLabel: string
  readonly unrestored: string
  readonly componentMissing: string
}
export interface DiagnosticProbeResult {
  readonly status: number
  readonly durationMs: number
}
export type DiagnosticProbeFailureKind = 'timeout' | 'unavailable'

// 底层异常内容不可进入客户界面或客服摘要，只传固定原因和经过时间。
export class DiagnosticProbeError extends Error {
  readonly name = 'DiagnosticProbeError'

  constructor(readonly kind: DiagnosticProbeFailureKind, readonly durationMs?: number) {
    super(`DIAGNOSTIC_PROBE_${kind.toUpperCase()}`)
  }
}
export interface DiagnosticOptions {
  readonly status: () => DiagnosticTunnel
  readonly probe: (url: string, route: 'direct' | 'tunnel') => Promise<DiagnosticProbeResult>
  readonly now?: () => number
  /** 读这个壳当前用的是哪一路；读不到就按官方站点检查并说明。 */
  readonly selection?: (software: DiagnosticSoftware) => Promise<DiagnosticSelection>
}
export function isDiagnosticSoftware(value: string): value is DiagnosticSoftware {
  return Object.hasOwn(officialDiagnosticTargets, value)
}

export async function runNetworkDiagnostics(software: string, options: DiagnosticOptions): Promise<NetworkDiagnosticReport> {
  if (!isDiagnosticSoftware(software)) throw new Error('DIAGNOSTIC_SOFTWARE_INVALID')
  const now = options.now ?? Date.now
  let selection: DiagnosticSelection | undefined
  try { selection = await options.selection?.(software) } catch { /* 读不到当前选择就按官方站点检查，并在文案里说明判不出。 */ }
  const target = resolveDiagnosticTarget(software, selection)
  const checks: DiagnosticCheck[] = []
  try {
    const response = await options.probe(domesticDiagnosticUrl, 'direct')
    const elapsedMs = checkedDuration(response.durationMs)
    checks.push(response.status === 204
      ? check('internet', 'passed', 'AI_DIAG_INTERNET_OK', '基础网络可用。', elapsedMs)
      : check('internet', 'attention', 'AI_DIAG_INTERNET_UNEXPECTED', '基础网络未返回预期结果，请检查 Wi-Fi 或是否需要网页登录。', elapsedMs))
  } catch (error) {
    const failure = probeFailure(error)
    checks.push(check('internet', 'unknown', failure.kind === 'timeout' ? 'AI_DIAG_INTERNET_TIMEOUT' : 'AI_DIAG_INTERNET_UNAVAILABLE',
      failure.kind === 'timeout' ? '基础网络检查超时，请确认网络后重试。' : '基础网络检查未完成，请确认网络后重试；单个检测地址不可达也可能造成此结果。', failure.durationMs))
  }
  let tunnel: DiagnosticTunnel | undefined
  try { tunnel = options.status() } catch { /* Missing state is unknown, never a connected result. */ }
  const verified = tunnel && freshConnection(tunnel, now())
  checks.push(target.route === 'direct'
    ? check('tunnel', 'not-checked', 'AI_DIAG_DIRECT_SERVICE', `${target.label} 在国内，按现行分流规则直连，不需要接通 AI网络。`)
    : verified ? check('tunnel', 'passed', 'AI_DIAG_TUNNEL_VERIFIED', '通道出口最近已通过校验。')
      : check('tunnel', 'attention', 'AI_DIAG_TUNNEL_REQUIRED', tunnel?.unrestored ? '请先在上方恢复原设置，再重新连接。'
        : tunnel?.componentMissing ? '工具箱网络组件不完整，请重新安装或联系客服。' : '请先连接 AI网络并等待校验完成，再重新检查。'))
  if (target.route === 'tunnel' && !verified) {
    checks.push(check('service', 'not-checked', 'AI_DIAG_TUNNEL_REQUIRED', '通道尚未确认，本次没有检查目标服务。'))
  } else {
    let result: DiagnosticCheck
    try { result = serviceResult(await options.probe(target.url, target.route)) }
    catch (error) {
      const failure = probeFailure(error)
      result = check('service', 'unknown', failure.kind === 'timeout' ? 'AI_DIAG_SERVICE_TIMEOUT' : 'AI_DIAG_SERVICE_UNAVAILABLE',
        failure.kind === 'timeout' ? '目标服务检查超时，请稍后重试。' : '未能取得目标服务响应，请重试；若持续失败，可复制检查结果给客服。', failure.durationMs)
    }
    if (target.route === 'tunnel') {
      let current: DiagnosticTunnel | undefined
      try { current = options.status() } catch { /* Invalidate the result when current state cannot be read. */ }
      if (!current || !freshConnection(current, now()) || current.nodeLabel !== tunnel?.nodeLabel || current.configVersion !== tunnel?.configVersion) {
        result = check('service', 'unknown', 'AI_DIAG_TUNNEL_CHANGED', '检查期间连接或配置发生变化，请连接稳定后重新检查。')
      }
    }
    checks.push(result)
  }
  checks.push(accountCheck(software, selection, target))
  checks.push(applicationCheck(software, selection))
  return { software, checkedAt: now(), checks }
}

const shellNames: Record<DiagnosticSoftware, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

/** 账号一类只说该查谁的 Key 或登录，⛔ 拿地址可达冒充账号已验证。 */
function accountCheck(software: DiagnosticSoftware, selection: DiagnosticSelection | undefined, target: DiagnosticTarget): DiagnosticCheck {
  const mode = selection?.mode
  if (mode !== undefined && mode !== 'official' && mode !== 'unknown') {
    return check('account', 'not-checked', 'AI_DIAG_ACCOUNT_PROVIDER',
      `${shellNames[software]} 现在用的是${target.label}。请到该服务商控制台确认 Key、余额与模型权限；本次只检查了地址能不能通，没有验证 Key。`)
  }
  if (mode === 'unknown') {
    return check('account', 'unknown', 'AI_DIAG_ACCOUNT_UNKNOWN',
      `这次没能读出 ${shellNames[software]} 当前用的是官方还是模型 API，按官方站点做的检查。请在工具箱的模型 API 页确认后重试。`)
  }
  return check('account', 'not-checked', 'AI_DIAG_ACCOUNT_MANUAL', software === 'hermes'
    ? '请在 Hermes 中确认所选模型、API Key 和 DeepSeek 余额。本次仅检查 DeepSeek 地址，没有验证模型请求。'
    : `请在 ${shellNames[software]} 中确认登录及额度，并尝试一次对话。服务地址可达不代表账号或对话已验证。`)
}

/** 「地址通」与「这个软件真的在用」是两件事；只有观察到它自己的成功请求才算用上了。 */
function applicationCheck(software: DiagnosticSoftware, selection: DiagnosticSelection | undefined): DiagnosticCheck {
  const name = shellNames[software]
  if (selection?.routed === true && selection.serviceRunning === false) {
    return check('application', 'attention', 'AI_DIAG_LOCAL_SERVICE_DOWN',
      `${name} 的请求指向工具箱的本机 API 服务，但该服务现在没有运行，所以连不上。请在模型 API 页重启本机 API 服务。`)
  }
  if (selection?.observedClientCall) {
    return check('application', 'passed', 'AI_DIAG_APPLICATION_OBSERVED',
      `已观察到 ${name} 在 ${new Date(selection.observedClientCall).toLocaleString('zh-CN')} 成功调用过工具箱的模型 API。`)
  }
  return check('application', 'not-checked', 'AI_DIAG_APPLICATION_UNCONFIRMED',
    `尚无法确认：本次检查没有观察到 ${name} 自己发出的请求。请直接在软件中重试一次；目标地址可达不代表登录或对话已成功。`)
}

function freshConnection(status: DiagnosticTunnel, now: number): boolean {
  const verifiedAt = Date.parse(status.lastVerifiedAt)
  return status.state === '已连' && !status.unrestored && !status.componentMissing &&
    Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 90_000
}
function serviceResult(response: DiagnosticProbeResult): DiagnosticCheck {
  const { status } = response
  const elapsedMs = checkedDuration(response.durationMs)
  if (status === 401) return check('service', 'attention', 'AI_DIAG_SERVICE_AUTH', '目标服务已响应并要求身份验证，请在目标软件中检查登录或 API Key。', elapsedMs)
  if (status === 403) return check('service', 'attention', 'AI_DIAG_SERVICE_RESTRICTED', '目标服务拒绝请求或需要浏览器验证，请打开目标软件查看具体提示。', elapsedMs)
  if (status === 429) return check('service', 'attention', 'AI_DIAG_SERVICE_LIMITED', '目标服务正在限制请求，请稍后重试；本次无法判断你的账号额度。', elapsedMs)
  if (status >= 500) return check('service', 'attention', 'AI_DIAG_SERVICE_ERROR', '目标服务返回服务端错误，请稍后重试。', elapsedMs)
  if ((status >= 200 && status < 400) || status === 404 || status === 405) {
    return check('service', 'passed', 'AI_DIAG_SERVICE_REACHABLE', '已收到目标服务的 HTTPS 响应；本次未发送对话，也未验证登录。', elapsedMs)
  }
  return check('service', 'unknown', 'AI_DIAG_SERVICE_UNEXPECTED', '目标服务返回了未能确认的结果，请在目标软件中查看提示。', elapsedMs)
}
function probeFailure(error: unknown): { readonly kind: DiagnosticProbeFailureKind, readonly durationMs: number | undefined } {
  if (error instanceof DiagnosticProbeError) return { kind: error.kind, durationMs: checkedDuration(error.durationMs) }
  return { kind: 'unavailable', durationMs: undefined }
}
function checkedDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 60_000 ? value : undefined
}
function check(id: DiagnosticCheck['id'], state: DiagnosticCheck['state'], code: string, message: string, elapsedMs?: number): DiagnosticCheck {
  const labels = { internet: '基础网络', tunnel: '通道出口', service: '目标服务', account: '登录与额度', application: '应用接入' }
  return { id, label: labels[id], state, code, message: elapsedMs === undefined ? message : `${message.replace(/。$/, '')}（耗时 ${String(elapsedMs)} ms）。`, ...(elapsedMs === undefined ? {} : { elapsedMs }) }
}
