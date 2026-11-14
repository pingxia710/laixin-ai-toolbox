import { session } from 'electron'
import type { QualityRuntime } from './runtime-context'
import type { QualitySession } from './controller'

let owned = false

/** In-memory sessions; fixed proxy without DIRECT fallback, no cookies or OS proxy changes. */
export async function openQualitySession(runtime: QualityRuntime): Promise<QualitySession> {
  if (owned) throw new Error('QUALITY_SESSION_BUSY')
  owned = true
  const isolated = session.fromPartition('toolbox-network-quality')
  const direct = session.fromPartition('toolbox-network-quality-source')
  let closing: Promise<void> | undefined
  const close = () => closing ??= Promise.all([isolated.closeAllConnections(), direct.closeAllConnections()]).then(() => { owned = false })
  try {
    await isolated.closeAllConnections()
    await isolated.setProxy(runtime.proxy === null ? { mode: 'direct' }
      : { mode: 'fixed_servers', proxyRules: runtime.proxy, proxyBypassRules: '<-loopback>' })
    const resolved = await isolated.resolveProxy(`${runtime.origin}/v1/network/quality/start`)
    const expected = runtime.proxy === null ? null : new URL(runtime.proxy)
    const expectedResolution = expected === null ? 'DIRECT' : `${expected.protocol === 'socks5:' ? 'SOCKS5' : 'PROXY'} ${expected.hostname}:${expected.port}`
    if (resolved !== expectedResolution) throw new Error('QUALITY_PROXY_UNCONFIRMED')
    // This optional second session never changes OS settings. It is used only after the customer
    // opts in, to classify the network exit; failure leaves region/ISP unknown.
    let directFetch: typeof fetch | undefined
    try {
      await direct.closeAllConnections()
      await direct.setProxy({ mode: 'direct' })
      if (await direct.resolveProxy(`${runtime.origin}/v1/network/quality/start`) === 'DIRECT') {
        directFetch = ((url, options) => direct.fetch(url as string | Request, options)) as typeof fetch
      }
    } catch { /* Optional classification is unavailable. */ }
    return { fetch: ((url, options) => isolated.fetch(url as string | Request, options)) as typeof fetch,
      ...(directFetch ? { directFetch } : {}), close }
  } catch (error) {
    try { await close() } catch { /* Keep ownership on failed cleanup; do not reuse a contaminated session. */ }
    throw error
  }
}
