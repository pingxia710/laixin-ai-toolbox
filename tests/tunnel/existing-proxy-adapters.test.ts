// 两端系统代理适配器对「电脑上别的代理开着吗」的读数(守护据此决定复用还是接管)。
// Windows:ProxyServer 单地址/分协议；macOS:默认路由对应服务的 Secure Web Proxy、PAC、切网与未知态。
import { spawnSync } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProxyServer } from '../../sidecar/win/wininet-values.mjs'
import { probeExistingProxy } from '../../sidecar/win/vless-connector.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import { KNOWN_FAILURE_CODES } from '../../app/main/tunnel/failure-codes'

const servers: Server[] = []
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function recordingHttpProxy() {
  const requests = { connect: 0, tunneledHttp: 0 }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let connected = false
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (!connected) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        requests.connect += 1
        connected = true
        buffer = buffer.slice(end + 4)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (buffer === '') return
      }
      requests.tunneledHttp += 1
      socket.removeAllListeners('data')
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
  })
  servers.push(server)
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
  return { port, requests: () => ({ ...requests }) }
}

describe('Windows ProxyServer 解析', () => {
  it('host:port / 按协议列表 / 只有 socks / 我们自己的口', () => {
    expect(parseProxyServer('127.0.0.1:7890')).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 })
    expect(parseProxyServer('http=proxy.corp:8080;https=proxy.corp:8443;ftp=proxy.corp:21')).toEqual({ kind: 'http', host: 'proxy.corp', port: 8443 })
    expect(parseProxyServer('socks=127.0.0.1:1080')).toEqual({ kind: 'socks', host: '127.0.0.1', port: 1080 })
    expect(parseProxyServer('http=proxy.corp:8080')).toBeUndefined()
    expect(parseProxyServer('')).toBeUndefined()
    expect(parseProxyServer('garbage')).toBeUndefined()
  })

  it('http=A;https=B 时真实探测只请求承载 HTTPS 的 B，不能拿 A 的绿灯冒充', async () => {
    const a = await recordingHttpProxy()
    const b = await recordingHttpProxy()
    const selected = parseProxyServer('http=127.0.0.1:' + String(a.port) + ';https=127.0.0.1:' + String(b.port))
    if (selected === undefined) throw new Error('HTTPS_PROXY_NOT_SELECTED')

    await expect(probeExistingProxy(selected, ['http://target.invalid/'], 800)).resolves.toMatchObject({ url: 'http://target.invalid/' })
    expect({ a: a.requests(), b: b.requests() }).toEqual({
      a: { connect: 0, tunneledHttp: 0 },
      b: { connect: 1, tunneledHttp: 1 }
    })
  })
})

interface MacProbe {
  existing: unknown
  existingFailure?: string | null
  pathFailure?: string | null
  preflightFailure: unknown
  repairSupported: boolean
  invalidated?: string | null
  probeSucceeded?: boolean | null
}

function macProbe(scenario: 'http' | 'socks' | 'pac' | 'ours' | 'none' | 'service-change' | 'auth' | 'no-active' | 'ambiguous' | 'utun-unmapped', knownPorts: readonly number[] = [18080, 18180, 18280, 18380, 18480]): MacProbe {
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const connectorUrl = new URL('../../sidecar/mac/vless-connector.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const scenario = ${JSON.stringify(scenario)}
    const knownPorts = ${JSON.stringify(knownPorts)}
    let activeDevice = scenario === 'utun-unmapped' ? 'utun4' : 'en0'
    let proxyPort = 7890
    const off = 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
    const on = (host, port) => 'Enabled: Yes\\nServer: ' + host + '\\nPort: ' + port + '\\nAuthenticated Proxy Enabled: 0\\n'
    const authenticated = (host, port) => 'Enabled: Yes\\nServer: ' + host + '\\nPort: ' + port + '\\nAuthenticated Proxy Enabled: 1\\n'
    cp.execFileSync = (command, args, options) => {
      if (command.endsWith('/bin/proxy-helper') && args[0] === 'request' &&
          JSON.stringify(JSON.parse(options.input)) === JSON.stringify({ op: 'status' })) return JSON.stringify({ ok: true, version: 3 })
      if (command === '/sbin/route' && args.join(' ') === '-n get default') return scenario === 'no-active' ? 'route to: default\\n' : '   interface: ' + activeDevice + '\\n'
      if (command !== 'networksetup') throw Error('UNEXPECTED_COMMAND ' + command)
      if (args[0] === '-listnetworkserviceorder') return scenario === 'ambiguous'
        ? '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n(2) Other Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n'
        : '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n(2) Ethernet\\n(Hardware Port: Ethernet, Device: en1)\\n'
      if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n'
      if (args[0] === '-getautoproxyurl') return scenario === 'pac' ? 'Enabled: Yes\\nURL: http://127.0.0.1:7890/proxy.pac\\n' : 'Enabled: No\\nURL: (null)\\n'
      if (args[0] === '-getwebproxy') return scenario === 'http' ? on('127.0.0.1', '7000') : off
      if (args[0] === '-getsecurewebproxy') return ['http', 'service-change'].includes(scenario) ? on('127.0.0.1', String(proxyPort)) : scenario === 'ours' ? on('127.0.0.1', '18180') : scenario === 'auth' ? authenticated('proxy.corp', '8443') : off
      if (args[0] === '-getsocksfirewallproxy') return scenario === 'socks' ? on('127.0.0.1', '1080') : scenario === 'ours' ? on('127.0.0.1', '18180') : off
      throw Error('UNEXPECTED_COMMAND ' + args[0])
    }
    syncBuiltinESMExports()
    let proxyServer
    const proxySockets = new Set()
    if (scenario === 'service-change') {
      const { createServer } = await import('node:net')
      proxyServer = createServer((socket) => {
        proxySockets.add(socket)
        socket.on('close', () => proxySockets.delete(socket))
        let tunnelReady = false
        socket.on('data', () => {
          if (!tunnelReady) {
            tunnelReady = true
            activeDevice = 'en1'
            socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n')
          } else {
            socket.write('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok')
          }
        })
      })
      await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
      proxyPort = proxyServer.address().port
    }
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const adapter = createAdapter()
    let preflightFailure = null
    try { adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { preflightFailure = { code: error.code } }
    let existing
    let existingFailure = null
    try { existing = adapter.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts }) } catch (error) { existingFailure = error.code ?? String(error) }
    let pathFailure = null
    try { adapter.currentPathIdentity() } catch (error) { pathFailure = error.code ?? String(error) }
    const snapshot = existing === undefined ? null : { kind: existing.kind, host: existing.host, port: existing.port, url: existing.url, source: existing.source }
    let invalidated = null
    let probeSucceeded = null
    if (scenario === 'service-change') {
      const { probeExistingProxy } = await import(${JSON.stringify(connectorUrl)})
      try {
        await probeExistingProxy(existing, ['http://target.invalid/'], 800)
        probeSucceeded = true
      } catch { probeSucceeded = false }
      try { adapter.validateExistingProxy(existing) } catch (error) { invalidated = error.code ?? String(error) }
      for (const socket of proxySockets) socket.destroy()
      await new Promise((resolve) => proxyServer.close(resolve))
    }
    console.log(JSON.stringify({ existing: snapshot, existingFailure, pathFailure, preflightFailure, invalidated, probeSucceeded,
      repairSupported: adapter.reapplyOnChange?.({ service: 'Wi-Fi', item: 'web-proxy' }) === true }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-path').env }
  })
  if (result.status !== 0) throw new Error(`探针失败:${result.stderr}`)
  return JSON.parse(result.stdout) as MacProbe
}

function macProxySnapshotMutation(mutation: 'host' | 'port' | 'pac' | 'auth') {
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const mutation = ${JSON.stringify(mutation)}
    const proxy = { host: '127.0.0.1', port: 7890, authenticated: '0' }
    const pac = { enabled: false, url: '' }
    cp.execFileSync = (command, args) => {
      if (command === '/sbin/route' && args.join(' ') === '-n get default') return '   interface: en0\\n'
      if (command !== 'networksetup') throw Error('UNEXPECTED_COMMAND ' + command)
      if (args[0] === '-listnetworkserviceorder') return '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n'
      if (args[0] === '-getautoproxyurl') return 'Enabled: ' + (pac.enabled ? 'Yes' : 'No') + '\\nURL: ' + (pac.url || '(null)') + '\\n'
      if (args[0] === '-getsecurewebproxy') return 'Enabled: Yes\\nServer: ' + proxy.host + '\\nPort: ' + String(proxy.port) + '\\nAuthenticated Proxy Enabled: ' + proxy.authenticated + '\\n'
      throw Error('UNEXPECTED_COMMAND ' + args[0])
    }
    syncBuiltinESMExports()
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const adapter = createAdapter()
    const existing = adapter.existingProxy({ host: '127.0.0.1', port: 18080 })
    const probed = { kind: existing.kind, host: existing.host, port: existing.port }
    const probeSucceeded = probed.kind === 'http' && probed.host === '127.0.0.1' && probed.port === 7890
    if (mutation === 'host') proxy.host = 'proxy.changed.invalid'
    if (mutation === 'port') proxy.port = 65534
    if (mutation === 'pac') { pac.enabled = true; pac.url = 'http://pac.changed.invalid/proxy.pac' }
    if (mutation === 'auth') proxy.authenticated = '1'
    let invalidated = null
    try { adapter.validateExistingProxy(existing) } catch (error) { invalidated = error.code ?? String(error) }
    console.log(JSON.stringify({ probed, probeSucceeded, invalidated }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-path').env }
  })
  if (result.status !== 0) throw new Error(`探针失败:${result.stderr}`)
  return JSON.parse(result.stdout) as {
    probed: { kind: string; host: string; port: number }
    probeSucceeded: boolean
    invalidated: string | null
  }
}

function macDaemonSnapshotMutation(
  mutation: 'port' | 'pac' | 'auth',
  phase: 'during-probe' | 'between-rounds' | 'during-reverify' = 'during-probe'
) {
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const daemonUrl = new URL('../../sidecar/mac/daemon-core.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const mutation = ${JSON.stringify(mutation)}
    const phase = ${JSON.stringify(phase)}
    const proxy = { host: '127.0.0.1', port: 7890, authenticated: '0' }
    const pac = { enabled: false, url: '' }
    cp.execFileSync = (command, args) => {
      if (command === '/sbin/route' && args.join(' ') === '-n get default') return '   interface: en0\\n'
      if (command !== 'networksetup') throw Error('UNEXPECTED_COMMAND ' + command)
      if (args[0] === '-listnetworkserviceorder') return '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n'
      if (args[0] === '-getautoproxyurl') return 'Enabled: ' + (pac.enabled ? 'Yes' : 'No') + '\\nURL: ' + (pac.url || '(null)') + '\\n'
      if (args[0] === '-getsecurewebproxy') return 'Enabled: Yes\\nServer: ' + proxy.host + '\\nPort: ' + String(proxy.port) + '\\nAuthenticated Proxy Enabled: ' + proxy.authenticated + '\\n'
      if (args[0] === '-listallnetworkservices') return 'Wi-Fi\\n'
      throw Error('UNEXPECTED_COMMAND ' + args[0])
    }
    syncBuiltinESMExports()
    const root = mkdtempSync(join(tmpdir(), 'mac-daemon-proxy-snapshot-'))
    const intent = {
      desired: 'connected', sessionToken: 'snapshot-race', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.8' }
    }
    writeFileSync(join(root, 'intent.json.tmp'), JSON.stringify(intent) + '\\n', { mode: 0o600 })
    renameSync(join(root, 'intent.json.tmp'), join(root, 'intent.json'))
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const { createDaemon } = await import(${JSON.stringify(daemonUrl)})
    const mutate = () => {
      if (mutation === 'port') proxy.port = mutation === 'port' && phase === 'between-rounds' ? 7891 : 65534
      if (mutation === 'pac') { pac.enabled = true; pac.url = 'http://pac.changed.invalid/proxy.pac' }
      if (mutation === 'auth') proxy.authenticated = '1'
    }
    const clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearTimer: (timer) => { clearTimeout(timer); clearInterval(timer) }
    }
    let exit
    const exited = new Promise((resolve) => { exit = resolve })
    let probed = null
    let probeCalls = 0
    const daemon = createDaemon({
      dataDir: root,
      clock,
      adapter: createAdapter(),
      random: () => 0,
      parentAlive: () => true,
      onExit: exit,
      probeProxy: async (candidate) => {
        probeCalls += 1
        probed = { kind: candidate.kind, host: candidate.host, port: candidate.port }
        await Promise.resolve()
        if (phase === 'during-probe' || (phase === 'during-reverify' && probeCalls === 2)) mutate()
      },
      connectorFactory: () => { throw new Error('LOCAL_CONNECTOR_MUST_NOT_START_IN_THIS_ASSERTION') },
      bridgeFactory: () => { throw new Error('LOCAL_BRIDGE_MUST_NOT_START_IN_THIS_ASSERTION') }
    })
    await daemon.run()
    let reverifyRejected = null
    if (phase === 'between-rounds' || phase === 'during-reverify') {
      if (phase === 'between-rounds') mutate()
      try { await daemon.reverify(false) } catch (error) { reverifyRejected = error.code ?? String(error) }
    }
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    daemon.requestShutdown()
    await exited
    rmSync(root, { recursive: true, force: true })
    console.log(JSON.stringify({ probed, state: state.state, code: state.code, reusedProxy: state.reusedProxy ?? null, reverifyRejected }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...macDaemonLaunch('/unused-path').env }
  })
  if (result.status !== 0) throw new Error(`DaemonCore 探针失败:${result.stderr}`)
  return JSON.parse(result.stdout) as {
    probed: { kind: string; host: string; port: number }
    state: string
    code: string
    reusedProxy: unknown
    reverifyRejected: string | null
  }
}

describe('macOS 系统代理读数', () => {
  it('只报告活动服务的 Secure Web Proxy；普通 Web Proxy 不能冒充 HTTPS 路径', () => {
    const probe = macProbe('http')
    expect(probe.preflightFailure).toBeNull()
    expect(probe.existing).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 7890, source: 'Wi-Fi/secure-web-proxy' })
    expect(probe.repairSupported).toBe(true)
  })
  it('已有 socks 代理 / PAC / 我们自己的残留 / 没有代理', () => {
    expect(macProbe('socks').existing).toBeNull()
    expect(macProbe('pac').existing).toMatchObject({ kind: 'pac', url: 'http://127.0.0.1:7890/proxy.pac' })
    expect(macProbe('ours').existing).toBeNull()
    expect(macProbe('none').existing).toBeNull()
  })

  it('探测期间默认路由切到另一服务时，原候选立即失效，不能写成 reused', () => {
    const probe = macProbe('service-change')
    expect(probe.existing).toMatchObject({ source: 'Wi-Fi/secure-web-proxy' })
    expect(probe.probeSucceeded).toBe(true)
    expect(probe.invalidated).toBe('TUNNEL_ACTIVE_NETWORK_CHANGED')
  })

  it('同一 en0 探测后 host/port/PAC/认证任一变化，原候选都失效', () => {
    for (const mutation of ['host', 'port', 'pac', 'auth'] as const) {
      const probe = macProxySnapshotMutation(mutation)
      expect(probe.probed).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 })
      expect(probe.probeSucceeded).toBe(true)
      expect(probe.invalidated).toBe('TUNNEL_ACTIVE_PROXY_CHANGED')
    }
  })

  it('真实 DaemonCore 复用序列在探测末尾遇到端口/PAC/认证变化时绝不落盘 reused', () => {
    for (const mutation of ['port', 'pac', 'auth'] as const) {
      const probe = macDaemonSnapshotMutation(mutation)
      expect(probe.probed).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 })
      expect(probe).toMatchObject({ state: 'error', code: 'TUNNEL_ACTIVE_PROXY_CHANGED', reusedProxy: null })
    }
    expect(KNOWN_FAILURE_CODES.has('TUNNEL_ACTIVE_PROXY_CHANGED')).toBe(true)
  })

  it('reusedProxy 只保存普通 DTO：两轮之间换到可用新端口时复验不抛错并跟随新路径', () => {
    const probe = macDaemonSnapshotMutation('port', 'between-rounds')
    expect(probe.reverifyRejected).toBeNull()
    expect(probe).toMatchObject({
      state: 'connected',
      code: 'TUNNEL_REUSED_EXISTING',
      reusedProxy: { kind: 'http', host: '127.0.0.1', port: 7891 }
    })
  })

  it('第二轮 probe 内同一路径变更时显式复核拒绝旧绿灯，复验 Promise 不外抛', () => {
    const probe = macDaemonSnapshotMutation('port', 'during-reverify')
    expect(probe.reverifyRejected).toBeNull()
    expect(probe).toMatchObject({ state: 'degraded', code: 'TUNNEL_VERIFY_UNCONFIRMED', reusedProxy: null })
  })

  it('活动服务无法唯一确定或代理需要认证时保持未知，不猜一条去复用', () => {
    expect(macProbe('no-active')).toMatchObject({ existing: null, existingFailure: 'TUNNEL_ACTIVE_NETWORK_UNKNOWN' })
    expect(macProbe('ambiguous')).toMatchObject({ existing: null, existingFailure: 'TUNNEL_ACTIVE_NETWORK_UNKNOWN' })
    expect(macProbe('auth')).toMatchObject({ existing: null, existingFailure: 'TUNNEL_SETTINGS_NOT_APPLIED' })
  })

  it('macOS 默认路由落在无服务映射的 utun 时，生产适配器不给它伪造稳定身份', () => {
    expect(macProbe('utun-unmapped')).toMatchObject({ existing: null, existingFailure: 'TUNNEL_ACTIVE_NETWORK_UNKNOWN', pathFailure: 'TUNNEL_ACTIVE_NETWORK_UNKNOWN' })
  })

  it('「这是不是我们的」按守护报上来的记录判,⛔ 靠端口长什么样猜', () => {
    // 18180 在候选表里 → 认出是我们的残留
    expect(macProbe('ours', [18080, 18180]).existing).toBeNull()
    // 同一个 18180,守护没把它报上来 → 就是第三方。这是新判据的诚实行为:
    // 旧判据用正则 /^18[0-9]80$/ 在这里会"蒙对",但同样会把系统随机分配的高位口蒙错。
    expect(macProbe('ours', [18080]).existing).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 18180 })
  })
})
