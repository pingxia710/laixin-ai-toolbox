import { randomBytes } from 'node:crypto'
import type { MeasurementTransport } from './measurement'

/** Caller owns endpoint trust, route pinning and lifecycle; never accept a renderer-provided URL. */
export function httpMeasurementTransport(options: {
  readonly origin: string
  readonly fetch: typeof fetch
  readonly context: MeasurementTransport['context']
  readonly accessToken: string
  readonly sessionId: string
}): MeasurementTransport {
  const origin = new URL(options.origin)
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MEASUREMENT_ORIGIN_INVALID')
  // Plain HTTP is exclusively for isolated loopback fixtures.
  if (origin.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('MEASUREMENT_ORIGIN_INVALID')
  if (!/^[\x21-\x7e]{1,4096}$/.test(options.accessToken) || !/^[0-9a-f-]{36}$/i.test(options.sessionId)) throw new Error('MEASUREMENT_SESSION_INVALID')
  const call = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${options.accessToken}`)
    headers.set('X-Laixin-Quality-Session', options.sessionId)
    const response = await options.fetch(new URL(path, origin), { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store' })
    if (!response.ok) throw new Error('MEASUREMENT_REQUEST_FAILED')
    return response
  }
  return {
    context: options.context,
    async response(signal) {
      const response = await call('/v1/network/quality/response', { method: 'GET', signal })
      if (response.status !== 204) throw new Error('MEASUREMENT_RESPONSE_INVALID')
      await response.body?.cancel()
    },
    async download(limit, signal) {
      const response = await call('/v1/network/quality/download', { method: 'GET', signal })
      const encoding = response.headers.get('content-encoding')
      if (!response.body || encoding && encoding !== 'identity') throw new Error('MEASUREMENT_DOWNLOAD_INVALID')
      const reader = response.body.getReader()
      let count = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          count += chunk.value.byteLength
          if (count > limit) throw new Error('MEASUREMENT_DOWNLOAD_INVALID')
        }
      } finally { await reader.cancel().catch(() => undefined) }
      return count
    },
    async upload(size, signal) {
      const payload = randomBytes(size)
      const response = await call('/v1/network/quality/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
        body: payload, signal })
      // The server reports bytes actually consumed; it must not reflect a client-supplied count.
      const length = response.headers.get('x-measurement-received-bytes')
      await response.body?.cancel()
      if (!length || !/^(0|[1-9]\d*)$/.test(length)) throw new Error('MEASUREMENT_UPLOAD_INVALID')
      const count = Number(length)
      if (!Number.isSafeInteger(count) || count > size) throw new Error('MEASUREMENT_UPLOAD_INVALID')
      return count
    }
  }
}
