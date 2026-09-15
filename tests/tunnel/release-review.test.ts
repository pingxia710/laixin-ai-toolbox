// GPT-6 09-13 发布审查的 5 条复现(R1 退出时恢复写失败 / R2 可选终端项阻断网络 / R3 批量改设置 / R4 macOS 有代理即拒 / R5 崩溃兜底误报):原样收进仓库当长期用例。
import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createDaemon, installCrashBailout } from '../../sidecar/win/daemon-core.mjs'
import { appendSettingEntry } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { composeManagedAdapters } from '../../sidecar/win/managed-adapter.mjs'
import { createTerminalEnvironmentAdapter } from '../../sidecar/win/terminal-environment.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))
function directory() { const root = makeTempDir('release-review-'); roots.push(root); return root }

it('一次批量改变四项代理设置，应该一次恢复完整，不能被算作多次争抢而遗留 PAC', async () => {
  const root = directory()
  const adapter = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  writeIntentFile(root, { desired: 'connected', sessionToken: 'review', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }) })
  try {
    await daemon.run()
    for (const [item, value] of Object.entries({ ProxyServer: '127.0.0.1:7890', ProxyEnable: '0',
      ProxyOverride: 'external.local', AutoConfigURL: 'http://127.0.0.1:7890/proxy.pac' })) {
      adapter.write({ service: 'WinINET', item }, { type: item === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', data: value })
    }
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
    expect(state.state).toBe('connected')
    expect(registry.AutoConfigURL).toBeUndefined()
  } finally { daemon.requestShutdown(); await flushMicrotasks() }
})

it('崩溃兜底中的恢复写失败，不能报告已经恢复原设置', () => {
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const ref = { service: 'WinINET', item: 'ProxyEnable' }
  const value = { type: 'REG_DWORD' as const, data: '1' }
  appendSettingEntry(root, { ...ref, originalValue: null, writtenValue: value, sessionToken: 'review', time: 1 })
  base.write(ref, value)
  let exitCode = 0
  const bailout = installCrashBailout({ dataDir: root, adapterOf: () => ({ ...base,
    write: () => { throw Error('temporary write failure') } }), exit: (code) => { exitCode = code } })
  try {
    process.emit('uncaughtException', Error('injected crash'))
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    expect(exitCode).toBe(70)
    expect(state.message).not.toContain('已恢复原设置')
    expect(state.message).toContain('恢复未完成')
  } finally { bailout.dispose() }
})

it('macOS 存在旧代理配置时，不能不检查它是否可用就直接拒绝联网', () => {
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    cp.execFileSync = (command, args) => {
      if(command !== 'networksetup') throw Error('UNEXPECTED_COMMAND')
      if(args[0] === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n'
      if(args[0] === '-getautoproxyurl') return 'Enabled: No\\nURL: (null)\\n'
      if(['-getwebproxy','-getsecurewebproxy','-getsocksfirewallproxy'].includes(args[0]))
        return 'Enabled: Yes\\nServer: 127.0.0.1\\nPort: 7890\\nAuthenticated Proxy Enabled: 0\\n'
      throw Error('UNEXPECTED_COMMAND')
    }
    syncBuiltinESMExports()
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const adapter = createAdapter()
    let failure = null
    try { adapter.preflight({host:'127.0.0.1',port:18080}) } catch(error) { failure = {code:error.code,message:error.message} }
    console.log(JSON.stringify({ failure, repairSupported: adapter.reapplyOnChange?.({service:'Wi-Fi',item:'web-proxy'}) === true }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-review-path').env }
  })
  expect(result.status, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(observed.failure).toBeNull()
})

it('退出时注册表短暂写失败，不能停止恢复并留下指向已关闭中继的系统代理', async () => {
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  let locked = false
  let bridgeAlive = true
  let exitCode: number | undefined
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (locked) throw Error('temporary registry lock after adapter retries')
    base.write(ref, value)
  } }
  writeIntentFile(root, { desired: 'connected', sessionToken: 'review-exit', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: (code) => { exitCode = code },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => { bridgeAlive = false },
      isAlive: () => bridgeAlive, onLost: () => {} }) })
  await daemon.run()
  locked = true
  daemon.requestShutdown(); await flushMicrotasks()
  locked = false
  clock.advance(60_000); await flushMicrotasks()
  const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
  expect(bridgeAlive).toBe(false)
  expect(registry.ProxyEnable?.data).not.toBe('1')
  // 锁解除后按节奏重试成功:正常退出码 0,不是带着「恢复未完成」走
  expect(exitCode).toBe(0)
})

it('可选的 cmd AutoRun 注册表读失败，不应阻止系统代理网络连接', async () => {
  const root = directory()
  const home = join(root, 'home'); mkdirSync(home)
  const clock = new FakeClock()
  const network = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  // Actual terminal adapter, with a command boundary returning Windows access-denied.
  const terminal = createTerminalEnvironmentAdapter({ enabled: true, home, documentsDirectory: join(home, 'Documents'),
    run: () => { throw Object.assign(Error('Access is denied.'), { stderr: 'ERROR: Access is denied.' }) } })
  const adapter = composeManagedAdapters(network, terminal)
  let connectorStarts = 0
  writeIntentFile(root, { desired: 'connected', sessionToken: 'terminal-permission', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { connectorStarts++ }, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }) })
  try {
    await daemon.run()
    // Access to an optional terminal hook may remain denied; network startup must still proceed.
    for (let attempt = 0; attempt < 6; attempt++) { clock.advance(10_000); await flushMicrotasks() }
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    expect(state.state).toBe('connected')
    expect(connectorStarts).toBe(1)
  } finally { daemon.requestShutdown(); await flushMicrotasks() }
})
