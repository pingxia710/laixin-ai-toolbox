// GPT-6 复核 2a19530 的三条边界用例(场景原样收进仓库,断言按它的验收条件补成「实际系统值恢复并销账」):
// ① 复用中电脑当前代理被改成失效的新地址 → 必须重读当前设置、改建来信连接;
// ② macOS 接管时必须关掉旧 PAC(Chromium 里 PAC 优先于手动代理),退出按原样还回;
// ③ 正常退出时恢复写失败跨过全部快速重试期限 → 守护慢节奏继续还,故障解除后实际还回、销账、退出码 0。
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { pendingSettingEntries } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'
import { DaemonSupervisor } from '../../app/main/tunnel/supervisor'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { ShutdownRegistry } from '../../app/main/bridge/shutdown-registry'
import { installShutdownLifecycle } from '../../app/main/bridge/shutdown-lifecycle'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
function directory() { const root = makeTempDir('review-2a19530-'); roots.push(root); return root }
const intent = { desired: 'connected' as const, sessionToken: 'review', bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
const connector = () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
  localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) })
const bridge = () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); roots.splice(0).forEach(removeTempDir) })

it('复用期间系统改到失效的新代理，不能只探旧地址而一直显示已连', async () => {
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const setPort = (port: number) => base.write(ref, { type: 'REG_SZ', data: `127.0.0.1:${port}` })
  setPort(7890)
  base.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' })
  const probed: number[] = []
  let settingsReads = 0
  let starts = 0
  const adapter = { ...base, existingProxy: () => {
    settingsReads++
    return { kind: 'http' as const, host: '127.0.0.1', port: Number((base.read(ref) as { data: string }).data.split(':')[1]) }
  } }
  writeIntentFile(root, intent)
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    probeProxy: async proxy => { probed.push(proxy.port!); if (proxy.port !== 7890) throw Error('new proxy unavailable') },
    connectorFactory: () => ({ ...connector(), start: async () => { starts++ } }), bridgeFactory: bridge })
  try {
    await daemon.run()
    setPort(7891)
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    clock.advance(1_000); await flushMicrotasks(); await flushMicrotasks()
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    expect(state.state).toBe('connected')
    expect(settingsReads).toBeGreaterThan(1)
    expect(probed).toContain(7891)
    expect(starts).toBe(1)
    expect((base.read(ref) as { data: string } | null)?.data).toBe('127.0.0.1:18080')
  } finally { daemon.requestShutdown(); await flushMicrotasks() }
})

it('macOS 接管 PAC 时必须停用旧 PAC，不能只写手动代理后显示已连', () => {
  const root = directory()
  writeIntentFile(root, intent)
  const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
  const daemonUrl = new URL('../../sidecar/mac/daemon-core.mjs', import.meta.url).href
  const script = `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { readFileSync } from 'node:fs'
    const root = ${JSON.stringify(root)}
    let pacEnabled = true
    let pacUrl = 'http://127.0.0.1:7890/config.pac'
    const fields = ['webproxy', 'securewebproxy', 'socksfirewallproxy']
    const settings = Object.fromEntries(fields.map(k => [k, {enabled:false,host:'',port:0}]))
    const commands = []
    cp.execFileSync = (command, args) => {
      if(command !== 'networksetup') throw Error('UNEXPECTED_COMMAND')
      commands.push(args)
      const op = args[0]
      if(op === '-listallnetworkservices') return 'An asterisk (*) denotes...\\nWi-Fi\\n'
      if(op === '-getautoproxyurl') return 'URL: ' + pacUrl + '\\nEnabled: ' + (pacEnabled ? 'Yes' : 'No') + '\\n'
      if(op === '-setautoproxystate') { pacEnabled = args[2] === 'on'; return '' }
      if(op === '-setautoproxyurl') { pacUrl = args[2]; return '' }
      for(const field of fields) {
        const value = settings[field]
        if(op === '-get' + field) return 'Enabled: ' + (value.enabled ? 'Yes' : 'No') + '\\nServer: ' + value.host + '\\nPort: ' + value.port + '\\nAuthenticated Proxy Enabled: 0\\n'
        if(op === '-set' + field) { value.host = args[2]; value.port = Number(args[3]); return '' }
        if(op === '-set' + field + 'state') { value.enabled = args[2] === 'on'; return '' }
      }
      throw Error('UNEXPECTED_COMMAND ' + op)
    }
    syncBuiltinESMExports()
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const { createDaemon } = await import(${JSON.stringify(daemonUrl)})
    const daemon = createDaemon({dataDir:root, adapter:createAdapter(),
      clock:{now:Date.now,setInterval:()=>0,setTimeout:()=>0,clearTimer:()=>{}}, parentAlive:()=>true,onExit:()=>{},
      connectorFactory:()=>({kind:'loopback-probe',start:async()=>{},stop:async()=>{},localProxyPort:()=>1,onLost:()=>{},verify:async()=>({exitIp:'203.0.113.1'})}),
      bridgeFactory:()=>({listen:async()=>{},close:async()=>{},isAlive:()=>true,onLost:()=>{}})})
    await daemon.run()
    const state = JSON.parse(readFileSync(root + '/state.json','utf8'))
    const connected = {state:state.state,pacEnabled,pacUrl,settings:JSON.parse(JSON.stringify(settings)),changedPac:commands.some(args=>args[0]==='-setautoproxystate')}
    daemon.requestShutdown()
    await new Promise(resolve => setTimeout(resolve, 200))
    const after = JSON.parse(readFileSync(root + '/state.json','utf8'))
    console.log(JSON.stringify({ connected, restored: {state:after.state,pacEnabled,pacUrl,settings} }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...macDaemonLaunch('/unused-review-path').env }
  })
  expect(result.status, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout)
  expect(observed.connected.state).toBe('connected')
  expect(observed.connected.pacEnabled).toBe(false)
  expect(observed.connected.settings.webproxy).toEqual({ enabled: true, host: '127.0.0.1', port: 18080 })
  // 退出:PAC 原样还回(开关 + 地址),手动代理关掉
  expect(observed.restored.state).toBe('stopped-restored')
  expect(observed.restored.pacEnabled).toBe(true)
  expect(observed.restored.pacUrl).toBe('http://127.0.0.1:7890/config.pac')
  expect(observed.restored.settings.webproxy.enabled).toBe(false)
})

it('正常退出的恢复重试耗尽后，主进程所称的补恢复不能漏掉', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let locked = false
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (locked) throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  const clock = { now: Date.now,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout) }
  const child = new EventEmitter()
  let mainExitAt: number | undefined
  let sidecarExitAt: number | undefined
  let sidecarExitCode: number | undefined
  const startedAt = Date.now()
  const supervisor = new DaemonSupervisor({ dataDir: root, spawnDaemon: () => child,
    spawnRestore: () => new EventEmitter() })
  supervisor.ensureRunning()
  writeIntentFile(root, intent)
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => mainExitAt === undefined,
    onExit: code => { sidecarExitAt = Date.now() - startedAt; sidecarExitCode = code; child.emit('exit', code, null) },
    connectorFactory: connector, bridgeFactory: bridge })
  await daemon.run()
  locked = true
  const service = { supervisor, deps: { dataDir: root, now: Date.now }, clearConnectionLease: () => {},
    intentSnapshot: () => JSON.parse(readFileSync(join(root, 'intent.json'), 'utf8')), markResumeOnLaunch: () => {} } as unknown as TunnelService
  const registry = new ShutdownRegistry()
  registry.registerShutdownHook('tunnel', () => TunnelService.prototype.requestShutdown.call(service))
  const app = Object.assign(new EventEmitter(), { exit: () => { mainExitAt = Date.now() - startedAt } })
  installShutdownLifecycle(app, registry, 5000, () => {})
  app.emit('before-quit', { preventDefault: () => {} })
  await vi.advanceTimersByTimeAsync(70_000)
  // 主程序 5 秒内已退出;故障跨过了全部快速重试期限(约 68 秒),守护还活着、还在慢节奏重试
  expect(mainExitAt).toBeLessThan(10_000)
  expect(sidecarExitAt).toBeUndefined()
  expect(base.read({ service: 'WinINET', item: 'ProxyServer' })).toEqual({ type: 'REG_SZ', data: '127.0.0.1:18080' })
  locked = false
  await vi.advanceTimersByTimeAsync(40_000)
  // 故障解除后:实际系统值还回(原本没有代理)、账本销账、守护正常退出
  expect((base.read({ service: 'WinINET', item: 'ProxyEnable' }) as { data?: string } | null)?.data).not.toBe('1')
  expect(base.read({ service: 'WinINET', item: 'ProxyServer' })).toBeNull()
  expect(pendingSettingEntries(root)).toEqual([])
  expect(sidecarExitCode).toBe(0)
  expect(sidecarExitAt).toBeGreaterThan(70_000)
})
