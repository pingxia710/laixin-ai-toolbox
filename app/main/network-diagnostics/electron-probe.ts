import { session, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { readExistingNetworkDiagnosticEvidence, readLaixinNetworkDiagnosticEndpoint, readLaixinNetworkDiagnosticProxy,
  readNetworkDiagnosticProxy } from '../tunnel/runtime-owner'
import { diagnosticProbeAllowed, DiagnosticProbeError, domesticDiagnosticUrl, type DiagnosticProbeResult } from './service'
import type { DiagnosticProbePhase, DiagnosticProbeRoute } from '../../network-diagnostics-types'
import { recipeStore } from '../shells/context'

export { DiagnosticProbeError } from './service'

const electronProbeTimeoutMs = 5_400
const sessionPoolSize = 2
const busySessionSlots = new Map<string, boolean[]>()

interface SessionLease {
  readonly value: Session
  readonly release: () => void
}

/** 签名配方下发的服务商地址也要能探；未签名或读不到就只允许内置地址。 */
function recipeEndpoints(): readonly string[] {
  try { return Object.values(recipeStore().current().providers).flatMap((override) => Object.values(override?.endpoints ?? {})) } catch { return [] }
}

// A private in-memory session carries no browser/account cookies and never changes system proxy settings.
export async function probeDiagnosticUrl(url: string, route: DiagnosticProbeRoute): Promise<DiagnosticProbeResult> {
  if (!diagnosticProbeAllowed(url, route, recipeEndpoints())) throw new Error('DIAGNOSTIC_TARGET_INVALID')
  const lease = acquireDiagnosticSession(`toolbox-network-diagnostic-${route}`)
  const probeSession = lease.value
  let failurePhase: DiagnosticProbePhase | undefined
  const startedAt = performance.now()
  const deadline = diagnosticDeadline(startedAt)
  const operation = (async () => {
    try {
      const proxy = route === 'direct' ? undefined : route === 'tunnel' ? readNetworkDiagnosticProxy()
        : route === 'laixin-tunnel' ? readLaixinNetworkDiagnosticProxy() : undefined
      if (route === 'laixin-tunnel' && proxy === undefined) throw new DiagnosticProbeError('path-unavailable')
      await probeSession.closeAllConnections()
      deadline.assertActive()
      await probeSession.setProxy(route === 'existing-proxy' ? { mode: 'system' }
        : proxy === undefined ? { mode: 'direct' }
          : { mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: '<-loopback>' })
      deadline.assertActive()
      probeSession.webRequest.onErrorOccurred({ urls: [`${new URL(url).origin}/*`] }, (details) => {
        if (details.url === url) failurePhase = safeFailurePhase(details.error)
      })
      if (route === 'existing-proxy') {
        const resolved = await probeSession.resolveProxy(url)
        deadline.assertActive()
        const systemProxy = resolvedSystemProxy(resolved)
        const laixinEndpoint = readLaixinNetworkDiagnosticEndpoint()
        let existingProxy = systemProxy
        if (laixinEndpoint !== undefined && systemProxy === laixinEndpoint) {
          existingProxy = readExistingNetworkDiagnosticEvidence()?.proxyUrl
          deadline.assertActive()
        }
        if (existingProxy === undefined || existingProxy === laixinEndpoint) {
          throw new DiagnosticProbeError('path-unavailable', Math.max(0, Math.round(performance.now() - startedAt)))
        }
        // 只在这份无 Cookie 的私有会话里固定 resolveProxy 给出的第一条路径，避免代理失败后回退 DIRECT 串成直连结果。
        await probeSession.setProxy({ mode: 'fixed_servers', proxyRules: existingProxy, proxyBypassRules: '<-loopback>' })
        deadline.assertActive()
      }
      const response = await probeSession.fetch(url, {
        method: url === domesticDiagnosticUrl ? 'GET' : 'HEAD', redirect: 'manual',
        credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(5_000)])
      })
      deadline.assertActive()
      await response.body?.cancel()
      const result: DiagnosticProbeResult = {
        status: response.status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), phase: 'http'
      }
      return result
    } catch (error) {
      if (error instanceof DiagnosticProbeError) throw error
      const name = error instanceof Error ? error.name : ''
      throw new DiagnosticProbeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
        Math.max(0, Math.round(performance.now() - startedAt)), failurePhase)
    } finally {
      try {
        try { probeSession.webRequest.onErrorOccurred(null) } catch { /* 临时会话失效时仅放弃清理回调。 */ }
        try { await probeSession.closeAllConnections() } catch { /* 清理失败不覆盖已得到的受控结果。 */ }
      } finally { lease.release() }
    }
  })()
  return boundedElectronOperation(operation, startedAt, deadline.expire)
}

/** 只返回不可逆指纹，用于确认矩阵检查前后系统代理、当前实际入口和来信桥没有变化。 */
export async function readDiagnosticPathContext(url: string): Promise<string> {
  if (!diagnosticProbeAllowed(url, 'direct', recipeEndpoints())) throw new Error('DIAGNOSTIC_TARGET_INVALID')
  const lease = acquireDiagnosticSession('toolbox-network-diagnostic-context')
  const probeSession = lease.value
  const startedAt = performance.now()
  const deadline = diagnosticDeadline(startedAt)
  const operation = (async () => {
    try {
      await probeSession.closeAllConnections()
      deadline.assertActive()
      await probeSession.setProxy({ mode: 'system' })
      deadline.assertActive()
      const system = resolvedSystemProxy(await probeSession.resolveProxy(url)) ?? 'direct'
      deadline.assertActive()
      const current = readNetworkDiagnosticProxy() ?? 'direct'
      const laixin = readLaixinNetworkDiagnosticProxy() ?? 'unavailable'
      const reservedLaixin = readLaixinNetworkDiagnosticEndpoint() ?? 'unavailable'
      const existingEvidence = readExistingNetworkDiagnosticEvidence()
      if (existingEvidence === undefined) throw new Error('DIAGNOSTIC_PATH_CONTEXT_UNAVAILABLE')
      deadline.assertActive()
      const recoveredExisting = existingEvidence.proxyUrl ?? 'unavailable'
      const activeNetwork = existingEvidence.pathFingerprint
      return createHash('sha256').update(JSON.stringify({ system, current, laixin, reservedLaixin, recoveredExisting, activeNetwork })).digest('hex')
    } finally {
      try { await probeSession.closeAllConnections() } catch { /* 清理失败不覆盖路径指纹结果。 */ }
      finally { lease.release() }
    }
  })()
  return boundedElectronOperation(operation, startedAt, deadline.expire)
}

function acquireDiagnosticSession(prefix: string): SessionLease {
  const slots = busySessionSlots.get(prefix) ?? []
  let index = slots.findIndex((busy) => !busy)
  if (index < 0) {
    if (slots.length >= sessionPoolSize) throw new DiagnosticProbeError('path-unavailable')
    index = slots.length
    slots.push(false)
    busySessionSlots.set(prefix, slots)
  }
  slots[index] = true
  try {
    const value = session.fromPartition(`${prefix}-${String(index)}`, { cache: false })
    return { value, release: () => { slots[index] = false } }
  } catch (error) {
    slots[index] = false
    throw error
  }
}

function diagnosticDeadline(startedAt: number): { readonly signal: AbortSignal; readonly assertActive: () => void; readonly expire: () => void } {
  const controller = new AbortController()
  let expired = false
  const timeout = () => new DiagnosticProbeError('timeout', Math.max(0, Math.round(performance.now() - startedAt)))
  return {
    signal: controller.signal,
    assertActive: () => {
      if (!expired && performance.now() - startedAt >= electronProbeTimeoutMs) {
        expired = true
        controller.abort()
      }
      if (expired) throw timeout()
    },
    expire: () => { expired = true; controller.abort() }
  }
}

async function boundedElectronOperation<T>(operation: Promise<T>, startedAt: number, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expire()
          reject(new DiagnosticProbeError('timeout', Math.max(0, Math.round(performance.now() - startedAt))))
        }, electronProbeTimeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function resolvedSystemProxy(value: string): string | undefined {
  const first = value.split(';', 1)[0]?.trim() ?? ''
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\[[0-9a-f:]+\]|[^\s/:@?#;\\]+):(\d{1,5})$/i.exec(first)
  if (match === null) return undefined
  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const schemes: Readonly<Record<string, string>> = {
    PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5'
  }
  return `${schemes[match[1].toUpperCase()]}://${match[2]}:${String(port)}`
}

/** Chromium 原始错误只在此处映射成固定阶段，原文不得进入报告、界面或支持包。 */
function safeFailurePhase(value: string): DiagnosticProbePhase | undefined {
  if (/ERR_(?:NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_)/.test(value)) return 'dns'
  if (/ERR_(?:CERT_|SSL_|BAD_SSL_CLIENT_AUTH_CERT|HTTP2_INADEQUATE_TRANSPORT_SECURITY)/.test(value)) return 'tls'
  if (/ERR_(?:HTTP2_|HTTP_|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING)/.test(value)) return 'http'
  if (/ERR_(?:PROXY_|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)/.test(value)) return 'proxy'
  if (/ERR_(?:CONNECTION_|ADDRESS_|NETWORK_CHANGED|INTERNET_DISCONNECTED)/.test(value)) return 'connection'
  return undefined
}
