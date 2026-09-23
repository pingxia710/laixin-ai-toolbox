import { session } from 'electron'
import { readNetworkDiagnosticProxy } from '../tunnel/runtime-owner'
import { diagnosticProbeAllowed, DiagnosticProbeError, domesticDiagnosticUrl, type DiagnosticProbeResult } from './service'
import { recipeStore } from '../shells/context'

export { DiagnosticProbeError } from './service'

/** 签名配方下发的服务商地址也要能探；未签名或读不到就只允许内置地址。 */
function recipeEndpoints(): readonly string[] {
  try { return Object.values(recipeStore().current().providers).flatMap((override) => Object.values(override?.endpoints ?? {})) } catch { return [] }
}

// A private in-memory session carries no browser/account cookies and never changes system proxy settings.
export async function probeDiagnosticUrl(url: string, route: 'direct' | 'tunnel'): Promise<DiagnosticProbeResult> {
  if (!diagnosticProbeAllowed(url, route, recipeEndpoints())) throw new Error('DIAGNOSTIC_TARGET_INVALID')
  const proxy = route === 'direct' ? undefined : readNetworkDiagnosticProxy()
  const probeSession = session.fromPartition(`toolbox-network-diagnostic-${route}`, { cache: false })
  await probeSession.closeAllConnections()
  await probeSession.setProxy(proxy === undefined ? { mode: 'direct' } : {
    mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: '<-loopback>'
  })
  const startedAt = performance.now()
  try {
    const response = await probeSession.fetch(url, {
      method: url === domesticDiagnosticUrl ? 'GET' : 'HEAD', redirect: 'manual',
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5_000)
    })
    await response.body?.cancel()
    return { status: response.status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new DiagnosticProbeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
      Math.max(0, Math.round(performance.now() - startedAt)))
  } finally { await probeSession.closeAllConnections() }
}
