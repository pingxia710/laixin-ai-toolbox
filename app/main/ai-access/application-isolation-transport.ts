export interface ApplicationIsolationProxyConfig {
  readonly mode: 'fixed_servers' | 'direct'
  readonly proxyRules?: string
  readonly proxyBypassRules?: string
}

export interface ApplicationIsolationHttpConnectSession {
  closeAllConnections(): Promise<void>
  setProxy(config: ApplicationIsolationProxyConfig): Promise<void>
  resolveProxy(url: string): Promise<string>
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export interface ApplicationIsolationHttpConnectSessionFactory {
  create(): ApplicationIsolationHttpConnectSession
}

/**
 * A non-persistent Electron session dedicated to one application's model API egress. Its only
 * legal mode is a verified loopback HTTP/CONNECT entry. The default/system session is never
 * received or mutated here, which keeps VPN, PAC, DNS and every other application outside this capability.
 */
export class ApplicationIsolationHttpConnectTransport {
  private session: ApplicationIsolationHttpConnectSession | undefined
  private proxyUrl: string | undefined

  constructor(private readonly sessions: ApplicationIsolationHttpConnectSessionFactory) {}

  async activate(proxyUrl: string, targetUrl: string): Promise<void> {
    const proxy = loopbackProxy(proxyUrl)
    const target = new URL(targetUrl)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('APPLICATION_ISOLATION_TARGET_INVALID')
    const session = this.session ?? this.sessions.create()
    this.session = session
    try {
      await session.closeAllConnections()
      await session.setProxy({ mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: '<-loopback>' })
      const resolved = await session.resolveProxy(target.toString())
      if (!matchesConfiguredProxy(resolved, proxy)) throw new Error('APPLICATION_ISOLATION_ENTRY_UNVERIFIED')
      this.proxyUrl = proxy
    } catch (error) {
      this.proxyUrl = undefined
      try {
        await session.closeAllConnections()
        await session.setProxy({ mode: 'direct' })
      } catch { /* Controller reports restoration failure; never retain a verified active flag. */ }
      throw error
    }
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const session = this.session
    if (session === undefined || this.proxyUrl === undefined) throw new Error('APPLICATION_ISOLATION_ENTRY_UNAVAILABLE')
    return session.fetch(url, init)
  }

  async deactivate(): Promise<void> {
    const session = this.session
    this.proxyUrl = undefined
    if (session === undefined) return
    await session.closeAllConnections()
    await session.setProxy({ mode: 'direct' })
  }
}

function loopbackProxy(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('APPLICATION_ISOLATION_ENTRY_INVALID') }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      !['127.0.0.1', '::1'].includes(hostname) ||
      !Number.isInteger(Number(parsed.port)) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) {
    throw new Error('APPLICATION_ISOLATION_ENTRY_INVALID')
  }
  return `http://${hostname === '::1' ? '[::1]' : hostname}:${parsed.port}`
}

function matchesConfiguredProxy(resolved: string, configured: string): boolean {
  const endpoint = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(configured)
  if (endpoint === null) return false
  const candidates = resolved.split(';').map(value => value.trim()).filter(Boolean)
  if (candidates.length !== 1) return false
  const candidate = /^(?:PROXY|HTTPS)\s+(127\.0\.0\.1|\[::1\]):(\d{1,5})$/i.exec(candidates[0])
  return candidate !== null && candidate[1] === endpoint[1] && candidate[2] === endpoint[2]
}
