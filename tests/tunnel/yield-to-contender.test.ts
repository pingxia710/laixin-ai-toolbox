// 「已有可用外网就复用、不抢」（创始人 09-13 晚硬标准）兑现到争抢这一幕：
// 别的代理软件把系统代理改成它自己的——**如果它那条也能出外网，客户要的「有网可用」已经满足**，
// 那就该让给它，⛔ 每 30 秒抢回来一次。只有它出不了外网，才继续改回来（客户点了连接，我们得负责让他有网）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('争抢时先看对方能不能用', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('yield-contender-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(rivalUsable: () => boolean) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const counters = { probes: 0, connectorStarts: 0 }
    const adapter = { ...base, reapplyOnChange: () => true }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'yield', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.5' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async () => { counters.probes += 1; if (!rivalUsable()) throw new Error('rival cannot reach internet') },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { counters.connectorStarts += 1 }, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.5' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string; reusedProxy?: { host: string; port: number } }
    const registry = () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, { data: string }>
    const rivalTakes = (address: string) => base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: address })
    const round = async () => { clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks() }
    return { daemon, counters, view, registry, rivalTakes, round }
  }

  it('对方自己能出外网：让给它，把系统设置留成它的，状态转成复用；⛔ 继续抢', async () => {
    const h = harness(() => true)
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
    // 让位之后不再抢
    const after = h.registry().ProxyServer?.data
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe(after)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('对方出不了外网：第一次改回来；同一周期第二次又被改就止损，保留对方现值', async () => {
    const h = harness(() => false)
    await h.daemon.run()
    // 第一次被改:客户点了连接,我们负责让他有网 → 改回来
    h.rivalTakes('127.0.0.1:7891')
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_SETTINGS_CONTESTED')
    expect(h.view().reusedProxy).toBeUndefined()
    // 第二次又被改:止损(创始人 2026-09-15)。⛔ 再改回去——反复写回正是系统代理来回翻的根源。
    // 旧行为「再来一轮还是改回来」已撤销。
    h.rivalTakes('127.0.0.1:7891')
    await h.round()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:7891')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('探对方有节流：连续争抢不会每轮都给对方的代理打一次探测', async () => {
    const h = harness(() => false)
    await h.daemon.run()
    for (let round = 0; round < 4; round += 1) { h.rivalTakes(`127.0.0.1:789${String(round)}`); await h.round() }
    expect(h.counters.probes).toBeLessThanOrEqual(2)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })
})
