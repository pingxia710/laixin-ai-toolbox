// 「已有可用外网就复用、不抢;客户点连接后由工具箱负责接通、验证、持续恢复」(创始人 09-13 晚)。
// 守护层四种形态:①已有代理能出外网 → 复用,不改任何系统设置;②已有代理出不了外网 → 接管建来信连接;
// ③复用中现有代理失效 → 自动改建来信连接、写入系统设置;④原本直连(没有代理)→ 正常建来信连接。PAC 按不可判定 → 接管。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('已有可用外网优先复用', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-reuse-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(existing: { kind: 'http' | 'socks' | 'pac'; host?: string; port?: number; url?: string } | undefined, usable: () => boolean) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const counters = { probes: 0, connectorStarts: 0 }
    const adapter = { ...base, existingProxy: () => existing }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'reuse', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.6' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async () => { counters.probes += 1; if (!usable()) throw new Error('existing proxy dead') },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { counters.connectorStarts += 1 }, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.6' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string; reusedProxy?: { host: string; port: number } }
    const registry = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}) as Record<string, { data: string }>
    return { daemon, counters, view, registry }
  }

  it('①已有代理能出外网:复用它,不改任何系统设置,不起来信连接;状态说明复用了谁', async () => {
    const h = harness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => true)
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.view().message).toContain('检测到电脑上的其他代理（127.0.0.1:7890）可联网')
    expect(h.view().reusedProxy).toMatchObject({ host: '127.0.0.1', port: 7890 })
    expect(h.registry()).toEqual({})
    expect(h.counters.connectorStarts).toBe(0)
    // 定期复验只探现有代理
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.probes).toBe(2)
    expect(h.view().state).toBe('connected')
    // 用户断开:没有东西要还,状态回到已停止
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'stop' })
    clock.advance(600); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().state).toBe('stopped-restored')
    expect(h.registry()).toEqual({})
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('②已有代理出不了外网:接管,建来信连接并写系统设置', async () => {
    const h = harness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => false)
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('')
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.registry()).toEqual({})
  })

  it('③复用中现有代理失效:先待确认,1 秒后确认失效 → 自动改建来信连接、写入系统设置', async () => {
    let alive = true
    const h = harness({ kind: 'socks', host: '127.0.0.1', port: 1080 }, () => alive)
    await h.daemon.run()
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    alive = false
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().state).toBe('degraded')
    clock.advance(1_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('')
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  // GPT-6 复核 2a19530 #2:复用中每轮都要重读电脑**当前**的代理设置,⛔ 只探记住的旧地址。
  function mutableHarness(initial: { kind: 'http' | 'socks' | 'pac'; host?: string; port?: number; url?: string } | undefined, deadPorts: () => number[]) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const box = { existing: initial, probed: [] as number[], connectorStarts: 0 }
    const adapter = { ...base, existingProxy: () => box.existing }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'reuse-mut', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.6' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async (proxy: { port?: number }) => { box.probed.push(proxy.port ?? 0); if (deadPorts().includes(proxy.port ?? 0)) throw new Error('proxy dead') },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { box.connectorStarts += 1 }, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.6' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string; reusedProxy?: { host: string; port: number } }
    const registry = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}) as Record<string, { data: string }>
    const round = async () => { clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); clock.advance(1_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks() }
    return { daemon, box, view, registry, round }
  }

  it('⑤复用中对方软件换了端口:新口能出外网 → 跟着复用新口,仍不改系统设置', async () => {
    const h = mutableHarness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => [])
    await h.daemon.run()
    h.box.existing = { kind: 'http', host: '127.0.0.1', port: 7891 }
    await h.round()
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.view().reusedProxy).toMatchObject({ port: 7891 })
    expect(h.box.probed.at(-1)).toBe(7891)
    expect(h.box.connectorStarts).toBe(0)
    expect(h.registry()).toEqual({})
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('⑥复用中对方软件换到失效的端口(旧口仍活着):按当前设置判,改建来信连接', async () => {
    const h = mutableHarness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => [7891])
    await h.daemon.run()
    h.box.existing = { kind: 'http', host: '127.0.0.1', port: 7891 }
    await h.round()
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('')
    expect(h.box.connectorStarts).toBe(1)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('⑦复用中对方软件把系统代理关了 / 切成 PAC:改建来信连接', async () => {
    const closed = mutableHarness({ kind: 'socks', host: '127.0.0.1', port: 1080 }, () => [])
    await closed.daemon.run()
    closed.box.existing = undefined
    await closed.round()
    expect(closed.view().code).toBe('')
    expect(closed.box.connectorStarts).toBe(1)
    expect(closed.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    closed.daemon.requestShutdown(); await flushMicrotasks()
    removeTempDir(dataDir); dataDir = makeTempDir('laixin-reuse-to-pac-')
    const pac = mutableHarness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => [])
    await pac.daemon.run()
    pac.box.existing = { kind: 'pac', url: 'http://127.0.0.1:7890/proxy.pac' }
    await pac.round()
    expect(pac.view().code).toBe('')
    expect(pac.box.connectorStarts).toBe(1)
    expect(pac.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    pac.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('⑧客户已主动断开:哪怕对方代理随后失效也不接管', async () => {
    const h = mutableHarness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => [7890])
    // 首次探活时旧口还活着
    let dead = false
    const alive = mutableHarness({ kind: 'http', host: '127.0.0.1', port: 7890 }, () => (dead ? [7890] : []))
    void h
    await alive.daemon.run()
    expect(alive.view().code).toBe('TUNNEL_REUSED_EXISTING')
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'stop' })
    clock.advance(600); await flushMicrotasks(); await flushMicrotasks()
    expect(alive.view().state).toBe('stopped-restored')
    dead = true
    await alive.round()
    expect(alive.view().state).toBe('stopped-restored')
    expect(alive.box.connectorStarts).toBe(0)
    expect(alive.registry()).toEqual({})
    alive.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('④原本直连(没有别的代理):正常建来信连接;PAC 按不可判定 → 接管', async () => {
    const direct = harness(undefined, () => true)
    await direct.daemon.run()
    expect(direct.view().state).toBe('connected')
    expect(direct.counters.probes).toBe(0)
    expect(direct.counters.connectorStarts).toBe(1)
    direct.daemon.requestShutdown(); await flushMicrotasks()
    removeTempDir(dataDir); dataDir = makeTempDir('laixin-reuse-pac-')
    const pac = harness({ kind: 'pac', url: 'http://127.0.0.1:7890/proxy.pac' }, () => true)
    await pac.daemon.run()
    expect(pac.view().state).toBe('connected')
    expect(pac.counters.probes).toBe(0)
    expect(pac.counters.connectorStarts).toBe(1)
    pac.daemon.requestShutdown(); await flushMicrotasks()
  })
})
