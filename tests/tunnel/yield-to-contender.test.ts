// 「已有可用外网就复用、不抢」（创始人 09-13 晚硬标准）兑现到争抢这一幕：
// 别的代理软件把系统代理改成它自己的——**如果它那条也能出外网，客户要的「有网可用」已经满足**，
// 那就该让给它，⛔ 每 30 秒抢回来一次。只有它出不了外网，才继续改回来（客户点了连接，我们得负责让他有网）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'
import { macDaemonLaunch } from '../../app/main/tunnel/platform/mac'

describe('争抢时先看对方能不能用', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('yield-contender-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(rivalUsable: () => boolean | Promise<boolean>, restoreBlocked: () => boolean = () => false,
    initiallyEnabled = false, onConnectorStop: () => void = () => undefined) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    // N-61 将读不到连接设置保守视为未知 WPAD 路径；本组争抢场景明确构造手动代理。
    base.write({ service: 'WinINET', item: 'DefaultConnectionSettings' }, { type: 'REG_BINARY', data: '460000000000000001000000' })
    if (initiallyEnabled) base.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' })
    const counters = { probes: 0, connectorStarts: 0, connectorStops: 0, bridgeCloses: 0 }
    const adapter = {
      ...base,
      reapplyOnChange: () => true,
      write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
        const data = (value as { data?: string } | null)?.data
        if (restoreBlocked() && ref.item === 'ProxyServer' && data !== '127.0.0.1:18080') {
          throw new Error('temporary restore write failure')
        }
        base.write(ref, value)
      }
    }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'yield', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.5' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async () => { counters.probes += 1; if (!await rivalUsable()) throw new Error('rival cannot reach internet') },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { counters.connectorStarts += 1 }, stop: async () => { counters.connectorStops += 1; onConnectorStop() },
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.5' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => { counters.bridgeCloses += 1 }, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string; reusedProxy?: { host: string; port: number } }
    const registry = () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, { data: string }>
    const rivalTakes = (address: string) => base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: address })
    const round = async () => { clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks() }
    return { daemon, counters, view, registry, rivalTakes, setRegistry: base.write, round }
  }

  it('对方自己能出外网：让给它，把系统设置留成它的，状态转成复用；⛔ 继续抢', async () => {
    const h = harness(() => true, () => false, true)
    await h.daemon.run()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    // 第一步仍然先改回来（客户不能在我们判断期间没网），随后探对方
    expect(h.counters.probes).toBeGreaterThan(0)
    await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.view().reusedProxy).toMatchObject({ host: '127.0.0.1', port: 7890 })
    // 系统设置留给对方，⛔ 还成空、⛔ 还是我们的
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:7890')
    expect(h.registry().ProxyEnable?.data).toBe('1')
    // 让位之后不再抢
    const after = h.registry().ProxyServer?.data
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe(after)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('对方出不了外网：同一连接意图按当前证据有界夺回，不能在第二次争用时机械停手', async () => {
    const h = harness(() => false)
    await h.daemon.run()
    // 第一次被改:客户点了连接,我们负责让他有网 → 改回来
    h.rivalTakes('127.0.0.1:7891')
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_SETTINGS_CONTESTED')
    expect(h.view().reusedProxy).toBeUndefined()
    // 第二次又被改:按新证据再夺回，而非沿用旧的「第二次就停手」。
    h.rivalTakes('127.0.0.1:7891')
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view()).toMatchObject({ state: 'connected', code: 'TUNNEL_SETTINGS_CONTESTED' })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('探对方有节流：连续争抢不会每轮都给对方的代理打一次探测', async () => {
    const h = harness(() => false)
    await h.daemon.run()
    for (let round = 0; round < 4; round += 1) { h.rivalTakes(`127.0.0.1:789${String(round)}`); await h.round() }
    expect(h.counters.probes).toBeLessThanOrEqual(2)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('让路恢复暂时写失败时保留本地通道，恢复成功后才关闭并切到 rival（旧实现会先关成死路）', async () => {
    let blocked = true
    const h = harness(() => true, () => blocked, true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    await flushMicrotasks(); await flushMicrotasks()

    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE' })
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.counters.connectorStops).toBe(0)
    expect(h.counters.bridgeCloses).toBe(0)

    blocked = false
    clock.advance(1_000)
    await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view()).toMatchObject({
      state: 'connected', code: 'TUNNEL_REUSED_EXISTING', reusedProxy: { host: '127.0.0.1', port: 7890 }
    })
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:7890')
    expect(h.counters.connectorStops).toBe(1)
    expect(h.counters.bridgeCloses).toBe(1)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('恢复等待期间 B 已失效，重新接回本地通道而不报复用死 B', async () => {
    let blocked = true
    let usable = true
    const h = harness(() => usable, () => blocked, true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    expect(h.counters.probes).toBe(1)
    expect(h.counters.connectorStops).toBe(0)
    usable = false
    blocked = false
    clock.advance(1_000)
    await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.probes).toBe(2)
    expect(h.counters.connectorStops).toBe(0)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view().reusedProxy).toBeUndefined()
    expect(h.view().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('恢复曾失败且 B 后来变成 C，不能卡在旧恢复错误或关成来信死端口', async () => {
    let blocked = true
    const h = harness(() => true, () => blocked, true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE' })
    expect(h.counters.connectorStops).toBe(0)
    h.rivalTakes('127.0.0.1:7891')
    blocked = false
    clock.advance(1_000)
    await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view()).toMatchObject({ state: 'connected', code: 'TUNNEL_SETTINGS_CONTESTED' })
    expect(h.view().reusedProxy).toBeUndefined()
    expect(h.counters.connectorStops).toBe(0)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('对方依赖来信临时打开的代理开关时，不把关闭的地址误报为已复用', async () => {
    const h = harness(() => true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyEnable?.data).toBe('1')
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.counters.connectorStops).toBe(0)
    expect(h.view().reusedProxy).toBeUndefined()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it.each([
    ['PAC', 'AutoConfigURL', { type: 'REG_SZ', data: 'https://pac.example/config.pac' }],
    ['WPAD', 'DefaultConnectionSettings', { type: 'REG_BINARY', data: '460000000000000009000000' }],
    ['Connections PAC', 'DefaultConnectionSettings', { type: 'REG_BINARY', data: '460000000000000005000000' }]
  ])('原 %s 会覆盖 B 的路径时，不把 B 的地址当成有效复用', async (_label, item, value) => {
    const h = harness(() => true, () => false, true)
    h.setRegistry({ service: 'WinINET', item }, value)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.connectorStops).toBe(0)
    expect(h.view().reusedProxy).toBeUndefined()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('停止本地通道时 B 又被 C 替换，最终状态不冒充复用 B', async () => {
    const h = harness(() => true, () => false, true, () => h.rivalTakes('127.0.0.1:7891'))
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.connectorStops).toBe(1)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:7891')
    expect(h.view()).toMatchObject({ state: 'connected', code: 'TUNNEL_REUSED_EXISTING', reusedProxy: { host: '127.0.0.1', port: 7891 } })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('探测 rival 期间连接意图更新，不执行旧意图的让路恢复', async () => {
    let releaseProbe!: () => void
    const probe = new Promise<boolean>((resolve) => { releaseProbe = () => resolve(true) })
    const h = harness(() => probe, () => false, true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    expect(h.counters.probes).toBe(1)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    const active = h.daemon as unknown as { intent: { sessionToken: string } }
    active.intent = { ...active.intent, sessionToken: 'new-connection' }
    releaseProbe()
    await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.counters.connectorStops).toBe(0)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('探通 rival 后系统路径又被改成第三方，重新裁决并保持本地承接，不误报复用旧 rival', async () => {
    let releaseProbe!: () => void
    const probe = new Promise<boolean>((resolve) => { releaseProbe = () => resolve(true) })
    const h = harness(() => probe, () => false, true)
    await h.daemon.run()
    h.rivalTakes('127.0.0.1:7890')
    await h.round()
    expect(h.counters.probes).toBe(1)
    h.rivalTakes('127.0.0.1:7891')
    releaseProbe()
    await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.counters.connectorStops).toBe(0)
    expect(h.view().reusedProxy).toBeUndefined()
    expect(h.view()).toMatchObject({ state: 'connected', code: 'TUNNEL_SETTINGS_CONTESTED' })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('macOS 真实适配器捕获普通 endpoint 后先修回我方，锁外仍能探 rival 并让路', () => {
    const adapterUrl = new URL('../../sidecar/mac/adapter-networksetup.mjs', import.meta.url).href
    const daemonUrl = new URL('../../sidecar/mac/daemon-core.mjs', import.meta.url).href
    const script = `
      import cp from 'node:child_process'
      import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      const off = () => ({ enabled: false, host: '', port: 0, authenticated: '0' })
      const proxies = { web: off(), secure: off(), socks: off() }
      const pac = { enabled: false, url: '' }
      const output = (value) => 'Enabled: ' + (value.enabled ? 'Yes' : 'No') + '\\nServer: ' + value.host +
        '\\nPort: ' + String(value.port) + '\\nAuthenticated Proxy Enabled: ' + value.authenticated + '\\n'
      const itemFor = (command) => command.includes('secure') ? proxies.secure : command.includes('socks') ? proxies.socks : proxies.web
      cp.execFileSync = (command, args) => {
        if (command === '/sbin/route' && args.join(' ') === '-n get default') return '   interface: en0\\n'
        if (command !== 'networksetup') throw Error('UNEXPECTED_COMMAND ' + command)
        const action = args[0]
        if (action === '-listnetworkserviceorder') return '(1) Wi-Fi\\n(Hardware Port: Wi-Fi, Device: en0)\\n'
        if (action === '-listallnetworkservices') return 'Wi-Fi\\n'
        if (action === '-getautoproxyurl') return 'Enabled: ' + (pac.enabled ? 'Yes' : 'No') + '\\nURL: ' + (pac.url || '(null)') + '\\n'
        if (action.startsWith('-get')) return output(itemFor(action))
        if (action === '-setautoproxyurl') { pac.url = args[2]; pac.enabled = true; return '' }
        if (action === '-setautoproxystate') { pac.enabled = args[2] === 'on'; return '' }
        if (action.startsWith('-set') && action.endsWith('state')) { itemFor(action).enabled = args[2] === 'on'; return '' }
        if (action.startsWith('-set')) {
          const item = itemFor(action)
          item.host = args[2]
          item.port = Number(args[3])
          return ''
        }
        throw Error('UNEXPECTED_COMMAND ' + action)
      }
      syncBuiltinESMExports()
      const root = mkdtempSync(join(tmpdir(), 'mac-contender-yield-'))
      const intent = {
        desired: 'connected', sessionToken: 'mac-contender', bridgePort: 18080,
        connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' }
      }
      writeFileSync(join(root, 'intent.json.tmp'), JSON.stringify(intent) + '\\n', { mode: 0o600 })
      renameSync(join(root, 'intent.json.tmp'), join(root, 'intent.json'))
      const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
      const { createDaemon } = await import(${JSON.stringify(daemonUrl)})
      const clock = {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearTimer: (timer) => { clearTimeout(timer); clearInterval(timer) }
      }
      let exit
      const exited = new Promise((resolve) => { exit = resolve })
      const probed = []
      const daemon = createDaemon({
        dataDir: root,
        clock,
        adapter: createAdapter(),
        random: () => 0,
        parentAlive: () => true,
        onExit: exit,
        verifyIntervalMs: 60000,
        probeProxy: async (candidate) => {
          probed.push({
            kind: candidate.kind, host: candidate.host, port: candidate.port,
            kindIsGetter: typeof Object.getOwnPropertyDescriptor(candidate, 'kind')?.get === 'function'
          })
        },
        connectorFactory: () => ({
          kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
          localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' })
        }),
        bridgeFactory: () => ({
          listen: async () => undefined, close: async () => undefined, isAlive: () => true,
          onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' })
        })
      })
      await daemon.run()
      proxies.secure = { enabled: true, host: '127.0.0.1', port: 7890, authenticated: '0' }
      await daemon.reverify(false)
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve))
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
      const finalSecure = { ...proxies.secure }
      daemon.requestShutdown()
      await exited
      rmSync(root, { recursive: true, force: true })
      console.log(JSON.stringify({ state, finalSecure, probed }))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...macDaemonLaunch('/unused-path').env }
    })
    expect(result.status, result.stderr).toBe(0)
    const outcome = JSON.parse(result.stdout) as {
      state: { state: string; code: string; reusedProxy?: { kind: string; host: string; port: number } }
      finalSecure: { enabled: boolean; host: string; port: number }
      probed: Array<{ kind: string; host: string; port: number; kindIsGetter: boolean }>
    }
    expect(outcome.probed).toEqual(Array(2).fill({ kind: 'http', host: '127.0.0.1', port: 7890, kindIsGetter: false }))
    expect(outcome.state).toMatchObject({
      state: 'connected', code: 'TUNNEL_REUSED_EXISTING', reusedProxy: { kind: 'http', host: '127.0.0.1', port: 7890 }
    })
    expect(outcome.finalSecure).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7890 })
  })
})
