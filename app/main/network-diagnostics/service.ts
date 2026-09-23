import { networkDiagnosticReportTtlMs, type DiagnosticCheck, type DiagnosticCheckCode, type DiagnosticConclusion, type DiagnosticConclusionEvidence, type DiagnosticSoftware, type NetworkDiagnosticReport } from '../../network-diagnostics-types'
import { connectivityTargets } from '../precheck/network-targets'
import { modelProviders, type ModelProviderId } from '../../shared/model-providers'
import type { ConfigurationState } from '../../shared/api-service-types'

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
  /** 当前绑定最近一次成功调用的时间；旧状态缺少最近值时兼容首次验收时间。 */
  readonly observedClientCall?: string | null
  /** 最近一次核对时，这个壳的配置是不是仍为工具箱写入的版本。 */
  readonly configuration?: ConfigurationState
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
  let selectionReadable = options.selection === undefined
  try { selection = await options.selection?.(software); selectionReadable = true } catch { /* 读不到当前选择就按官方站点检查，并在文案里说明判不出。 */ }
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
  let tunnelReadable = false
  try { tunnel = options.status(); tunnelReadable = true } catch { /* Missing state is unknown, never a connected result. */ }
  const verified = tunnel !== undefined && freshDiagnosticConnection(tunnel, now())
  checks.push(target.route === 'direct'
    ? check('tunnel', 'not-checked', 'AI_DIAG_DIRECT_SERVICE', `${target.label} 在国内，按现行分流规则直连，不需要接通 AI网络。`)
    : !tunnelReadable ? check('tunnel', 'unknown', 'AI_DIAG_TUNNEL_UNKNOWN', '这次没能读取当前通道状态，不能判断是否已连接。请重新检查。')
    : verified ? check('tunnel', 'passed', 'AI_DIAG_TUNNEL_VERIFIED', '通道出口最近已通过校验。')
      : check('tunnel', 'attention', 'AI_DIAG_TUNNEL_REQUIRED', tunnel?.unrestored ? '请先在上方恢复原设置，再重新连接。'
        : tunnel?.componentMissing ? '工具箱网络组件不完整，请重新安装或联系客服。' : '请先连接 AI网络并等待校验完成，再重新检查。'))
  if (target.route === 'tunnel' && !verified) {
    checks.push(check('service', 'not-checked', tunnelReadable ? 'AI_DIAG_TUNNEL_REQUIRED' : 'AI_DIAG_TUNNEL_UNKNOWN',
      tunnelReadable ? '通道尚未确认，本次没有检查目标服务。' : '当前通道状态读不到，本次没有检查目标服务。'))
  } else {
    let result: DiagnosticCheck
    try { result = serviceResult(await options.probe(target.url, target.route)) }
    catch (error) {
      const failure = probeFailure(error)
      result = check('service', 'unknown', failure.kind === 'timeout' ? 'AI_DIAG_SERVICE_TIMEOUT' : 'AI_DIAG_SERVICE_UNAVAILABLE',
        failure.kind === 'timeout' ? '目标服务检查超时，请稍后重试。' : '未能取得目标服务响应，请重试；若持续失败，可复制检查结果给客服。', failure.durationMs)
    }
    checks.push(result)
  }
  let contextChanged = false
  let tunnelChanged = false
  let currentSelection = selection
  let currentSelectionReadable = selectionReadable
  if (options.selection !== undefined) {
    currentSelection = undefined
    currentSelectionReadable = false
    try { currentSelection = await options.selection(software); currentSelectionReadable = true } catch { /* Compared below: unreadable twice stays unknown, not changed. */ }
    contextChanged = currentSelectionReadable !== selectionReadable ||
      (currentSelectionReadable && selectionReadable && diagnosticSelectionFingerprint(currentSelection) !== diagnosticSelectionFingerprint(selection))
  }
  if (target.route === 'tunnel') {
    let current: DiagnosticTunnel | undefined
    let currentReadable = false
    try { current = options.status(); currentReadable = true } catch { /* Invalidate the result when current state cannot be read. */ }
    const currentVerified = current !== undefined && freshDiagnosticConnection(current, now())
    tunnelChanged = currentReadable !== tunnelReadable || diagnosticTunnelFingerprint(current) !== diagnosticTunnelFingerprint(tunnel) ||
      currentVerified !== verified
  }
  const serviceIndex = checks.findIndex(check => check.id === 'service')
  if (tunnelChanged) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_TUNNEL_CHANGED', '检查期间通道发生变化，本次目标证据已失效，请重新检查。')
  else if (contextChanged) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_CONTEXT_CHANGED', '检查期间模型配置发生变化，本次目标证据已失效，请重新检查。')
  const evidenceSelection = !contextChanged && currentSelectionReadable ? currentSelection : selection
  checks.push(accountCheck(software, evidenceSelection, target))
  checks.push(applicationCheck(software, evidenceSelection, now()))
  const checkedAt = now()
  return {
    software,
    checkedAt,
    validUntil: checkedAt + networkDiagnosticReportTtlMs,
    target: { label: target.label, route: target.route },
    conclusion: diagnosticConclusion(software, target, checks, { selectionReadable, tunnelReadable }),
    checks
  }
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
function applicationCheck(software: DiagnosticSoftware, selection: DiagnosticSelection | undefined, now: number): DiagnosticCheck {
  const name = shellNames[software]
  if (selection?.routed === true && selection.serviceRunning === false) {
    return check('application', 'attention', 'AI_DIAG_LOCAL_SERVICE_DOWN',
      `${name} 的请求指向工具箱的本机 API 服务，但该服务现在没有运行，所以连不上。请在模型 API 页重启本机 API 服务。`)
  }
  if (selection?.observedClientCall && freshObservation(selection.observedClientCall, now)) {
    return check('application', 'passed', 'AI_DIAG_APPLICATION_OBSERVED',
      `已观察到 ${name} 在 ${new Date(selection.observedClientCall).toLocaleString('zh-CN')} 成功调用过工具箱的模型 API。`)
  }
  if (selection?.observedClientCall) {
    return check('application', 'not-checked', 'AI_DIAG_APPLICATION_STALE',
      `只读到 ${name} 较早的成功调用记录，不能作为本次可用证据。请在软件中重试一次后重新检查。`)
  }
  return check('application', 'not-checked', 'AI_DIAG_APPLICATION_UNCONFIRMED',
    `尚无法确认：本次检查没有观察到 ${name} 自己发出的请求。请直接在软件中重试一次；目标地址可达不代表登录或对话已成功。`)
}

function freshObservation(value: string, now: number): boolean {
  const observedAt = Date.parse(value)
  return Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= networkDiagnosticReportTtlMs
}

export function diagnosticSelectionFingerprint(selection: DiagnosticSelection | undefined): string {
  return JSON.stringify({
    mode: selection?.mode ?? 'official',
    endpoint: originUrl(selection?.endpoint ?? '') ?? '',
    routed: selection?.routed ?? null,
    configuration: selection?.configuration ?? null
  })
}

export function diagnosticTunnelFingerprint(tunnel: DiagnosticTunnel | undefined): string {
  return JSON.stringify(tunnel === undefined ? null : {
    state: tunnel.state,
    configVersion: tunnel.configVersion,
    nodeLabel: tunnel.nodeLabel,
    unrestored: tunnel.unrestored,
    componentMissing: tunnel.componentMissing
  })
}

function diagnosticConclusion(software: DiagnosticSoftware, target: DiagnosticTarget, checks: readonly DiagnosticCheck[],
  readable: { readonly selectionReadable: boolean, readonly tunnelReadable: boolean }): DiagnosticConclusion {
  const byId = (id: DiagnosticCheck['id']): DiagnosticCheck => checks.find(item => item.id === id)!
  const evidence = (...ids: readonly DiagnosticCheck['id'][]): readonly DiagnosticConclusionEvidence[] => ids.map((id) => {
    const item = byId(id)
    return { checkId: item.id, code: item.code, statement: item.message }
  })
  const application = byId('application')
  const tunnel = byId('tunnel')
  const service = byId('service')
  const account = byId('account')
  const softwareName = shellNames[software]

  if (service.code === 'AI_DIAG_CONTEXT_CHANGED' || service.code === 'AI_DIAG_TUNNEL_CHANGED') {
    return conclusion('unknown', 'diagnostic-context', 'DG01_EVIDENCE_CHANGED', '本次证据已失效',
      '检查期间连接或模型配置发生了变化，前后读数不能合并成一次结论。', '保持当前配置和通道不变，再点一次“开始检查”重新检查。', evidence('service'))
  }
  if (application.code === 'AI_DIAG_LOCAL_SERVICE_DOWN') {
    return conclusion('blocked', 'local-service', 'DG01_LOCAL_SERVICE_DOWN', '卡在本机 API 服务',
      `${softwareName} 已指向工具箱的本机 API 服务，但该服务当前没有运行。`, '到“模型 API”页重启本机 API 服务，再重新检查。', evidence('application'))
  }
  if (!readable.selectionReadable || account.code === 'AI_DIAG_ACCOUNT_UNKNOWN' || (target.route === 'tunnel' && !readable.tunnelReadable)) {
    return conclusion('unknown', 'diagnostic-context', 'DG01_CONTEXT_UNREADABLE', '本次还不能定位',
      '当前模型选择或通道状态没有完整读到，缺少形成归因所需的同次证据。', '确认工具箱页面可以正常读取状态后，再点一次“开始检查”重新检查。',
      evidence(target.route === 'tunnel' && !readable.tunnelReadable ? 'tunnel' : 'account'))
  }
  if (tunnel.code === 'AI_DIAG_TUNNEL_REQUIRED') {
    return conclusion('blocked', 'tunnel', 'DG01_TUNNEL_REQUIRED', '卡在 AI 网络通道',
      '当前目标需要经过 AI 网络，但本次没有读到新鲜的通道校验结果。', tunnel.message, evidence('tunnel', 'service'))
  }
  if (['AI_DIAG_SERVICE_AUTH', 'AI_DIAG_SERVICE_RESTRICTED', 'AI_DIAG_SERVICE_LIMITED'].includes(service.code)) {
    const summaries: Partial<Record<DiagnosticCheckCode, string>> = {
      AI_DIAG_SERVICE_AUTH: '目标服务对本次无认证探测返回身份验证要求。这只能证明目标有响应，不能判断你的登录、Key 或额度。',
      AI_DIAG_SERVICE_RESTRICTED: '目标服务拒绝了本次无认证探测，或要求浏览器验证。这只能证明目标有响应，不能判断账号状态。',
      AI_DIAG_SERVICE_LIMITED: '本次无认证探测收到限流响应。这只能证明目标有响应，不能判断账号额度。'
    }
    return conclusion('limited', 'target-service', 'DG01_TARGET_RESPONSE_BOUNDARY', '定位到目标服务响应边界', summaries[service.code]!,
      `回到 ${softwareName} 发起一次正常请求，以软件里的实际提示为准。`, evidence('service', 'account'))
  }
  if (['AI_DIAG_SERVICE_TIMEOUT', 'AI_DIAG_SERVICE_UNAVAILABLE', 'AI_DIAG_SERVICE_UNEXPECTED', 'AI_DIAG_SERVICE_ERROR'].includes(service.code)) {
    const path = target.route === 'tunnel' ? '经当前通道' : '直连'
    return conclusion('unknown', 'target-path', 'DG01_TARGET_PATH_UNCONFIRMED', '只能定位到目标访问路径',
      `当前证据只说明从本机${path}访问 ${target.label} 没有取得可确认响应；没有更深一层的观测，不能继续归因。`,
      '稍后重新检查；若持续失败，复制本次结果给客服。', evidence('tunnel', 'service'))
  }
  if (application.code === 'AI_DIAG_APPLICATION_OBSERVED' && service.state === 'passed') {
    return conclusion('clear', 'none', 'DG01_NO_BLOCKER_FOUND', '本次未发现明确阻断',
      `目标 ${target.label} 本次有响应，且最近观察到 ${softwareName} 成功调用工具箱的模型 API。`,
      `回到 ${softwareName} 重试原操作；若仍有问题，复制本次结果给客服。`, evidence('service', 'application'))
  }
  return conclusion('unknown', 'application', 'DG01_APPLICATION_UNCONFIRMED', '只能定位到应用验证这一步',
    `目标 ${target.label} 本次有响应，但没有 ${softwareName} 当前请求的成功证据，不能判断登录或对话结果。`,
    `回到 ${softwareName} 重试一次，再重新检查。`, evidence('service', 'application'))
}

function conclusion(status: DiagnosticConclusion['status'], scope: DiagnosticConclusion['scope'], ruleId: DiagnosticConclusion['ruleId'],
  title: string, summary: string, nextStep: string, evidence: readonly DiagnosticConclusionEvidence[]): DiagnosticConclusion {
  return { status, scope, ruleId, title, summary, nextStep, evidence }
}

export function freshDiagnosticConnection(status: DiagnosticTunnel, now: number): boolean {
  const verifiedAt = Date.parse(status.lastVerifiedAt)
  return status.state === '已连' && !status.unrestored && !status.componentMissing &&
    Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 90_000
}
function serviceResult(response: DiagnosticProbeResult): DiagnosticCheck {
  const { status } = response
  const elapsedMs = checkedDuration(response.durationMs)
  if (status === 401) return check('service', 'attention', 'AI_DIAG_SERVICE_AUTH', '本次检查没有携带客户认证，目标服务要求身份验证；这只说明目标有响应，不能判断登录、Key 或额度。', elapsedMs)
  if (status === 403) return check('service', 'attention', 'AI_DIAG_SERVICE_RESTRICTED', '目标服务拒绝了本次无认证检查，或要求浏览器验证；这只说明目标有响应，不能判断账号状态。', elapsedMs)
  if (status === 429) return check('service', 'attention', 'AI_DIAG_SERVICE_LIMITED', '本次无认证检查收到限流响应；这只说明目标有响应，不能判断账号额度。', elapsedMs)
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
function check(id: DiagnosticCheck['id'], state: DiagnosticCheck['state'], code: DiagnosticCheckCode, message: string, elapsedMs?: number): DiagnosticCheck {
  const labels = { internet: '基础网络', tunnel: '通道出口', service: '目标服务', account: '登录与额度', application: '应用接入' }
  return { id, label: labels[id], state, code, message: elapsedMs === undefined ? message : `${message.replace(/。$/, '')}（耗时 ${String(elapsedMs)} ms）。`, ...(elapsedMs === undefined ? {} : { elapsedMs }) }
}
