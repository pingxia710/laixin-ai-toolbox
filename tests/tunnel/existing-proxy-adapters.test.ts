// 两端系统代理适配器对「电脑上别的代理开着吗」的读数(守护据此决定复用还是接管)。
// Windows:ProxyServer 两种写法、PAC、我们自己的残留;macOS:web/secure/socks 三项、PAC、我们自己的残留、服务不存在。
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseProxyServer } from '../../sidecar/win/wininet-values.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'

describe('Windows ProxyServer 解析', () => {
  it('host:port / 按协议列表 / 只有 socks / 我们自己的口', () => {
    expect(parseProxyServer('127.0.0.1:7890')).toEqual({ kind: 'http', host: '127.0.0.1', port: 7890 })
    expect(parseProxyServer('http=proxy.corp:8080;https=proxy.corp:8443;ftp=proxy.corp:21')).toEqual({ kind: 'http', host: 'proxy.corp', port: 8080 })
    expect(parseProxyServer('socks=127.0.0.1:1080')).toEqual({ kind: 'socks', host: '127.0.0.1', port: 1080 })
    expect(parseProxyServer('')).toBeUndefined()
    expect(parseProxyServer('garbage')).toBeUndefined()
  })
})

interface MacProbe { existing: unknown; preflightFailure: unknown; repairSupported: boolean }

function macProbe(scenario: 'http' | 'socks' | 'pac' | 'ours' | 'none', knownPorts: readonly number[] = [18080, 18180, 18280, 18380, 18480]): MacProbe {
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const scenario = ${JSON.stringify(scenario)}
    const knownPorts = ${JSON.stringify(knownPorts)}
    const off = 'Enabled: No\\nServer: \\nPort: 0\\nAuthenticated Proxy Enabled: 0\\n'
    const on = (host, port) => 'Enabled: Yes\\nServer: ' + host + '\\nPort: ' + port + '\\nAuthenticated Proxy Enabled: 0\\n'
    cp.execFileSync = (command, args) => {
      if (command !== 'networksetup') throw Error('UNEXPECTED_COMMAND')
      if (args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n'
      if (args[0] === '-getautoproxyurl') return scenario === 'pac' ? 'Enabled: Yes\\nURL: http://127.0.0.1:7890/proxy.pac\\n' : 'Enabled: No\\nURL: (null)\\n'
      if (args[0] === '-getwebproxy' || args[0] === '-getsecurewebproxy') return scenario === 'http' ? on('127.0.0.1', '7890') : scenario === 'ours' ? on('127.0.0.1', '18180') : off
      if (args[0] === '-getsocksfirewallproxy') return scenario === 'socks' ? on('127.0.0.1', '1080') : scenario === 'ours' ? on('127.0.0.1', '18180') : off
      throw Error('UNEXPECTED_COMMAND ' + args[0])
    }
    syncBuiltinESMExports()
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const adapter = createAdapter()
    let preflightFailure = null
    try { adapter.preflight({ host: '127.0.0.1', port: 18080 }) } catch (error) { preflightFailure = { code: error.code } }
    console.log(JSON.stringify({ existing: adapter.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts }) ?? null, preflightFailure,
      repairSupported: adapter.reapplyOnChange?.({ service: 'Wi-Fi', item: 'web-proxy' }) === true }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-path').env }
  })
  if (result.status !== 0) throw new Error(`探针失败:${result.stderr}`)
  return JSON.parse(result.stdout) as MacProbe
}

describe('macOS 系统代理读数', () => {
  it('已有 http 代理:不再拒绝,报出来给守护判能不能用;支持修回', () => {
    const probe = macProbe('http')
    expect(probe.preflightFailure).toBeNull()
    expect(probe.existing).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 7890 })
    expect(probe.repairSupported).toBe(true)
  })
  it('已有 socks 代理 / PAC / 我们自己的残留 / 没有代理', () => {
    expect(macProbe('socks').existing).toMatchObject({ kind: 'socks', host: '127.0.0.1', port: 1080 })
    expect(macProbe('pac').existing).toMatchObject({ kind: 'pac', url: 'http://127.0.0.1:7890/proxy.pac' })
    expect(macProbe('ours').existing).toBeNull()
    expect(macProbe('none').existing).toBeNull()
  })

  it('「这是不是我们的」按守护报上来的记录判,⛔ 靠端口长什么样猜', () => {
    // 18180 在候选表里 → 认出是我们的残留
    expect(macProbe('ours', [18080, 18180]).existing).toBeNull()
    // 同一个 18180,守护没把它报上来 → 就是第三方。这是新判据的诚实行为:
    // 旧判据用正则 /^18[0-9]80$/ 在这里会"蒙对",但同样会把系统随机分配的高位口蒙错。
    expect(macProbe('ours', [18080]).existing).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 18180 })
  })
})
