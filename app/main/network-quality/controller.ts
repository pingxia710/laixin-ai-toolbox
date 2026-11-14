import { httpMeasurementTransport } from './http-transport'
import { MeasurementError, NetworkQualityMeasurement, type NetworkMeasurement } from './measurement'
import type { QualityRuntime } from './runtime-context'

export type QualityResult =
  | { readonly state: 'complete'; readonly measurement: NetworkMeasurement; readonly sharing: 'shared' | 'not-requested' | 'not-shared' }
  | { readonly state: 'unavailable' | 'failed' | 'cancelled'; readonly reason: string }

export interface QualitySession {
  readonly fetch: typeof fetch
  /** Optional connection to the same company origin using the device's direct network route. */
  readonly directFetch?: typeof fetch
  close(): Promise<void>
}
export interface QualityControllerDeps {
  readonly runtime: () => QualityRuntime | undefined
  readonly open: (runtime: QualityRuntime) => Promise<QualitySession>
}

async function smallJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error(`QUALITY_HTTP_${String(response.status)}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > 4096) throw new Error('QUALITY_RESPONSE_INVALID')
      chunks.push(result.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new Error('QUALITY_ABORTED')) }
    if (signal.aborted) { void work.catch(() => undefined); onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(value => { signal.removeEventListener('abort', onAbort); resolve(value) }, error => { signal.removeEventListener('abort', onAbort); reject(error) })
  })
}

/** No renderer-supplied host, proxy, credentials or node identity enters this controller. */
export class QualityController {
  private active?: AbortController
  private readonly measurement = new NetworkQualityMeasurement()
  constructor(private readonly deps: QualityControllerDeps) {}

  cancel(): boolean {
    if (!this.active) return false
    this.active.abort()
    return true
  }

  async run(share: boolean): Promise<QualityResult> {
    if (this.active) return { state: 'failed', reason: 'busy' }
    const runtime = this.deps.runtime()
    if (!runtime) return { state: 'unavailable', reason: 'path-unavailable' }
    const shouldShare = share && runtime.pathKind === 'laixin'
    const controller = new AbortController()
    this.active = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
    let session: QualitySession | undefined
    let sessionId = ''
    let finished = false
    const isCurrent = () => this.deps.runtime()?.fingerprint === runtime.fingerprint
    const check = () => {
      if (signal.aborted) throw new MeasurementError(controller.signal.aborted ? 'cancelled' : 'timeout')
      if (!isCurrent()) throw new MeasurementError('path-changed')
    }
    const request = async (path: string, payload: unknown, requestSignal: AbortSignal, id = '', fetcher?: typeof fetch) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${runtime.accessToken}`, 'Content-Type': 'application/json' }
      if (id) headers['X-Laixin-Quality-Session'] = id
      return smallJson(await (fetcher ?? session!.fetch)(new URL(path, runtime.origin), { method: 'POST', headers,
        body: JSON.stringify(payload), redirect: 'error', cache: 'no-store', credentials: 'omit', signal: requestSignal }))
    }
    try {
      const opening = this.deps.open(runtime)
      try { session = await abortable(opening, signal) }
      catch (error) { void opening.then(late => late.close()).catch(() => undefined); throw error }
      check()
      const startInput = { authorizationId: runtime.authorizationId, bindingVersion: runtime.bindingVersion, share: shouldShare, pathKind: runtime.pathKind }
      let start: unknown
      if (shouldShare && session.directFetch) {
        try {
          start = await request('/v1/network/quality/start', { ...startInput, sourceScope: 'network-egress' },
            AbortSignal.any([signal, AbortSignal.timeout(5_000)]), '', session.directFetch)
        } catch {
          check()
          start = await request('/v1/network/quality/start', { ...startInput, sourceScope: 'unknown' }, signal)
        }
      } else start = await request('/v1/network/quality/start', { ...startInput, sourceScope: 'unknown' }, signal)
      if (!record(start) || typeof start.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(start.sessionId) ||
          !Number.isSafeInteger(start.payloadBytes) || Number(start.payloadBytes) < 1 || Number(start.payloadBytes) > 2 * 1024 * 1024) throw new Error('QUALITY_RESPONSE_INVALID')
      sessionId = start.sessionId
      check()
      const transport = httpMeasurementTransport({ origin: runtime.origin, fetch: session.fetch, accessToken: runtime.accessToken, sessionId,
        context: async () => this.deps.runtime()?.fingerprint })
      const measured = await this.measurement.run(transport, { bytes: Number(start.payloadBytes), timeoutMs: 35_000, signal })
      check()
      let sharing: 'shared' | 'not-requested' | 'not-shared' = shouldShare ? 'not-shared' : 'not-requested'
      try {
        const report = shouldShare ? { responseMs: measured.responseMs, responseSpreadMs: measured.responseSpreadMs,
          downloadMbps: measured.downloadMbps, uploadMbps: measured.uploadMbps } : {}
        const result = await request('/v1/network/quality/finish', report, signal, sessionId)
        check()
        if (record(result) && result.shared === true && shouldShare) sharing = 'shared'
        finished = true
      } catch (error) {
        if (signal.aborted || !isCurrent()) throw error
        // Result is still useful locally; sharing is explicitly marked unsuccessful.
      }
      return { state: 'complete', measurement: measured, sharing }
    } catch (error) {
      if (controller.signal.aborted) return { state: 'cancelled', reason: 'cancelled' }
      if (signal.aborted) return { state: 'failed', reason: 'timeout' }
      if (error instanceof MeasurementError) return { state: error.code === 'path-unavailable' ? 'unavailable' : 'failed', reason: error.code }
      return { state: 'failed', reason: error instanceof Error && error.message === 'QUALITY_HTTP_404' ? 'service-unavailable' : 'unavailable' }
    } finally {
      if (session && sessionId && !finished && isCurrent()) {
        try {
          const cancelSignal = AbortSignal.timeout(2_000)
          await abortable(request('/v1/network/quality/cancel', {}, cancelSignal, sessionId), cancelSignal)
        } catch { /* Server expires the session. */ }
      }
      if (session) { try { await abortable(session.close(), AbortSignal.timeout(2_000)) } catch { /* Session remains exclusively owned until cleanup finishes. */ } }
      if (this.active === controller) this.active = undefined
    }
  }
}
