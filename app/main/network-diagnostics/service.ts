import { networkDiagnosticReportTtlMs, type DiagnosticCheck, type DiagnosticCheckCode, type DiagnosticConclusion,
  type DiagnosticConclusionEvidence, type DiagnosticPathKind, type DiagnosticPathMatrixEntry, type DiagnosticProbePhase,
  type DiagnosticProbeRoute, type DiagnosticSoftware, type NetworkDiagnosticReport, type DiagnosticPathMatrix } from '../../network-diagnostics-types'
import { connectivityTargets } from '../precheck/network-targets'
import { modelProviders, type ModelProviderId } from '../../shared/model-providers'
import type { ApiFailure, ConfigurationState } from '../../shared/api-service-types'

/** 没有选模型 API 时的落点：Codex / Claude 查各自官方站点，Hermes 按默认接 DeepSeek。 */
export const officialDiagnosticTargets = {
  codex: { url: 'https://chatgpt.com/', route: 'tunnel', label: 'Codex 官方' },
  claude: { url: 'https://api.anthropic.com/', route: 'tunnel', label: 'Claude 官方' },
  hermes: { url: 'https://api.deepseek.com/', route: 'direct', label: 'DeepSeek API' }
} as const
export const domesticDiagnosticUrl = connectivityTargets.find((target) => target.id === 'domestic')!.url

export interface DiagnosticTarget {
  readonly url: string
  readonly route: 'direct' | 'tunnel' | 'isolated'
  /** 客户看得懂的名字，进检查文案。 */
  readonly label: string
}

/** 这个壳此刻实际在用哪一路；数据源是 ai-access 的状态快照与配方解析出的 endpoint。 */
export interface DiagnosticSelection {
  /** Opaque gateway generation; comparison only, never included in the customer report. */
  readonly routeRevision?: string
  readonly isolated?: boolean
  readonly mode: 'official' | ModelProviderId | 'unknown'
  /** 配方解析后的上游地址；没给就用内置地址。 */
  readonly endpoint?: string
  /** 这个壳是否已经把请求指向工具箱的本机 API 服务。 */
  readonly routed?: boolean
  /** 本机 API 服务是否在运行。 */
  readonly serviceRunning?: boolean
  /** 当前绑定最近一次成功调用的时间；旧状态缺少最近值时兼容首次验收时间。 */
  readonly observedClientCall?: string | null
  /** 当前路由上最近一次已落定的客户端请求；客户主动取消不进这个字段。 */
  readonly lastClientAttempt?: { readonly at: string; readonly ok: boolean; readonly code?: ApiFailure } | null
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
  return { url, route: selection?.isolated === true ? 'isolated' : domesticProviderHosts.has(new URL(url).host) ? 'direct' : 'tunnel', label: definition.title }
}

/** 探测只允许打这些地址：国内基准点、三壳官方站点、四家服务商地址（含签名配方下发的地址）。 */
export function diagnosticProbeAllowed(url: string, route: DiagnosticProbeRoute, extraEndpoints: readonly string[] = []): boolean {
  if (url === domesticDiagnosticUrl) return route === 'direct'
  const comparison = route === 'direct' || route === 'existing-proxy' || route === 'laixin-tunnel'
  if (Object.values(officialDiagnosticTargets).some((target) => target.url === url && (comparison || target.route === route))) return true
  const target = originUrl(url)
  // `probe()` uses this value verbatim. A provider origin in the allowlist must not authorize
  // an arbitrary customer-supplied path or query beneath that host.
  if (target === undefined || target !== url) return false
  const allowed = [...providerEndpointOrigins, ...extraEndpoints.map(originUrl).filter((endpoint): endpoint is string => endpoint !== undefined)]
  return allowed.includes(target) && (comparison || !domesticProviderHosts.has(new URL(target).host))
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
  readonly phase?: DiagnosticProbePhase
}
export type DiagnosticProbeFailureKind = 'timeout' | 'unavailable' | 'path-unavailable'

// 底层异常内容不可进入客户界面或客服摘要，只传固定原因和经过时间。
export class DiagnosticProbeError extends Error {
  readonly name = 'DiagnosticProbeError'

  constructor(readonly kind: DiagnosticProbeFailureKind, readonly durationMs?: number, readonly phase?: DiagnosticProbePhase) {
    super(`DIAGNOSTIC_PROBE_${kind.toUpperCase()}`)
  }
}
export interface DiagnosticOptions {
  readonly probeIsolated?: (software: DiagnosticSoftware, revision: string) => Promise<DiagnosticProbeResult>
  readonly status: () => DiagnosticTunnel
  readonly probe: (url: string, route: DiagnosticProbeRoute) => Promise<DiagnosticProbeResult>
  /** 读取三条路径的脱敏内部指纹；只用于判断检查期间路径是否变化，不进入报告。 */
  readonly pathContext?: (url: string) => Promise<string>
  readonly now?: () => number
  /** 独立路径的服务层兜底时限；生产默认略长于 Electron 探针自身的 5 秒。 */
  readonly matrixProbeTimeoutMs?: number
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
      ? check('internet', 'passed', 'AI_DIAG_INTERNET_OK', '基础网络可用。', elapsedMs, 'http')
      : check('internet', 'attention', 'AI_DIAG_INTERNET_UNEXPECTED', '基础网络已收到 HTTP 响应，但不是预期结果；请检查是否需要网页登录。', elapsedMs, 'http'))
  } catch (error) {
    const failure = probeFailure(error)
    checks.push(internetFailure(failure))
  }
  let tunnel: DiagnosticTunnel | undefined
  let tunnelReadable = false
  try { tunnel = options.status(); tunnelReadable = true } catch { /* Missing state is unknown, never a connected result. */ }
  const verified = tunnel !== undefined && freshDiagnosticConnection(tunnel, now())
  checks.push(target.route === 'isolated'
    ? check('tunnel', 'not-checked', 'AI_DIAG_ISOLATED_SERVICE', `${shellNames[software]} 的模型 API 正使用应用隔离出口，本次沿用该出口检查；不涉及登录流量。`)
    : target.route === 'direct'
    ? check('tunnel', 'not-checked', 'AI_DIAG_DIRECT_SERVICE', `${target.label} 在国内，按现行分流规则直连，不需要接通 AI网络。`)
    : !tunnelReadable ? check('tunnel', 'unknown', 'AI_DIAG_TUNNEL_UNKNOWN', '这次没能读取当前通道状态，不能判断是否已连接。请重新检查。')
    : verified ? check('tunnel', 'passed', 'AI_DIAG_TUNNEL_VERIFIED', '通道出口最近已通过校验。')
      : check('tunnel', 'attention', 'AI_DIAG_TUNNEL_REQUIRED', tunnel?.unrestored ? '请先在上方恢复原设置，再重新连接。'
        : tunnel?.componentMissing ? '工具箱网络组件不完整，请重新安装或联系客服。' : '请先连接 AI网络并等待校验完成，再重新检查。'))
  let primaryPathFailed = false
  if (target.route === 'tunnel' && !verified) {
    primaryPathFailed = true
    checks.push(check('service', 'unknown', 'AI_DIAG_PRIMARY_PATH_UNAVAILABLE',
      '当前通道尚未确认，本次主路径未检查；下方独立比较直连和系统现有代理，不会自动连接或修改设置。'))
  } else {
    let result: DiagnosticCheck
    try {
      if (target.route === 'isolated') {
        if (options.probeIsolated === undefined || !selection?.routeRevision) throw new DiagnosticProbeError('path-unavailable')
        result = serviceResult(await options.probeIsolated(software, selection.routeRevision))
      } else result = serviceResult(await options.probe(target.url, target.route))
    }
    catch (error) {
      primaryPathFailed = true
      const failure = probeFailure(error)
      result = serviceFailure(failure)
    }
    checks.push(result)
  }
  const matrixContextBefore = primaryPathFailed ? await readMatrixContext(target.url, options) : undefined
  const matrixEntries = primaryPathFailed ? await compareDiagnosticPaths(target.url, options, verified) : undefined
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
  if (target.route === 'tunnel' || matrixEntries !== undefined) {
    let current: DiagnosticTunnel | undefined
    let currentReadable = false
    try { current = options.status(); currentReadable = true } catch { /* Invalidate the result when current state cannot be read. */ }
    const currentVerified = current !== undefined && freshDiagnosticConnection(current, now())
    tunnelChanged = currentReadable !== tunnelReadable || diagnosticTunnelFingerprint(current) !== diagnosticTunnelFingerprint(tunnel) ||
      currentVerified !== verified
  }
  const matrixContextAfter = matrixEntries === undefined ? undefined : await readMatrixContext(target.url, options)
  const pathContextUnreadable = matrixContextBefore !== undefined && matrixContextAfter !== undefined &&
    (!matrixContextBefore.readable || !matrixContextAfter.readable)
  const pathContextChanged = matrixContextBefore?.readable === true && matrixContextAfter?.readable === true &&
    matrixContextBefore.value !== matrixContextAfter.value
  const serviceIndex = checks.findIndex(check => check.id === 'service')
  if (tunnelChanged) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_TUNNEL_CHANGED', '检查期间通道发生变化，本次目标证据已失效，请重新检查。')
  else if (contextChanged) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_CONTEXT_CHANGED', '检查期间模型配置发生变化，本次目标证据已失效，请重新检查。')
  else if (pathContextChanged) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_CONTEXT_CHANGED', '检查期间路径配置发生变化，本次目标证据和路径对照已失效，请重新检查。')
  else if (pathContextUnreadable) checks[serviceIndex] = check('service', 'unknown', 'AI_DIAG_PATH_CONTEXT_UNKNOWN', '路径对照前后未能完整读到系统代理或通道入口，本次矩阵无法核对，请重新检查。')
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
    checks,
    ...(matrixEntries === undefined ? {} : {
      pathMatrix: { checkedAt, valid: !contextChanged && !tunnelChanged && !pathContextChanged && !pathContextUnreadable, entries: matrixEntries }
    })
  }
}

async function readMatrixContext(url: string, options: DiagnosticOptions): Promise<{ readonly readable: boolean; readonly value: string }> {
  if (options.pathContext === undefined) return { readable: true, value: 'not-configured' }
  try { return { readable: true, value: await boundedDiagnosticPathContext(options.pathContext(url), matrixTimeoutMs(options)) } }
  catch { return { readable: false, value: '' } }
}

export async function boundedDiagnosticPathContext(operation: Promise<string>, timeoutMs = 5_500): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DIAGNOSTIC_PATH_CONTEXT_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function compareDiagnosticPaths(url: string, options: DiagnosticOptions, tunnelVerified: boolean): Promise<DiagnosticPathMatrix['entries']> {
  const timeoutMs = matrixTimeoutMs(options)
  const compare = async <P extends DiagnosticPathKind>(path: P): Promise<DiagnosticPathMatrixEntry & { readonly path: P }> => {
    if (path === 'laixin-tunnel' && !tunnelVerified) {
      return pathMatrixEntry(path, 'unavailable', '来信通道没有已验证入口，本路径未检查。')
    }
    try {
      const response = await boundedProbe(options.probe(url, path), timeoutMs)
      const elapsedMs = checkedDuration(response.durationMs)
      return pathMatrixEntry(path, 'reachable', '已到达目标的 HTTP 响应。', elapsedMs, 'http')
    } catch (error) {
      const failure = probeFailure(error)
      if (failure.kind === 'path-unavailable') {
        return pathMatrixEntry(path, 'unavailable', path === 'existing-proxy'
          ? '没有读到可用的系统现有代理，本路径未执行。'
          : '本路径当前没有可用入口，未能执行。', failure.durationMs)
      }
      const messages: Partial<Record<DiagnosticProbePhase, string>> = {
        dns: '在域名解析阶段失败。', proxy: '在代理或通道建链阶段失败。', connection: '在网络连接阶段失败。',
        tls: '在 TLS 安全连接阶段失败。', http: '已进入 HTTP 阶段，但没有取得响应。'
      }
      return pathMatrixEntry(path, 'failed', failure.phase === undefined
        ? failure.kind === 'timeout' ? '本路径检查超时，未能确认失败阶段。' : '本路径未完成，未能确认失败阶段。'
        : messages[failure.phase]!, failure.durationMs, failure.phase)
    }
  }
  return Promise.all([compare('direct'), compare('existing-proxy'), compare('laixin-tunnel')])
}

function matrixTimeoutMs(options: DiagnosticOptions): number {
  return Number.isSafeInteger(options.matrixProbeTimeoutMs) && options.matrixProbeTimeoutMs! >= 1 && options.matrixProbeTimeoutMs! <= 10_000
    ? options.matrixProbeTimeoutMs! : 5_500
}

async function boundedProbe(probe: Promise<DiagnosticProbeResult>, timeoutMs: number): Promise<DiagnosticProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DiagnosticProbeError('timeout', timeoutMs)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function pathMatrixEntry<P extends DiagnosticPathKind>(path: P, state: DiagnosticPathMatrixEntry['state'], message: string,
  elapsedMs?: number, phase?: DiagnosticProbePhase): DiagnosticPathMatrixEntry & { readonly path: P } {
  const timed = elapsedMs === undefined ? message : `${message.replace(/。$/, '')}（耗时 ${String(elapsedMs)} ms）。`
  return { path, state, message: timed, ...(phase === undefined ? {} : { phase }), ...(elapsedMs === undefined ? {} : { elapsedMs }) }
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
  if (selection?.configuration === 'missing') {
    return check('application', 'attention', 'AI_DIAG_APPLICATION_CONFIGURATION_MISSING',
      `${name} 仍选择工具箱的模型 API，但工具箱写入的配置已经不见了。旧成功记录不能证明当前可用，请到模型 API 页重新写入配置。`)
  }
  if (selection?.configuration === 'modified-externally') {
    return check('application', 'attention', 'AI_DIAG_APPLICATION_CONFIGURATION_MODIFIED',
      `${name} 的配置已被工具箱以外的程序改动，工具箱不会自动覆盖。旧成功记录不能证明当前可用；确认要恢复工具箱接入后，请到模型 API 页重新写入配置。`)
  }
  if (selection?.configuration === 'unknown') {
    return check('application', 'unknown', 'AI_DIAG_APPLICATION_CONFIGURATION_UNKNOWN',
      `这次没能读出 ${name} 当前的模型 API 配置，旧成功记录不能作为当前可用证据。请确认配置文件可读取后重新检查。`)
  }
  const attempt = selection?.lastClientAttempt
  const successAt = Date.parse(selection?.observedClientCall ?? '')
  if (attempt?.ok === false && freshObservation(attempt.at, now) &&
    (!Number.isFinite(successAt) || Date.parse(attempt.at) >= successAt)) {
    return check('application', 'attention', 'AI_DIAG_APPLICATION_FAILED',
      `${name} 最近一次经工具箱的模型 API 请求没有成功，较早的成功记录不能证明现在可用。请回到该软件查看本次提示。`)
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
    configuration: selection?.configuration ?? null,
    isolated: selection?.isolated ?? false,
    routeRevision: selection?.routeRevision ?? null
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
  if (service.code === 'AI_DIAG_PATH_CONTEXT_UNKNOWN') {
    return conclusion('unknown', 'diagnostic-context', 'DG01_CONTEXT_UNREADABLE', '本次路径对照无法核对',
      '这次没有完整读到系统代理或来信通道入口，不能确认三条路径是同一份配置下的结果。',
      '保持当前网络状态不变，再点一次“开始检查”。', evidence('service'))
  }
  if (application.code === 'AI_DIAG_LOCAL_SERVICE_DOWN') {
    return conclusion('blocked', 'local-service', 'DG01_LOCAL_SERVICE_DOWN', '卡在本机 API 服务',
      `${softwareName} 已指向工具箱的本机 API 服务，但该服务当前没有运行。`, '到“模型 API”页重启本机 API 服务，再重新检查。', evidence('application'))
  }
  if (application.code === 'AI_DIAG_APPLICATION_CONFIGURATION_MISSING' || application.code === 'AI_DIAG_APPLICATION_CONFIGURATION_MODIFIED') {
    return conclusion('blocked', 'application', 'DG01_APPLICATION_CONFIGURATION', '卡在应用配置',
      application.code === 'AI_DIAG_APPLICATION_CONFIGURATION_MISSING'
        ? `${softwareName} 仍选择工具箱的模型 API，但对应配置已经不见了。`
        : `${softwareName} 的模型 API 配置已被工具箱以外的程序改动。`,
      '确认要恢复工具箱接入后，到“模型 API”页重新写入配置，再重新检查。', evidence('application'))
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
  if (application.code === 'AI_DIAG_APPLICATION_CONFIGURATION_UNKNOWN') {
    return conclusion('unknown', 'application', 'DG01_APPLICATION_CONFIGURATION_UNKNOWN', '应用配置尚未核实',
      `这次没能读出 ${softwareName} 当前的模型 API 配置，旧成功记录不能证明现在仍可用。`,
      '确认配置文件可以读取后，再点一次“开始检查”。', evidence('application'))
  }
  const layeredFailure = layeredFailureConclusion(service)
  if (layeredFailure !== undefined) {
    return conclusion('blocked', 'target-path', layeredFailure.ruleId, layeredFailure.title,
      layeredFailure.summary, layeredFailure.nextStep, evidence('tunnel', 'service'))
  }
  if (['AI_DIAG_SERVICE_TIMEOUT', 'AI_DIAG_SERVICE_UNAVAILABLE', 'AI_DIAG_SERVICE_UNEXPECTED', 'AI_DIAG_SERVICE_ERROR'].includes(service.code)) {
    const path = target.route === 'isolated' ? '经应用隔离出口' : target.route === 'tunnel' ? '经当前通道' : '直连'
    return conclusion('unknown', 'target-path', 'DG01_TARGET_PATH_UNCONFIRMED', '只能定位到目标访问路径',
      `当前证据只说明从本机${path}访问 ${target.label} 没有取得可确认响应；没有更深一层的观测，不能继续归因。`,
      '稍后重新检查；若持续失败，复制本次结果给客服。', evidence('tunnel', 'service'))
  }
  if (application.code === 'AI_DIAG_APPLICATION_FAILED') {
    return conclusion('unknown', 'application', 'DG01_APPLICATION_UNCONFIRMED', '最近一次应用请求未成功',
      `${softwareName} 最近一次经工具箱的请求失败，因此不能用较早的成功记录判定当前正常。`,
      `回到 ${softwareName} 查看刚才请求的具体提示；处理后重试一次，再重新检查。`, evidence('service', 'application'))
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
  if (status === 401) return check('service', 'attention', 'AI_DIAG_SERVICE_AUTH', '本次检查没有携带客户认证，目标服务要求身份验证；这只说明目标有响应，不能判断登录、Key 或额度。', elapsedMs, 'http')
  if (status === 403) return check('service', 'attention', 'AI_DIAG_SERVICE_RESTRICTED', '目标服务拒绝了本次无认证检查，或要求浏览器验证；这只说明目标有响应，不能判断账号状态。', elapsedMs, 'http')
  if (status === 429) return check('service', 'attention', 'AI_DIAG_SERVICE_LIMITED', '本次无认证检查收到限流响应；这只说明目标有响应，不能判断账号额度。', elapsedMs, 'http')
  if (status >= 500) return check('service', 'attention', 'AI_DIAG_SERVICE_ERROR', '目标服务返回服务端错误，请稍后重试。', elapsedMs, 'http')
  if ((status >= 200 && status < 400) || status === 404 || status === 405) {
    return check('service', 'passed', 'AI_DIAG_SERVICE_REACHABLE', '已完成 DNS、网络连接和 TLS，并收到目标服务的 HTTP 响应；本次未发送对话，也未验证登录。', elapsedMs, 'http')
  }
  return check('service', 'unknown', 'AI_DIAG_SERVICE_UNEXPECTED', '目标服务返回了未能确认的 HTTP 结果，请在目标软件中查看提示。', elapsedMs, 'http')
}
type SafeProbeFailure = { readonly kind: DiagnosticProbeFailureKind, readonly durationMs: number | undefined, readonly phase?: DiagnosticProbePhase }
function probeFailure(error: unknown): SafeProbeFailure {
  if (error instanceof DiagnosticProbeError) return { kind: error.kind, durationMs: checkedDuration(error.durationMs), phase: error.phase }
  return { kind: 'unavailable', durationMs: undefined }
}
function checkedDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 60_000 ? value : undefined
}
function check(id: DiagnosticCheck['id'], state: DiagnosticCheck['state'], code: DiagnosticCheckCode, message: string,
  elapsedMs?: number, phase?: DiagnosticProbePhase): DiagnosticCheck {
  const labels = { internet: '基础网络', tunnel: '通道出口', service: '目标服务', account: '登录与额度', application: '应用接入' }
  return { id, label: labels[id], state, code, message: elapsedMs === undefined ? message : `${message.replace(/。$/, '')}（耗时 ${String(elapsedMs)} ms）。`,
    ...(phase === undefined ? {} : { phase }), ...(elapsedMs === undefined ? {} : { elapsedMs }) }
}

function internetFailure(failure: SafeProbeFailure): DiagnosticCheck {
  const layered: Partial<Record<DiagnosticProbePhase, { readonly code: DiagnosticCheckCode, readonly message: string }>> = {
    dns: { code: 'AI_DIAG_INTERNET_DNS_FAILED', message: '基础网络检查停在域名解析阶段。' },
    connection: { code: 'AI_DIAG_INTERNET_CONNECTION_FAILED', message: '基础网络检查停在网络连接阶段。' },
    tls: { code: 'AI_DIAG_INTERNET_TLS_FAILED', message: '基础网络检查停在 TLS 安全连接阶段。' },
    http: { code: 'AI_DIAG_INTERNET_HTTP_FAILED', message: '基础网络检查已进入 HTTP 阶段，但没有取得响应。' }
  }
  const mapped = failure.phase === undefined ? undefined : layered[failure.phase]
  if (mapped !== undefined) return check('internet', 'unknown', mapped.code, mapped.message, failure.durationMs, failure.phase)
  return check('internet', 'unknown', failure.kind === 'timeout' ? 'AI_DIAG_INTERNET_TIMEOUT' : 'AI_DIAG_INTERNET_UNAVAILABLE',
    failure.kind === 'timeout' ? '基础网络检查超时，尚不能确定停在哪个阶段。' : '基础网络检查未完成；单个检测地址不可达也可能造成此结果。', failure.durationMs)
}

function serviceFailure(failure: SafeProbeFailure): DiagnosticCheck {
  const layered: Partial<Record<DiagnosticProbePhase, { readonly code: DiagnosticCheckCode, readonly message: string }>> = {
    dns: { code: 'AI_DIAG_SERVICE_DNS_FAILED', message: '当前路径在域名解析阶段失败。' },
    proxy: { code: 'AI_DIAG_SERVICE_PROXY_FAILED', message: '当前路径在代理或通道建链阶段失败。' },
    connection: { code: 'AI_DIAG_SERVICE_CONNECTION_FAILED', message: '当前路径在建立网络连接阶段失败。' },
    tls: { code: 'AI_DIAG_SERVICE_TLS_FAILED', message: '当前路径已建立网络连接，但 TLS 安全握手失败。' },
    http: { code: 'AI_DIAG_SERVICE_HTTP_FAILED', message: '当前路径已进入 HTTP 阶段，但没有取得目标响应。' }
  }
  const mapped = failure.phase === undefined ? undefined : layered[failure.phase]
  if (mapped !== undefined) return check('service', 'unknown', mapped.code, mapped.message, failure.durationMs, failure.phase)
  return check('service', 'unknown', failure.kind === 'timeout' ? 'AI_DIAG_SERVICE_TIMEOUT' : 'AI_DIAG_SERVICE_UNAVAILABLE',
    failure.kind === 'timeout' ? '目标服务检查超时，尚不能确定停在哪个阶段。' : '未能取得目标服务响应，且没有足够证据确定失败阶段。', failure.durationMs)
}

function layeredFailureConclusion(service: DiagnosticCheck): {
  readonly ruleId: DiagnosticConclusion['ruleId']; readonly title: string; readonly summary: string; readonly nextStep: string
} | undefined {
  const rows: Partial<Record<DiagnosticCheckCode, {
    readonly ruleId: DiagnosticConclusion['ruleId']; readonly title: string; readonly summary: string; readonly nextStep: string
  }>> = {
    AI_DIAG_SERVICE_DNS_FAILED: { ruleId: 'DG03_TARGET_DNS_FAILURE', title: '卡在当前路径的域名解析',
      summary: '当前实际路径在域名解析阶段失败；可能是目标域名，也可能是当前代理入口，现有受控读数不再细分。这不是账号、额度或模型权限结论。',
      nextStep: '重新连接当前网络或 AI 网络后复查；若持续失败，把本次结果报给来信。' },
    AI_DIAG_SERVICE_PROXY_FAILED: { ruleId: 'DG03_PROXY_FAILURE', title: '卡在代理或通道建链',
      summary: '当前路径没有完成代理或通道建链；这不能证明目标服务自身不可达，也不是账号结论。',
      nextStep: '重新连接 AI 网络后复查；若持续失败，把本次结果报给来信。' },
    AI_DIAG_SERVICE_CONNECTION_FAILED: { ruleId: 'DG03_TARGET_CONNECTION_FAILURE', title: '卡在当前路径的网络连接',
      summary: '当前路径的网络连接没有建立；可能在代理入口或目标连接，现有证据不能继续归因到节点、企业网络或目标服务。',
      nextStep: '重新连接 AI 网络后复查；若持续失败，把本次结果报给来信。' },
    AI_DIAG_SERVICE_TLS_FAILED: { ruleId: 'DG03_TARGET_TLS_FAILURE', title: '卡在 TLS 安全连接',
      summary: '网络连接已经建立，但与目标服务的 TLS 安全握手失败；这不是账号拒绝。',
      nextStep: '保持当前网络环境不变重新检查；持续失败时把本次结果报给来信，用于核对证书审查或通道。' },
    AI_DIAG_SERVICE_HTTP_FAILED: { ruleId: 'DG03_TARGET_HTTP_FAILURE', title: '卡在目标 HTTP 响应',
      summary: '当前路径已进入 HTTP 阶段，但没有取得目标响应；这不是登录或额度结论。',
      nextStep: '稍后重新检查；若持续失败，把本次结果报给来信。' }
  }
  return rows[service.code]
}
