import { platformForRuntime } from './sidecar-path'
import type { Platform } from '../precheck/software-platform'

export interface NetworkAccountSession { readonly accountId: string; readonly accessToken: string; readonly deviceId?: string }
export interface NetworkAccountAccess { readonly client: NetworkAccountClient; readonly session: NetworkAccountSession }
export class NetworkAccountError extends Error {}
export interface ConfigurationCache { readonly id: string; readonly expiresAt: number; readonly etag: string }
export type AccountConfiguration = { id: string; expiresAt: number; etag?: string; lease?: string } &
  ({ archive: Buffer; unchanged?: false } | { unchanged: true; archive?: never })
interface NetworkResponse { body: Buffer; etag?: string; unchanged?: boolean; authorizationId?: string; expiresAt?: number; lease?: string }

/** Main-process only. The account integration supplies the fixed company URL and
 * its normal session; neither is an IPC/renderer parameter. Tokens are never saved. */
export class NetworkAccountClient {
  private readonly base: URL
  private connectionSupported = true
  constructor(baseUrl: string, private readonly timeoutMs = 10000,
    private readonly platform: Platform = platformForRuntime(process.platform)) {
    this.base = new URL(baseUrl)
    if ((this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(this.base.hostname))) ||
        this.base.username || this.base.password || this.base.search || this.base.hash ||
        !/\/v1\/network\/$/.test(this.base.pathname)) {
      throw new NetworkAccountError('NETWORK_ENDPOINT_INVALID')
    }
  }

  sameEndpoint(other: NetworkAccountClient): boolean {
    return this.base.href === other.base.href && this.platform === other.platform
  }

  async claim(session: NetworkAccountSession, signal: AbortSignal, cached?: ConfigurationCache): Promise<AccountConfiguration> {
    if (this.connectionSupported) {
      try {
        const response = await this.request('connection', session, signal, 2 * 1024 * 1024, 'application/vnd.laixin.config', cached?.etag)
        if (!response.authorizationId || !/^lx-[a-f0-9]{32}$/.test(response.authorizationId) ||
            !Number.isSafeInteger(response.expiresAt) || response.expiresAt! <= 0 || !response.lease || !response.etag ||
            response.unchanged && (response.authorizationId !== cached?.id || response.expiresAt !== cached.expiresAt)) {
          throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
        }
        const metadata = { id: response.authorizationId, expiresAt: response.expiresAt!, etag: response.etag, lease: response.lease }
        return response.unchanged ? { ...metadata, unchanged: true } : { ...metadata, archive: response.body }
      } catch (error) {
        if (!(error instanceof NetworkAccountError) || error.message !== 'NETWORK_ROUTE_NOT_FOUND') throw error
        this.connectionSupported = false
      }
    }
    const raw = await this.request('application', session, signal, 16384, 'application/json')
    let data: { application?: { id?: unknown; status?: unknown; expiresAt?: unknown } | null }
    try { data = JSON.parse(raw.body.toString('utf8')) } catch { throw new NetworkAccountError('NETWORK_RESPONSE_INVALID') }
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'application')) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
    if (data.application === null) throw new NetworkAccountError('NETWORK_NO_APPLICATION')
    const app = data.application
    if (!app || typeof app.id !== 'string' || !/^lx-[a-f0-9]{32}$/.test(app.id) || !['pending', 'provisioning', 'ready'].includes(String(app.status))) {
      throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
    }
    if (app.status !== 'ready') throw new NetworkAccountError('NETWORK_APPLICATION_PENDING')
    if (typeof app.expiresAt !== 'number' || !Number.isSafeInteger(app.expiresAt) || app.expiresAt <= 0) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
    const etag = cached?.id === app.id && cached.expiresAt === app.expiresAt ? cached.etag : undefined
    const response = await this.request('configuration', session, signal, 2 * 1024 * 1024, 'application/vnd.laixin.config', etag)
    const metadata = { id: app.id, expiresAt: app.expiresAt, etag: response.etag }
    return response.unchanged ? { ...metadata, unchanged: true } : { ...metadata, archive: response.body }
  }

  async acknowledge(session: NetworkAccountSession, signal: AbortSignal, input: {
    authorizationId: string; configVersion: number; configDigest: string
  }): Promise<void> {
    if (!this.connectionSupported || !session.deviceId) return
    await this.request('acknowledgement', session, signal, 2048, 'application/json', undefined, { ...input, deviceId: session.deviceId })
  }

  /** FB-1:失败终态回传,与 acknowledgement 同一鉴权与通道。payload 只含白名单六字段,
   * 由 DiagnosisReporter 组装;这里只负责把 404(老后台无端点)与 401(会话过期)
   * 标成「不入队空转」的永久失败,⛔ 混进网络一时不可达。 */
  async reportDiagnosis(session: NetworkAccountSession, signal: AbortSignal, payload: {
    code: string; stage: string; platform: string; clientVersion: string; authorizationId: string; timestamp: number
  }): Promise<void> {
    if (!session.deviceId) return
    try {
      await this.request('diagnosis', session, signal, 2048, 'application/json', undefined, payload)
    } catch (error) {
      if (error instanceof NetworkAccountError && ['NETWORK_ROUTE_NOT_FOUND', 'NETWORK_LOGIN_REQUIRED'].includes(error.message)) {
        throw Object.assign(error, { diagnosisPermanent: error.message === 'NETWORK_ROUTE_NOT_FOUND' ? 'route' : 'auth' })
      }
      throw error
    }
  }

  private async request(path: string, session: NetworkAccountSession, signal: AbortSignal, limit: number, contentType: string, etag?: string, post?: unknown): Promise<NetworkResponse> {
    if (!session.accountId || !/^[\x21-\x7e]{1,4096}$/.test(session.accessToken)) throw new NetworkAccountError('NETWORK_LOGIN_REQUIRED')
    // Phase 1:幂等 GET 的瞬时网络抖动重试(3 次尝试,250/750ms)。抖动基线直接变「服务不可用」,
    // 界面误报、接续流程误判;梯子吸收掉。⛔ POST(回执/诊断)不重试——重复提交;服务器给过
    // 答案的(NetworkAccountError:401/404/409/410 等)不重试——那是结论不是抖动。
    const attempts = post === undefined ? 3 : 1
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(path, session, signal, limit, contentType, etag, post)
      } catch (error) {
        const retryable = post === undefined && attempt < attempts && !(error instanceof NetworkAccountError) && !signal.aborted
        if (retryable) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 250 : 750))
          continue
        }
        if (error instanceof NetworkAccountError) throw error
        if (signal.aborted) throw new NetworkAccountError('NETWORK_SESSION_CHANGED')
        throw new NetworkAccountError('NETWORK_SERVICE_UNAVAILABLE')
      }
    }
  }

  private async attempt(path: string, session: NetworkAccountSession, signal: AbortSignal, limit: number, contentType: string, etag?: string, post?: unknown): Promise<NetworkResponse> {
    try {
      const response = await fetch(new URL(path, this.base), { redirect: 'error', cache: 'no-store',
        ...(post === undefined ? {} : { method: 'POST', body: JSON.stringify(post) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: { Authorization: `Bearer ${session.accessToken}`, Accept: contentType,
          'X-Laixin-Platform': this.platform, ...(post === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(etag ? { 'If-None-Match': etag } : {}) } })
      const metadata = { authorizationId: response.headers.get('x-laixin-authorization-id') ?? undefined,
        expiresAt: response.headers.has('x-laixin-expires-at') ? Number(response.headers.get('x-laixin-expires-at')) : undefined,
        lease: response.headers.get('x-laixin-connection-lease') ?? undefined }
      if (response.status === 304) {
        await response.body?.cancel()
        if (!etag || response.headers.get('etag') !== etag) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
        return { body: Buffer.alloc(0), etag, unchanged: true, ...metadata }
      }
      if (!response.ok) {
        if (path === 'connection' && [404, 409].includes(response.status) || path === 'diagnosis' && response.status === 404) {
          // Older account servers have no connection route. A missing application on a new server is distinct.
          // diagnosis 同理:老后台没有这个端点(404)必须与「后台一时不可达」分开,⛔ 让回传空转入队。
          let size = 0; const chunks: Uint8Array[] = []
          if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > 2048) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID'); chunks.push(chunk) }
          let code: unknown
          try { code = JSON.parse(Buffer.concat(chunks).toString('utf8')).code } catch { /* A legacy 404 may have no JSON body. */ }
          if (response.status === 409) throw new NetworkAccountError(code === 'NETWORK_APPLICATION_PENDING'
            ? 'NETWORK_APPLICATION_PENDING' : 'NETWORK_AUTHORIZATION_UNAVAILABLE')
          throw new NetworkAccountError(code === 'NETWORK_NO_APPLICATION' ? 'NETWORK_NO_APPLICATION' : 'NETWORK_ROUTE_NOT_FOUND')
        }
        await response.body?.cancel()
        throw new NetworkAccountError(response.status === 401 ? 'NETWORK_LOGIN_REQUIRED' : response.status === 409 || response.status === 410
          ? 'NETWORK_AUTHORIZATION_UNAVAILABLE' : 'NETWORK_SERVICE_UNAVAILABLE')
      }
      if (response.headers.get('content-type')?.split(';')[0] !== contentType || !response.body) {
        await response.body?.cancel(); throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
      }
      const chunks: Buffer[] = []; let size = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > limit) { await reader.cancel(); throw new NetworkAccountError('NETWORK_RESPONSE_INVALID') }
          chunks.push(Buffer.from(value))
        }
      } finally { reader.releaseLock() }
      const receivedEtag = response.headers.get('etag') ?? ''
      return { body: Buffer.concat(chunks), etag: /^"[a-f0-9]{64}"$/.test(receivedEtag) ? receivedEtag : undefined, ...metadata }
    } catch (error) {
      if (signal.aborted) throw new NetworkAccountError('NETWORK_SESSION_CHANGED')
      if (error instanceof NetworkAccountError) throw error
      throw error // 原样上抛给 request 分诊:幂等 GET 抖动重试,重试用尽再包「服务不可用」
    }
  }
}
