import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { apiFailureMessage, classifyProviderFailure, providerRecoveryNotice, type ApiFailure, type ApiLatency, type ApiRequestRecord, type ApiServiceSnapshot, type ApiShell, type CodexDesktopRouteReason, type CodexDesktopRouteVerification, type ModelProviderId } from '../../shared/api-service-types'
import { isProviderModelAllowed, modelProviderIds, normalizeProviderModel } from '../../shared/model-providers'
import { ClientAcceptanceTracker, type ClientAcceptanceRoute, type ClientRouteAcceptance } from './client-acceptance'
import { unavailableDesktopRouteAttestor, unverified, type DesktopRouteAttestor } from './desktop-route-attestation'
import { rewriteUpstreamRequest } from './provider-rewrite'

export interface GatewayRoute {
  readonly shell: ApiShell
  readonly provider: ModelProviderId
  readonly model: string
  readonly endpoint: string
  readonly key: string
  /** Internal only: a successful client call counts only while this revision is still active. */
  readonly revision?: string
}
type ActiveGatewayRoute = GatewayRoute & ClientAcceptanceRoute
type Json = Record<string, unknown>
type ProviderFailureDetail = { readonly code: ApiFailure; readonly recoveryNotice?: string }
const paths: Record<ApiShell, string> = { codex: 'responses', claude: 'messages', hermes: 'chat/completions' }
const maximumBody = 32 * 1024 * 1024
const maximumConcurrentClients = 16
/**
 * 转发路径（非测速）的空闲超时：上游这么久一字节都没有才判 timeout；只要还在出字就不掐
 * （API-08：一次性总时长会把正常出字到第 10 分钟的长回答硬掐断）。⛔ 测速超时另见 probeTimeoutMs。
 */
const gatewayIdleTimeoutMs = 600_000
/**
 * 测速路径（source:'test'）的一次性总超时。服务商黑洞时客户的等待以它为界（API-10：45 秒→15 秒）；
 * 探测两轮串行，最坏 2×它。取消走 cancelTests()，不等超时。
 */
const probeTimeoutMs = 15_000
/** 客户端内建的立即重试通常会连续发 8 次；30 秒足以止住风暴，改 Key/路由会换 revision 立即失效。 */
const clientRetryBlockWindowMs = 30_000
const retryBlockedClientFailures = new Set<ApiFailure>([
  'key_rejected', 'key_product_mismatch',
  // Phase 1(429 短窗):上游自家 429(classify→rate_limited)基线不在白名单——客户端内建
  // 的连发重试(通常 8 次)全额直打,正撞在限流枪口上。入列后同绑定 30s 内本地理应答,
  // 状态仍是 429(shell 自己的退避语义不变),换 Key/路由换 revision 立即失效。
  'rate_limited',
  // Phase 1(429 短窗):上游自家 429(classify→rate_limited)基线不在白名单——客户端内建
  // 的连发重试(通常 8 次)全额直打,正撞在限流枪口上。入列后同绑定 30s 内本地理应答,
  // 状态仍是 429(shell 自己的退避语义不变),换 Key/路由换 revision 立即失效。
  'membership_quota_exhausted', 'membership_concurrency_limited', 'membership_rate_limited',
  'coding_plan_expired', 'coding_plan_quota_exhausted', 'coding_plan_model_unavailable', 'coding_plan_key_product_mismatch'
])
/** 只允许这些上游时间字段穿过错误判类的短暂内存对象；不会写入诊断记录。 */
const providerRecoveryFields = ['reset_at', 'resetAt', 'next_reset_at', 'nextResetAt', 'quota_reset_at', 'quotaResetAt', 'retry_at', 'retryAt', 'available_at', 'availableAt', 'next_flush_time', 'nextFlushTime', 'retry_after', 'retryAfter', 'retry_after_seconds', 'retryAfterSeconds', 'retry_after_ms', 'retryAfterMs'] as const
const routePattern = new RegExp(`^/(codex|claude|hermes)/(${modelProviderIds.map(escapeRegex).join('|')})/v1/(responses|messages|chat/completions|models)$`)
const desktopRouteStatusPath = '/_laixin/codex-desktop-route-status'
const desktopRouteReasons = new Set<CodexDesktopRouteVerification['reason']>([
  'verified_socket_bound_desktop', 'awaiting_desktop_request', 'incomplete_answer', 'platform_unsupported',
  'socket_metadata_unavailable', 'socket_owner_not_found', 'socket_owner_ambiguous',
  'socket_owner_not_codex_desktop', 'desktop_signature_unverified', 'socket_binding_unavailable'
])

export interface AiGatewayOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  /** Production installs the macOS process/socket observer; test and legacy callers stay fail-closed. */
  readonly desktopAttestor?: DesktopRouteAttestor
  /**
   * 首批 Mac 使用回执（API-04）的只读事件出口：客户端调用首次验收、Codex Desktop 证明变化。
   * 只含壳名、时间与固定枚举；监听方负责白名单落盘。缺省时不产生任何行为变化。
   */
  readonly onUsageEvent?: (event: AiGatewayUsageEvent) => void
}

/** 回执只认这两类固定事件；字段集合固定，⛔ 扩成请求记录或任何请求内容。 */
export type AiGatewayUsageEvent =
  | { readonly kind: 'client-accepted'; readonly shell: ApiShell; readonly at: string }
  | { readonly kind: 'desktop-proof'; readonly shell: ApiShell; readonly verified: boolean; readonly reason: CodexDesktopRouteReason; readonly at: string }

/** Fixed upstreams come from the provider catalogue, never from a client URL. */
export class AiGateway {
  private server?: Server
  private token = ''
  private routes: readonly ActiveGatewayRoute[] = []
  private records: ApiRequestRecord[] = []
  private startedAt: string | null = null
  private controllers = new Set<AbortController>()
  /** 在飞的测速请求（source:'test'）；cancelTests() 只中止这一类，⛔ 不碰客户端在飞请求。 */
  private testControllers = new Set<AbortController>()
  /** 被客户/界面主动取消的测速请求：计类为 client_aborted，⛔ 与超时、网络故障混谈。 */
  private cancelledTestControllers = new WeakSet<AbortController>()
  /** stop() 正在关停:此时中止在途请求是工具箱自己的动作(Phase 2 ⑧),⛔ 记成 network_error。 */
  private stopping = false
  /** 客户端调用只在仍匹配当前路由版本时才算验收通过。 */
  private readonly acceptance = new ClientAcceptanceTracker()
  /** Codex Desktop has a stricter proof than a generic native/CLI client call. */
  private readonly desktopAcceptance = new DesktopRouteAcceptanceTracker()
  private readonly desktopAttestor: DesktopRouteAttestor
  private readonly pendingDesktopAttestations = new Set<Promise<void>>()
  /** 连续超时计数：厂商侧连续没回复才算 provider_outage，单次超时仍报 timeout。 */
  private timeoutRuns = new Map<string, { count: number; first: number }>()
  /** 只针对实际客户端的当前路由版本；手动探测永远不从这里短路。 */
  private retryBlocks = new Map<string, { code: ApiFailure; expiresAt: number; recoveryNotice?: string }>()
  /** 已出口过「客户端调用观察」事件的路由版本：每版本只报一次开始真的在用。 */
  private usageAcceptedRevisions = new Set<string>()
  /** 客户端流量失败时通知一次；只报事实，⛔ 让通知失败影响这次请求。 */
  private clientFailure?: (record: ApiRequestRecord) => void
  private readonly usageEvent?: (event: AiGatewayUsageEvent) => void
  baseUrl: string | null = null
  constructor(private readonly options: AiGatewayOptions = {}) {
    this.desktopAttestor = options.desktopAttestor ?? unavailableDesktopRouteAttestor()
    this.usageEvent = options.onUsageEvent
  }

  async start(port: number, token: string): Promise<number> {
    if (this.server?.listening) return Number(new URL(this.baseUrl!).port)
    this.stopping = false
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) sendError(res, 500, 'upstream_error'); else res.destroy() }) })
    server.requestTimeout = 60_000
    server.headersTimeout = 15_000
    server.maxHeadersCount = 40
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', () => { this.baseUrl = null })
    this.server = server; this.token = token; this.startedAt = new Date().toISOString()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('AI_ACCESS_PORT_UNAVAILABLE')
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return address.port
  }
  /** 运行中故障的出口：客户端（⛔ 自测）请求失败时回调一次，交给上层记录。 */
  onClientFailure(listener: (record: ApiRequestRecord) => void): void { this.clientFailure = listener }
  setRoutes(routes: readonly GatewayRoute[]): void {
    const previous = new Map(this.routes.map(route => [route.shell, route]))
    this.routes = routes.map(route => {
      const before = previous.get(route.shell)
      const revision = route.revision ?? (before && sameRouteBinding(before, route) ? before.revision : randomUUID())
      return { ...route, revision }
    })
    const activeRevisions = new Set(this.routes.map(route => route.revision))
    for (const revision of this.retryBlocks.keys()) if (!activeRevisions.has(revision)) this.retryBlocks.delete(revision)
    this.acceptance.replaceRoutes(this.routes)
    this.desktopAcceptance.replaceRoutes(this.routes)
  }
  /** 观察到的真实客户端调用时间，按壳；没观察到就没有这一项。 */
  clientCalls(): Readonly<Partial<Record<ApiShell, string>>> {
    return Object.fromEntries(Object.entries(this.acceptance.acceptances()).map(([shell, acceptance]) => [shell, acceptance.at])) as Partial<Record<ApiShell, string>>
  }
  /** 当前路由版本上，已真正观察到的成功客户端调用。 */
  clientAcceptances(): Readonly<Partial<Record<ApiShell, ClientRouteAcceptance>>> { return this.acceptance.acceptances() }
  /** 仅在同一 socket 已绑定经签名 Codex Desktop 进程且该请求完整回答后才会是 verified。 */
  codexDesktopRouteAcceptance(): CodexDesktopRouteVerification { return this.desktopAcceptance.value() }
  /** A shell file changed outside the Toolbox, so prior route evidence no longer proves its current connection. */
  invalidateClientAcceptance(shell: ApiShell): void {
    const retired = this.routes.find(route => route.shell === shell)
    if (retired === undefined) return
    // Rotate the internal route revision as well as clearing current evidence. Otherwise an
    // in-flight request accepted before a CC Switch rewrite could finish afterward and recreate
    // the old “in use” or Desktop proof against the still-equal upstream binding.
    this.routes = this.routes.map(route => route.shell === shell ? { ...route, revision: randomUUID() } : route)
    if (retired.revision !== undefined) this.retryBlocks.delete(retired.revision)
    this.acceptance.replaceRoutes(this.routes)
    this.desktopAcceptance.replaceRoutes(this.routes)
  }
  snapshot(): Omit<ApiServiceSnapshot, 'checks' | 'usage'> {
    return {
      running: this.server?.listening === true && this.baseUrl !== null,
      baseUrl: this.baseUrl, startedAt: this.startedAt, requests: [...this.records],
      routes: this.routes.map(r => ({ shell: r.shell, provider: r.provider, model: r.model, baseUrl: `${this.baseUrl}/${r.shell}/${r.provider}${r.shell === 'claude' ? '' : '/v1'}`, upstream: r.endpoint }))
    }
  }
  async stop(): Promise<void> {
    this.stopping = true
    for (const controller of this.controllers) controller.abort()
    const server = this.server
    this.server = undefined; this.baseUrl = null; this.token = ''; this.routes = []
    this.acceptance.clear(); this.desktopAcceptance.clear(); this.timeoutRuns.clear(); this.retryBlocks.clear(); this.usageAcceptedRevisions.clear()
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  /**
   * API-10：中止在飞的测速请求（服务面板「取消检查」/关闭面板）。被中止的请求按 client_aborted
   * 计类——那是客户不等的决定，⛔ 记成网络故障。返回被中止的请求数；没有在飞请求时是 0。
   */
  cancelTests(): number {
    let cancelled = 0
    for (const controller of this.testControllers) { this.cancelledTestControllers.add(controller); controller.abort(); cancelled++ }
    return cancelled
  }

  /**
   * A tool round when the model elects to call it, otherwise one complete direct answer.
   * No files or shell tools run.
   * 直接打上游，⛔ 需要本机监听——本机服务只服务客户端流量。
   * firstTextMs 取第二次（流式）那程的首段文字耗时，验证矩阵按它排序。
   */
  async probe(route: GatewayRoute): Promise<{ ok: boolean; code?: ApiFailure; firstTextMs?: number }> {
    // A provider can legally answer directly even when tools are offered. If it calls the
    // probe tool, require exactly that one call and finish the second round below.
    const first = await this.request(route, probeBody(route.shell), 'test', undefined, undefined, {}, false, true)
    if (!first.record.ok) return { ok: false, code: first.record.code }
    const followup = toolResultBody(route.shell, first.json)
    if (!followup) {
      if (!first.completedAnswer) return { ok: false, code: 'tool_call_failed' }
      this.clearRetryBlock(route)
      return { ok: true, ...(first.firstTextMs === null ? {} : { firstTextMs: first.firstTextMs }) }
    }
    const second = await this.request(route, followup, 'test')
    if (!second.record.ok || !second.completedAnswer) return { ok: false, code: second.record.code ?? 'tool_call_failed' }
    this.clearRetryBlock(route)
    return { ok: true, ...(second.firstTextMs === null ? {} : { firstTextMs: second.firstTextMs }) }
  }

  /** Measures first meaningful model text, not headers or an HTTP ping; never activates a route. */
  async measureLatency(route: GatewayRoute): Promise<ApiLatency> {
    const message = { role: 'user', content: 'Reply with OK.' }
    const body = route.shell === 'codex' ? { input: [message], stream: true, max_output_tokens: 64 }
      : { messages: [message], stream: true, max_tokens: 64 }
    const result = await this.request(route, body, 'test')
    if (result.record.ok && result.firstTextMs !== null) {
      this.clearRetryBlock(route)
      return { ok: true, latencyMs: result.firstTextMs }
    }
    return { ok: false, latencyMs: null, code: result.record.code ?? 'invalid_reply' }
  }

  /** 工具箱自己刚用同一条绑定真实打通上游（探测/测速成功）：这条路由上为客户端记下的
   * 短路已过时，立即失效——「测试已通过/重新启用成功」后客户端不再继续吃到缓存错误。
   * 绑定不一致（测的是另一家或另一把 Key）不清，⛔ 替别的路由放行。 */
  clearRetryBlock(route: GatewayRoute): void {
    const active = this.routes.find(item => item.shell === route.shell)
    if (active === undefined || !sameRouteBinding(active, route)) return
    if (active.revision !== undefined) this.retryBlocks.delete(active.revision)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store')
    const [pathname, query] = (req.url ?? '').split('?')
    if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers.host !== this.baseUrl?.slice(7)) { sendError(res, 403, 'key_rejected'); return }
    // This loopback-only endpoint is intentionally read-only and returns just the fixed Desktop
    // proof state. It is a diagnostic surface, not an acceptance capability: a separate process
    // cannot authenticate an arbitrary caller-provided loopback port without a private channel.
    // The product UI reads the same in-process tracker; this endpoint cannot create, alter or
    // import evidence.
    if (pathname === desktopRouteStatusPath) {
      if (req.method !== 'GET' || query) { sendError(res, 405, 'not_configured'); return }
      await this.awaitDesktopAttestations()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(this.codexDesktopRouteAcceptance()))
      return
    }
    const supplied = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : ''
    if (!sameToken(supplied, this.token)) { sendError(res, 401, 'key_rejected'); return }
    if (query && query !== 'beta=true') { sendError(res, 404, 'not_configured'); return }
    const match = routePattern.exec(pathname)
    const shell = match?.[1] as ApiShell | undefined
    if (shell && match?.[3] !== paths[shell] && match?.[3] !== 'models') { sendError(res, 404, 'not_configured'); return }
    if (!shell) { sendError(res, 404, 'not_configured'); return }
    const route = this.routes.find(r => r.shell === shell)
    if (!route || (match?.[2] && match[2] !== route.provider)) { sendError(res, 409, 'not_configured'); return }
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: route.model, object: 'model', owned_by: route.provider }] })); return
    }
    if (req.method !== 'POST' || pathname.endsWith('/models')) { sendError(res, 405, 'not_configured'); return }
    const blocked = this.retryBlockFor(route)
    if (blocked !== undefined) {
      // 仍把 body 交给 Node 流式丢弃，避免 keep-alive 连接遗留未读数据；⛔ 缓冲或接触上游。
      discardRequestBody(req)
      const status = retryBlockStatus(blocked.code)
      sendError(res, status, blocked.code, route.provider, blocked.recoveryNotice)
      this.recordShortCircuitedClientFailure(route, blocked.code, status)
      return
    }
    // 从开始收 body 就占一个槽。否则大量慢上传能在尚未进入 request() 前各自缓存 32MB，
    // 既绕过并发上限又把本机内存打满。
    if (this.controllers.size >= maximumConcurrentClients) {
      discardRequestBody(req)
      sendError(res, 503, 'local_service_busy')
      return
    }
    // Start before reading the body, while the accepted TCP connection is necessarily live.
    // The attestor receives only the socket tuple; no prompt/header/body is ever passed to it.
    const desktopAttestation = route.shell === 'codex' ? this.beginDesktopAttestation(req) : undefined
    const controller = new AbortController()
    this.controllers.add(controller)
    const disconnected = (): void => { if (!res.writableEnded && !res.writableFinished) controller.abort() }
    res.once('close', disconnected)
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        // 本机转发上限，不是「接口无有效回复」：如实说超出上限，并把这次请求留进面板与故障记录。
        if (size > maximumBody) { sendError(res, 413, 'payload_too_large'); this.recordShortCircuitedClientFailure(route, 'payload_too_large', 413); return }
        chunks.push(chunk)
      }
      let body: Json
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!isJson(value)) throw new Error(); body = value } catch { sendError(res, 400, 'invalid_reply'); return }
      const headers: Record<string, string> = {}
      for (const name of ['anthropic-beta', 'user-agent']) {
        const value = req.headers[name]
        if (typeof value === 'string' && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value)) headers[name] = value
      }
      await this.request(route, body, 'client', res, controller, headers, true, false, desktopAttestation)
    } finally {
      res.off('close', disconnected)
      this.controllers.delete(controller)
    }
  }

  private async request(route: GatewayRoute, body: Json, source: 'test' | 'client', downstream?: ServerResponse, controller = new AbortController(), forwardedHeaders: Record<string, string> = {}, controllerAlreadyTracked = false, allowProbeToolCall = false, desktopAttestation?: Promise<CodexDesktopRouteVerification>) {
    const started = Date.now()
    const responseStarted = performance.now()
    let firstTextMs: number | null = null
    const observer = new ReplyObserver()
    let status = 0
    let code: ApiFailure | undefined
    let recoveryNotice: string | undefined
    let completedAnswer = false
    let timedOut = false
    let replyTooLarge = false
    let upstreamCompleted = false
    // 空闲超时：每收到上游一段数据就重置计时，只有真空闲达到上限才中止（API-08）。
    // 测速路径（source === 'test'）保持一次性总超时，上限是 probeTimeoutMs（API-10：45 秒→15 秒）。
    let sawUpstreamData = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdleTimer = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timedOut = true; controller.abort() }, this.options.timeoutMs ?? (source === 'test' ? probeTimeoutMs : gatewayIdleTimeoutMs))
    }
    const noteUpstreamActivity = (): void => { sawUpstreamData = true; if (source !== 'test') armIdleTimer() }
    armIdleTimer()
    // 客户自己在 AI 里停下（按 Esc、关掉窗口）会断开这条连接，中止随之而来。这不是「连不上服务商」，
    // ⛔ 记成网络故障——那会把客服的排查引到网络上去。
    let clientGone = false
    const noteClientGone = (): void => { if (downstream && !downstream.writableEnded && !downstream.writableFinished) clientGone = true }
    downstream?.once('close', noteClientGone)
    if (!controllerAlreadyTracked) {
      this.controllers.add(controller)
      if (source === 'test') this.testControllers.add(controller)
    }
    try {
      const headers: Record<string, string> = { 'user-agent': 'Laixin-AI-Toolbox (connection-check)', ...forwardedHeaders, 'content-type': 'application/json', authorization: `Bearer ${route.key}` }
      if (route.shell === 'claude') { headers['x-api-key'] = route.key; headers['anthropic-version'] = '2023-06-01' }
      const model = routedModel(route, body)
      const rewritten = rewriteUpstreamRequest({ shell: route.shell, provider: route.provider, model, body: { ...body, model }, headers })
      const response = await (this.options.fetch ?? fetch)(route.endpoint, { method: 'POST', headers: rewritten.headers, body: JSON.stringify(rewritten.body), signal: controller.signal, redirect: 'error' })
      noteUpstreamActivity()
      status = response.status
      if (!response.ok) {
        const body = await errorBody(response)
        code = classifyProviderFailure(status, body, route.provider)
        recoveryNotice = providerRecoveryNotice(status, body, code, route.provider, response.headers.get('retry-after'))
        if (downstream) sendProviderFailure(downstream, code, route.provider, recoveryNotice)
      } else {
        const streaming = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true
        observer.streaming = streaming
        if (streaming) {
          let sseBuffer = ''
          let downstreamStreamStarted = false
          const decoder = new TextDecoder()
          const encoder = new TextEncoder()
          const relayEvent = async (event: string): Promise<boolean> => {
            // 先在本机判这一个完整 SSE event，确认不是套餐/认证业务错误后才把它交给客户端。
            // 这样即便服务商用 HTTP 200 包 error，也不会把原始详情透传到 Codex、Claude 或 Hermes。
            const eventFailure = sseEventFailure(event, route.provider)
            observer.push(encoder.encode(event))
            if (eventFailure !== undefined) { code = eventFailure.code; recoveryNotice = eventFailure.recoveryNotice; return false }
            if (firstTextMs === null && observer.hasText) firstTextMs = Math.round(performance.now() - responseStarted)
            if (downstream) {
              if (!downstreamStreamStarted) {
                downstream.statusCode = status
                downstream.setHeader('content-type', 'text/event-stream')
                downstreamStreamStarted = true
              }
              if (!downstream.write(event)) await waitForDrain(downstream, controller.signal)
            }
            return true
          }
          if (response.body) {
            const reader = response.body.getReader()
            let keepReading = true
            try {
              while (keepReading) {
                const next = await reader.read()
                if (next.done) break
                noteUpstreamActivity()
                sseBuffer += decoder.decode(next.value, { stream: true })
                if (Buffer.byteLength(sseBuffer) > maximumBody) {
                  // 永远不构成完整 SSE event 的数据不能积累到 10 分钟超时；直接丢弃并回本地错误。
                  // 这是上游单条回复超出本机转发上限，⛔ 说成「无有效回复」。
                  sseBuffer = ''
                  code = 'payload_too_large'
                  keepReading = false
                  break
                }
                let boundary: number
                while ((boundary = sseEventBoundary(sseBuffer)) >= 0) {
                  const event = sseBuffer.slice(0, boundary)
                  sseBuffer = sseBuffer.slice(boundary)
                  if (!await relayEvent(event)) { keepReading = false; break }
                }
              }
              if (keepReading) {
                sseBuffer += decoder.decode()
                if (sseBuffer) await relayEvent(sseBuffer)
              } else await reader.cancel().catch(() => undefined)
            } finally { reader.releaseLock() }
          }
          observer.finish()
        } else {
          const chunks: Buffer[] = []
          if (response.body) {
            const reader = response.body.getReader()
            let bytes = 0
            try {
              while (true) {
                const next = await reader.read()
                if (next.done) break
                noteUpstreamActivity()
                bytes += next.value.length
                // 上游回复超出本机转发上限：如实说超出上限，⛔ 进 catch 被说成「网络未连接」。
                if (bytes > maximumBody) { replyTooLarge = true; controller.abort(); throw new Error('REPLY_TOO_LARGE') }
                chunks.push(Buffer.from(next.value))
                observer.push(next.value)
              }
            } finally { reader.releaseLock() }
          }
          observer.finish()
          const outcome = replyOutcome(observer, route.provider, allowProbeToolCall)
          code = outcome.code
          recoveryNotice = outcome.recoveryNotice
          completedAnswer = outcome.kind === 'answer'
          if (code === undefined && downstream) {
            downstream.statusCode = status
            downstream.setHeader('content-type', 'application/json')
            upstreamCompleted = true
            downstream.end(Buffer.concat(chunks))
          }
        }
        if (firstTextMs === null && observer.hasText) firstTextMs = Math.round(performance.now() - responseStarted)
        const outcome = replyOutcome(observer, route.provider, allowProbeToolCall)
        code ??= outcome.code
        recoveryNotice ??= outcome.recoveryNotice
        completedAnswer ||= outcome.kind === 'answer'
        if (code !== undefined) {
          if (downstream) sendReplyFailure(downstream, code, route.provider, streaming, recoveryNotice)
        } else {
          upstreamCompleted = true
          if (streaming) downstream?.end()
        }
      }
    } catch {
      // Native clients can close an SSE socket immediately after the terminal answer event,
      // before an upstream keeps-alive stream reaches EOF. That already-complete answer is a
      // successful customer request; tool turns, errors, and incomplete streams stay failures.
      const terminalOutcome = replyOutcome(observer, route.provider, allowProbeToolCall)
      if (!upstreamCompleted && clientGone && code === undefined && terminalOutcome.kind === 'answer') {
        completedAnswer = true
      } else if (!upstreamCompleted) {
        // 客户取消、界面取消的测速、stop() 关停中止(Phase 2 ⑧)同账 client_aborted:
        // 都是工具箱/客户自己的动作,⛔ 记成 network_error 污染回执与 FB-1 故障统计。
        code = replyTooLarge ? 'payload_too_large' : timedOut ? 'timeout'
          : clientGone || this.cancelledTestControllers.has(controller) || (this.stopping && controller.signal.aborted) ? 'client_aborted' : 'network_error'
        if (downstream && !downstream.destroyed) {
          if (!downstream.headersSent) sendProviderFailure(downstream, code, route.provider)
          else downstream.destroy()
        }
      }
    } finally {
      clearTimeout(idleTimer); downstream?.off('close', noteClientGone)
      if (!controllerAlreadyTracked) { this.controllers.delete(controller); this.testControllers.delete(controller) }
    }
    code = this.escalateTimeouts(route, code, sawUpstreamData)
    const record: ApiRequestRecord = {
      at: new Date().toISOString(), shell: route.shell, provider: route.provider, model: routedModel(route, body), source,
      ok: code === undefined, ...(code ? { code } : {}), status, durationMs: Date.now() - started,
      inputTokens: observer.inputTokens, outputTokens: observer.outputTokens
    }
    this.recordClientResult(route, record, true, completedAnswer, recoveryNotice)
    this.recordDesktopRouteOutcome(route, record, completedAnswer, desktopAttestation)
    return { record, json: observer.json, hasText: observer.hasText, completedAnswer, firstTextMs }
  }

  private recordDesktopRouteOutcome(route: GatewayRoute, record: ApiRequestRecord, completedAnswer: boolean,
    attestation?: Promise<CodexDesktopRouteVerification>): void {
    if (record.source !== 'client' || route.shell !== 'codex') return
    if (!record.ok || !completedAnswer) {
      this.recordDesktopVerification(route, unverified('incomplete_answer'), record.at)
      return
    }
    if (attestation === undefined) {
      this.recordDesktopVerification(route, unverified('socket_binding_unavailable'), record.at)
      return
    }
    const pending = attestation.then(result => {
      // The completed-answer timestamp is the customer-visible fact. The observation itself may
      // finish a moment later, but it still binds the same live socket captured before body read.
      const verified = publicDesktopRouteResult(result)
      this.recordDesktopVerification(route, verified.status === 'verified'
        ? { status: 'verified', at: record.at, reason: 'verified_socket_bound_desktop' }
        : verified, record.at)
    }).catch(() => { this.recordDesktopVerification(route, unverified('socket_binding_unavailable'), record.at) })
    this.pendingDesktopAttestations.add(pending)
    void pending.finally(() => { this.pendingDesktopAttestations.delete(pending) })
  }

  /** 记录并只在证明状态变化时出口一次回执事件；⛔ 每个请求都刷一条。 */
  private recordDesktopVerification(route: GatewayRoute, result: CodexDesktopRouteVerification, at: string): void {
    const changed = this.desktopAcceptance.record(route, result)
    if (!changed || result.reason === 'awaiting_desktop_request') return
    this.usageEvent?.({ kind: 'desktop-proof', shell: route.shell, verified: result.status === 'verified',
      reason: result.reason, at: result.at ?? at })
  }

  /** A probe failure cannot interrupt the customer's request; it can only leave Desktop unverified. */
  private beginDesktopAttestation(req: IncomingMessage): Promise<CodexDesktopRouteVerification> {
    try {
      return Promise.resolve(this.desktopAttestor.observe({
        localAddress: req.socket.localAddress,
        localPort: req.socket.localPort,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort
      }))
    } catch {
      return Promise.resolve(unverified('socket_binding_unavailable'))
    }
  }

  private async awaitDesktopAttestations(): Promise<void> {
    const pending = [...this.pendingDesktopAttestations]
    if (pending.length > 0) await Promise.all(pending)
  }

  private retryBlockFor(route: GatewayRoute): { readonly code: ApiFailure; readonly recoveryNotice?: string } | undefined {
    if (route.revision === undefined) return undefined
    const block = this.retryBlocks.get(route.revision)
    if (block === undefined) return undefined
    if (block.expiresAt <= Date.now()) { this.retryBlocks.delete(route.revision); return undefined }
    return block
  }

  private recordShortCircuitedClientFailure(route: GatewayRoute, code: ApiFailure, status: number): void {
    this.recordClientResult(route, {
      at: new Date().toISOString(), shell: route.shell, provider: route.provider, model: route.model, source: 'client', ok: false, code, status,
      durationMs: 0, inputTokens: null, outputTokens: null
    }, false)
  }

  private recordClientResult(route: GatewayRoute, record: ApiRequestRecord, updateRetryBlock = true, completedAnswer = false, recoveryNotice?: string): void {
    this.records = [record, ...this.records].slice(0, 200)
    if (record.source !== 'client') return
    if (updateRetryBlock) this.updateRetryBlock(route, record, recoveryNotice)
    // 迟到的响应属于切换前那条路由：只有它还是当前绑定的同一 revision，才算「这一家真的被用过」，
    // ⛔ 拿旧请求给刚换上的服务商打勾。
    if (record.ok && completedAnswer && route.revision !== undefined &&
      this.acceptance.record({ ...route, model: record.model } as ActiveGatewayRoute, record.at) &&
      !this.usageAcceptedRevisions.has(route.revision)) {
      // 每条路由版本只在首次验收时出口一次；回执要的是「开始真的在用」，⛔ 每个请求刷一条。
      this.usageAcceptedRevisions.add(route.revision)
      this.usageEvent?.({ kind: 'client-accepted', shell: record.shell, at: record.at })
    }
    // 客户自己取消的那条只留在内存面板，⛔ 进故障记录与客服摘要——那不是故障。
    if (!record.ok && record.code !== 'client_aborted') {
      try { this.clientFailure?.(record) } catch { /* 记录不进去也得把这次请求走完。 */ }
    }
  }

  private updateRetryBlock(route: GatewayRoute, record: ApiRequestRecord, recoveryNotice?: string): void {
    if (route.revision === undefined || record.code === 'client_aborted') return
    if (!record.ok && record.code !== undefined && retryBlockedClientFailures.has(record.code)) {
      this.retryBlocks.set(route.revision, { code: record.code, expiresAt: Date.now() + clientRetryBlockWindowMs, ...(recoveryNotice ? { recoveryNotice } : {}) })
      return
    }
    this.retryBlocks.delete(route.revision)
  }

  /**
   * 连续三次「上游零数据的空闲超时」且都在十分钟内，才把原因从「这次超时」改判成「厂商侧故障」。
   * 有过数据流动的超时（慢而在动、下游倒灌停读被掐）不算厂商账，否则健康厂商会被连坐误报（API-08）。
   */
  private escalateTimeouts(route: GatewayRoute, code: ApiFailure | undefined, sawUpstreamData = false): ApiFailure | undefined {
    const key = `${route.shell}/${route.provider}`
    if (code === 'client_aborted') return code
    if (code !== 'timeout' || sawUpstreamData) { this.timeoutRuns.delete(key); return code }
    const now = Date.now()
    const run = this.timeoutRuns.get(key)
    const next = run && now - run.first <= 600_000 ? { count: run.count + 1, first: run.first } : { count: 1, first: now }
    this.timeoutRuns.set(key, next)
    return next.count >= 3 ? 'provider_outage' : 'timeout'
  }
}

/**
 * A Desktop proof is tied to the active Codex route revision just like generic client acceptance.
 * A CLI request can never create it, and an old proof cannot survive a provider/key/endpoint swap.
 */
class DesktopRouteAcceptanceTracker {
  private active?: ActiveGatewayRoute
  private latest: CodexDesktopRouteVerification = unverified('awaiting_desktop_request')

  replaceRoutes(routes: readonly ActiveGatewayRoute[]): void {
    const next = routes.find(route => route.shell === 'codex')
    if (next?.revision !== this.active?.revision) this.latest = unverified('awaiting_desktop_request')
    this.active = next
  }

  /** @returns 该结果是否改变了当前路由版本上的证明状态；调用方据此决定是否出口回执事件。 */
  record(route: GatewayRoute, result: CodexDesktopRouteVerification): boolean {
    if (route.shell !== 'codex' || route.revision === undefined || this.active?.revision !== route.revision) return false
    const safe = publicDesktopRouteResult(result)
    // Once the current route has a strict Desktop proof, a later CLI/unverified call cannot erase
    // that historical fact. A route replacement above clears it immediately.
    if (safe.status === 'verified' || this.latest.status !== 'verified') {
      if (safe.status === this.latest.status && safe.reason === this.latest.reason) return false
      this.latest = safe
      return true
    }
    return false
  }

  value(): CodexDesktopRouteVerification { return { ...this.latest } }

  clear(): void {
    this.active = undefined
    this.latest = unverified('awaiting_desktop_request')
  }
}

/** The status endpoint and product snapshot are a hard privacy boundary, even for injected test/runtime observers. */
function publicDesktopRouteResult(value: unknown): CodexDesktopRouteVerification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unverified('socket_binding_unavailable')
  const result = value as Record<string, unknown>
  if (result.status === 'verified' && result.reason === 'verified_socket_bound_desktop' &&
    isExactIsoTime(result.at)) {
    return { status: 'verified', at: result.at, reason: 'verified_socket_bound_desktop' }
  }
  if (result.status === 'unverified' && result.at === null &&
    typeof result.reason === 'string' && result.reason !== 'verified_socket_bound_desktop' &&
    desktopRouteReasons.has(result.reason as CodexDesktopRouteVerification['reason'])) {
    return { status: 'unverified', at: null, reason: result.reason as CodexDesktopRouteVerification['reason'] }
  }
  return unverified('socket_binding_unavailable')
}

function isExactIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

/** 只读定长错误体供判类；读完即丢，⛔ 存进记录或转给客户端。 */
async function errorBody(response: Response): Promise<string> {
  try {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (size < 8 * 1024) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value); size += next.value.length
      }
    } finally { reader.releaseLock() }
    await response.body?.cancel().catch(() => undefined)
    return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).subarray(0, 8 * 1024))
  } catch { return '' }
}

/** Inspects bounded SSE frames; never stores prompts, reply text, headers, or provider errors. */
/** HTTP 200 里装着的认证失败：智谱 `code:1000 / 身份验证失败。`，别家多用 401/403 或英文提示。 */
function authFailureInBody(body: Json | null): boolean {
  if (!body) return false
  const code = typeof body.code === 'number' ? body.code : null
  if (code === 401 || code === 403 || code === 1000) return true
  const error = isJson(body.error) ? body.error : null
  const text = [body.msg, body.message, error?.message, error?.code].filter((value): value is string => typeof value === 'string').join(' ')
  return /身份验证失败|认证失败|api key|unauthorized|unauthenticated|invalid_?api_?key|authentication/i.test(text)
}

/** Provider classifier only needs scalar error fields; never stringify or retain an arbitrary-sized upstream reply. */
function providerFailureDetailInBody(body: Json | null, provider: ModelProviderId): ProviderFailureDetail | undefined {
  if (!body) return undefined
  const error = isJson(body.error) ? body.error : undefined
  const compact = JSON.stringify({
    code: scalar(body.code) ?? scalar(error?.code),
    msg: scalar(body.msg) ?? scalar(body.message) ?? scalar(error?.message),
    ...recoveryScalars(body, error),
    error: error === undefined ? undefined : {
      type: scalar(error.type), code: scalar(error.code), message: scalar(error.message)
    }
  })
  const classified = classifyProviderFailure(200, compact, provider)
  if (classified === 'unknown') return undefined
  const recoveryNotice = providerRecoveryNotice(200, compact, classified, provider)
  return { code: classified, ...(recoveryNotice ? { recoveryNotice } : {}) }
}

type ReplyOutcome = { readonly kind: 'answer' | 'tool'; readonly code?: undefined; readonly recoveryNotice?: undefined } | { readonly kind: 'invalid'; readonly code: ApiFailure; readonly recoveryNotice?: string }

/**
 * A completed tool turn is a valid protocol response: the native client must receive it so it
 * can send the tool result next. It is deliberately not a customer-visible answer and therefore
 * never becomes an observed "already using this route" acceptance. In its internal first probe,
 * the gateway accepts either exactly one `toolbox_probe` call or a complete direct answer.
 */
function replyOutcome(observer: ReplyObserver, provider: ModelProviderId, allowProbeToolCall = false): ReplyOutcome {
  if (observer.complete && !observer.failed) {
    if (allowProbeToolCall) {
      if (observer.toolCallCount === 1 && observer.probeToolCallCount === 1) return { kind: 'tool' }
      if (observer.toolCallCount === 0 && observer.hasText) return { kind: 'answer' }
      return { kind: 'invalid', code: 'tool_call_failed' }
    }
    // A client may receive a short planning sentence alongside a tool call. That turn still
    // needs a tool result before the user has an answer, so never promote it to acceptance.
    if (observer.toolCallCount > 0) return { kind: 'tool' }
    if (observer.hasText) return { kind: 'answer' }
  }
  const failure = observer.failure ?? observer.json
  const detail = providerFailureDetailInBody(failure, provider)
  if (detail !== undefined) return { kind: 'invalid', ...detail }
  if (observer.truncated) return { kind: 'invalid', code: 'response_truncated' }
  return { kind: 'invalid', code: authFailureInBody(failure) ? 'key_rejected' : observer.failed ? 'upstream_error' : 'invalid_reply' }
}

/** 每次只判断一个完整 SSE event；原文只在这一小段栈内存中存在，绝不进入记录或客户端响应。 */
function sseEventFailure(event: string, provider: ModelProviderId): ProviderFailureDetail | undefined {
  const lines = event.split(/\r?\n/)
  const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
  const payload = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim()
  const errorEvent = eventName === 'error' || eventName === 'response.failed' || eventName === 'response.incomplete'
  if (!payload || payload === '[DONE]') return errorEvent ? { code: 'upstream_error' } : undefined
  let item: unknown
  try { item = JSON.parse(payload) } catch { return { code: 'invalid_reply' } }
  if (!isJson(item)) return { code: 'invalid_reply' }
  const data = isJson(item.response) ? item.response : item
  if (!errorEvent && !data.error && !['error', 'response.failed', 'response.incomplete'].includes(String(item.type)) && !['failed', 'incomplete'].includes(String(data.status))) return undefined
  const failure = compactFailureFrame(item, data)
  // response.incomplete 撞上输出上限是「回答太长被截断」，⛔ 落到泛化 upstream_error。
  const incompleteDetails = isJson(data.incomplete_details) ? data.incomplete_details : undefined
  if (incompleteDetails !== undefined && /^max(_output)?_tokens$/.test(String(incompleteDetails.reason ?? ''))) return { code: 'response_truncated' }
  return providerFailureDetailInBody(failure, provider)
    ?? { code: authFailureInBody(failure) ? 'key_rejected' : 'upstream_error' }
}

function sseEventBoundary(buffer: string): number {
  const separator = /\r?\n\r?\n/.exec(buffer)
  return separator?.index === undefined ? -1 : separator.index + separator[0].length
}

/** Claude Code may choose its configured small/subagent model; all other client model input stays pinned. */
function routedModel(route: GatewayRoute, body: Json): string {
  const requested = typeof body.model === 'string' ? body.model : ''
  const normalized = normalizeProviderModel(route.provider, route.shell, requested)
  return route.shell === 'claude' && normalized !== undefined && isProviderModelAllowed(route.provider, 'claude', normalized)
    ? normalized : route.model
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

/** Preserve only fixed time fields while an SSE/JSON business error is turned into a safe notice. */
function recoveryScalars(...sources: readonly (Json | undefined)[]): Json {
  const fields: Json = {}
  for (const field of providerRecoveryFields) {
    for (const source of sources) {
      const value = scalar(source?.[field])
      if (value !== undefined) { fields[field] = value; break }
    }
  }
  return fields
}

class ReplyObserver {
  streaming = false
  complete = false
  failed = false
  /** 回答被输出上限截断（max_tokens / finish_reason=length）：不是服务商故障，单独判类。 */
  truncated = false
  hasText = false
  toolCallCount = 0
  probeToolCallCount = 0
  inputTokens: number | null = null
  outputTokens: number | null = null
  json: Json | null = null
  /** Bounded scalar fields from an error frame only; raw provider errors never enter snapshots. */
  failure: Json | null = null
  private buffer = ''
  private decoder = new TextDecoder()
  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    if (this.streaming) {
      let index: number
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1)
        if (line.startsWith('data:')) this.read(line.slice(5).trim())
      }
    }
    if (this.buffer.length > maximumBody) { this.buffer = ''; this.failed = true }
  }
  finish(): void {
    this.buffer += this.decoder.decode()
    if (this.streaming) { if (this.buffer.trim().startsWith('data:')) this.read(this.buffer.trim().slice(5).trim()) }
    else this.read(this.buffer)
    this.buffer = ''
  }
  private read(raw: string): void {
    if (raw === '[DONE]') { this.complete = true; return }
    let item: unknown
    try { item = JSON.parse(raw) } catch { this.failed = true; return }
    if (!isJson(item)) { this.failed = true; return }
    const data = isJson(item.response) ? item.response : item
    if (!this.streaming) this.json = data
    const usage = isJson(data.usage) ? data.usage : isJson(data.message) && isJson(data.message.usage) ? data.message.usage : null
    if (usage) {
      this.inputTokens = tokens(usage.input_tokens ?? usage.prompt_tokens) ?? this.inputTokens
      this.outputTokens = tokens(usage.output_tokens ?? usage.completion_tokens) ?? this.outputTokens
    }
    if (data.error || ['error', 'response.failed', 'response.incomplete'].includes(String(item.type)) || ['failed', 'incomplete'].includes(String(data.status))) {
      this.failed = true
      this.failure = compactFailureFrame(item, data)
    }
    if (item.type === 'response.completed' || item.type === 'message_stop' || data.status === 'completed') this.complete = true
    if (item.type === 'response.output_text.delta' && typeof item.delta === 'string' && item.delta.trim()) this.hasText = true
    if (isJson(item.delta) && typeof item.delta.text === 'string' && item.delta.text.trim()) this.hasText = true
    if (Array.isArray(data.output)) { if (!this.streaming) this.complete = data.status === 'completed'; this.hasText ||= data.output.some(output => isJson(output) && contentText(output.content)) }
    if (Array.isArray(data.content)) { this.hasText ||= contentText(data.content); if (!this.streaming && data.type === 'message' && data.stop_reason) this.complete = true }
    // 截断照样挡住「验收通过」：思考吃光预算时正文可能是空的（provider-rewrite 里有实据），
    // 但判类要单列，⛔ 混进 upstream_error 让客户以为服务商坏了。
    if (data.stop_reason === 'max_tokens' || (isJson(data.delta) && data.delta.stop_reason === 'max_tokens')) { this.failed = true; this.truncated = true }
    // Responses 协议的截断形状：`incomplete_details.reason = max_tokens` 是现行规范拼写，
    // 兼容旧拼写 max_output_tokens——⛔ 把「回答太长被截断」报成服务商异常。
    const incompleteDetails = isJson(data.incomplete_details) ? data.incomplete_details : undefined
    if (incompleteDetails !== undefined && /^max(_output)?_tokens$/.test(String(incompleteDetails.reason ?? ''))) { this.failed = true; this.truncated = true }
    if (Array.isArray(data.choices)) for (const choice of data.choices) {
      if (!isJson(choice)) continue
      if (choice.finish_reason) this.complete = true
      if (choice.finish_reason === 'length') { this.failed = true; this.truncated = true }
      if (choice.finish_reason === 'content_filter') this.failed = true
      const message = isJson(choice.message) ? choice.message : isJson(choice.delta) ? choice.delta : null
      if (message && typeof message.content === 'string' && message.content.trim()) this.hasText = true
    }
    const calls = toolCallSummary(item, data)
    this.toolCallCount += calls.total
    this.probeToolCallCount += calls.toolboxProbe
  }
}

/** Counts only protocol-shaped calls. It retains no tool name, arguments, prompts, or output. */
function toolCallSummary(item: Json, data: Json): { readonly total: number; readonly toolboxProbe: number } {
  let total = 0
  let toolboxProbe = 0
  const add = (candidate: unknown): void => {
    const name = toolCallName(candidate)
    if (name === undefined) return
    total += 1
    if (name === tool.name) toolboxProbe += 1
  }
  const addMany = (candidates: unknown): void => {
    if (Array.isArray(candidates)) for (const candidate of candidates) add(candidate)
  }

  // Non-streaming Responses/Anthropic payloads and their streaming item/block variants.
  add(item.item)
  add(item.content_block)
  addMany(data.output)
  addMany(data.content)
  if (Array.isArray(data.choices)) for (const choice of data.choices) {
    if (!isJson(choice)) continue
    const message = isJson(choice.message) ? choice.message : undefined
    const delta = isJson(choice.delta) ? choice.delta : undefined
    addMany(message?.tool_calls)
    addMany(delta?.tool_calls)
  }
  return { total, toolboxProbe }
}

function toolCallName(candidate: unknown): string | undefined {
  if (!isJson(candidate)) return undefined
  if (candidate.type === 'function_call' && typeof candidate.call_id === 'string' && typeof candidate.name === 'string') return candidate.name
  if (candidate.type === 'tool_use' && typeof candidate.id === 'string' && typeof candidate.name === 'string') return candidate.name
  if (typeof candidate.id === 'string' && isJson(candidate.function) && typeof candidate.function.name === 'string') return candidate.function.name
  return undefined
}

function compactFailureFrame(item: Json, data: Json): Json {
  const itemError = isJson(item.error) ? item.error : undefined
  const dataError = isJson(data.error) ? data.error : itemError
  return {
    code: scalar(data.code) ?? scalar(item.code) ?? scalar(dataError?.code),
    msg: scalar(data.msg) ?? scalar(data.message) ?? scalar(item.msg) ?? scalar(item.message) ?? scalar(dataError?.message),
    ...recoveryScalars(data, item, dataError),
    error: dataError === undefined ? undefined : {
      type: scalar(dataError.type), code: scalar(dataError.code), message: scalar(dataError.message)
    }
  }
}
function tokens(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null }
function contentText(value: unknown): boolean { return Array.isArray(value) && value.some(part => isJson(part) && typeof part.text === 'string' && part.text.trim().length > 0) }
function isJson(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value) }
function sameRouteBinding(left: ActiveGatewayRoute, right: GatewayRoute): boolean {
  return left.provider === right.provider && left.model === right.model && left.endpoint === right.endpoint && left.key === right.key
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function sameToken(a: string, b: string): boolean { return !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)) }
function discardRequestBody(req: IncomingMessage): void {
  // resume() puts the incoming body in flowing mode and lets Node discard chunks without buffering them.
  req.on('error', () => undefined)
  req.resume()
}
/**
 * Shell clients infer retry/auth behavior from HTTP status. Keep one product-failure mapping for
 * raw non-2xx responses, HTTP-200 business errors, and retry short-circuits: terminal customer
 * actions are 400, while a later retry can help only on 429/529/5xx.
 */
function providerFailureStatus(code: ApiFailure): number {
  switch (code) {
    case 'rate_limited':
    case 'membership_quota_exhausted':
    case 'membership_concurrency_limited':
    case 'membership_rate_limited':
    case 'coding_plan_quota_exhausted':
      return 429
    case 'membership_benefits_unavailable':
      return 529
    case 'payload_too_large':
      return 413
    case 'timeout':
      return 504
    case 'provider_outage':
    case 'upstream_error':
    case 'network_error':
    case 'invalid_reply':
    case 'tool_call_failed':
      return 502
    case 'local_service_busy':
    case 'local_service_down':
      return 503
    default:
      return 400
  }
}
function retryBlockStatus(code: ApiFailure): number { return providerFailureStatus(code) }
function gatewayFailureMessage(code: ApiFailure, provider?: ModelProviderId, recoveryNotice?: string): string {
  const message = apiFailureMessage(code, provider).replace(/[。\s]+$/, '')
  const recovery = recoveryNotice?.replace(/[。\s]+$/, '')
  return [message, recovery, '打开来信工具箱查看处理办法'].filter((part): part is string => Boolean(part)).join('。') + '。'
}
function sendProviderFailure(res: ServerResponse, code: ApiFailure, provider: ModelProviderId, recoveryNotice?: string): void {
  sendError(res, providerFailureStatus(code), code, provider, recoveryNotice)
}
function sendError(res: ServerResponse, status: number, code: ApiFailure, provider?: ModelProviderId, recoveryNotice?: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ type: 'error', error: { type: code, message: gatewayFailureMessage(code, provider, recoveryNotice) } }))
}
function sendReplyFailure(res: ServerResponse, code: ApiFailure, provider: ModelProviderId, streaming: boolean, recoveryNotice?: string): void {
  if (streaming && res.headersSent) {
    const event = { type: 'error', error: { type: code, message: gatewayFailureMessage(code, provider, recoveryNotice) } }
    res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
    return
  }
  sendProviderFailure(res, code, provider, recoveryNotice)
}
function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = (): void => { res.off('drain', drained); signal.removeEventListener('abort', aborted) }
    const drained = (): void => { clean(); resolve() }
    const aborted = (): void => { clean(); reject(new Error('CLIENT_DISCONNECTED')) }
    if (signal.aborted) { reject(new Error('CLIENT_DISCONNECTED')); return }
    res.once('drain', drained); signal.addEventListener('abort', aborted, { once: true })
  })
}
const question = 'Call the toolbox_probe tool exactly once. After receiving its result, reply with the word OK.'
const tool = { name: 'toolbox_probe', description: 'Non-mutating connection check. Returns OK.', parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] } }
function probeBody(shell: ApiShell): Json {
  if (shell === 'codex') return { input: [{ role: 'user', content: question }], tools: [{ type: 'function', ...tool }], max_output_tokens: 4096 }
  if (shell === 'claude') return { messages: [{ role: 'user', content: question }], tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }], max_tokens: 4096 }
  return { messages: [{ role: 'user', content: question }], tools: [{ type: 'function', function: tool }], max_tokens: 4096 }
}
function toolResultBody(shell: ApiShell, response: Json | null): Json | null {
  if (!response) return null
  const initial = probeBody(shell)
  if (shell === 'codex' && Array.isArray(response.output)) {
    const call = response.output.find(item => isJson(item) && item.type === 'function_call' && item.name === tool.name)
    if (isJson(call) && typeof call.call_id === 'string') return { ...initial, input: [{ role: 'user', content: question }, ...response.output, { type: 'function_call_output', call_id: call.call_id, output: 'OK' }], stream: true }
  }
  if (shell === 'claude' && Array.isArray(response.content)) {
    const call = response.content.find(item => isJson(item) && item.type === 'tool_use' && item.name === tool.name)
    if (isJson(call) && typeof call.id === 'string') return { ...initial, messages: [{ role: 'user', content: question }, { role: 'assistant', content: response.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'OK' }] }], stream: true }
  }
  if (shell === 'hermes' && Array.isArray(response.choices)) {
    const first = response.choices[0]
    if (isJson(first) && isJson(first.message) && Array.isArray(first.message.tool_calls)) {
      const call = first.message.tool_calls.find(item => isJson(item) && isJson(item.function) && item.function.name === tool.name)
      if (isJson(call) && typeof call.id === 'string') return { ...initial, messages: [{ role: 'user', content: question }, first.message, { role: 'tool', tool_call_id: call.id, content: 'OK' }], stream: true, stream_options: { include_usage: true } }
    }
  }
  return null
}
