// 「客户这台电脑本来就能到 AI 服务就用它、不改他的设置」（GPT-6 4.3① / 创始人「复用不抢」）。
//
// 这条上一任接过线又撤了：判据拿的是通用探测点，在能上外网的机器上 122 条用例集体走进复用分支。
// 所以本轮两条边界必须有用例钉住：**判据是 AI 服务不是通用探测点**、**不带开关就一次都不探**。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { AI_SERVICE_PROBE_URLS } from '../../sidecar/win/vless-connector.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('本来就能直连 AI 就复用', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-reuse-direct-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(options: {
    reuseDirect?: boolean
    directUsable?: () => boolean
    directThrows?: boolean
    existingWininet?: Record<string, { type: string; data: string }>
    proxyReadFailsOnce?: boolean
    pacAppearsDuringProbe?: boolean
    wpadAppearsDuringProbe?: boolean
    manualProxyAppearsDuringProbe?: boolean
    pacAppearsDuringReverify?: boolean
    manualProxyAppearsDuringReverify?: boolean
    proxyValidationThrows?: boolean
    pathChangesDuringProbe?: boolean
    pathChangesDuringReverify?: boolean
    pathIdentityUnavailable?: boolean
    pathIdentityUnsupported?: boolean
  }) {
    const store = `${dataDir}/registry.json`
    // Existing direct/manual scenarios explicitly start with automatic detection off.
    if (options.existingWininet) writeFileSync(store, JSON.stringify({
      DefaultConnectionSettings: { type: 'REG_BINARY', data: '460000000000000001000000' }, ...options.existingWininet
    }))
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const counters = { directProbes: 0, proxyProbes: 0, connectorStarts: 0, proxyReads: 0, pathReads: 0 }
    // 直连用例没有代理；PAC 用例使用假 WinINET 的实际识别入口。
    let proxyReads = 0
    let pathId = 'direct-route:before'
    const adapter = options.existingWininet ? { ...base, validateExistingProxy: () => {
      if (options.proxyValidationThrows) throw new Error('proxy path changed during validation')
    }, existingProxy: () => {
      proxyReads += 1
      if (options.proxyReadFailsOnce && proxyReads === 1) throw new Error('WinINET read failed')
      return base.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts: [18080] })
    } } : { ...base, existingProxy: () => undefined }
    const readProxy = adapter.existingProxy
    adapter.existingProxy = (...args: Parameters<NonNullable<typeof readProxy>>) => {
      counters.proxyReads += 1
      return readProxy(...args)
    }
    writeIntentFile(dataDir, {
      desired: 'connected', sessionToken: 'direct', bridgePort: 18080,
      ...(options.reuseDirect === undefined ? {} : { reuseDirect: options.reuseDirect }),
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.6' }
    })
    const evidenceAdapter = options.pathIdentityUnsupported ? { ...adapter, currentPathIdentity: undefined } : { ...adapter, currentPathIdentity: () => {
        counters.pathReads += 1
        if (options.pathIdentityUnavailable) throw new Error('active path unavailable')
        return { id: pathId, kind: 'fake-route' }
      } }
    const daemon = createDaemon({
      dataDir, clock, adapter: evidenceAdapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async () => { counters.proxyProbes += 1 },
      probeDirect: async () => {
        counters.directProbes += 1
        if (options.wpadAppearsDuringProbe) {
          const current = JSON.parse(readFileSync(store, 'utf8'))
          current.DefaultConnectionSettings = { type: 'REG_BINARY', data: '460000000000000009000000' }
          writeFileSync(store, JSON.stringify(current))
        }
        if (options.pacAppearsDuringProbe) {
          const current = JSON.parse(readFileSync(store, 'utf8')) as Record<string, { type: string; data: string }>
          current.AutoConfigURL = { type: 'REG_SZ', data: 'http://127.0.0.1:7890/proxy.pac' }
          writeFileSync(store, JSON.stringify(current))
        }
        if (options.manualProxyAppearsDuringProbe) {
          const current = JSON.parse(readFileSync(store, 'utf8')) as Record<string, { type: string; data: string }>
          current.ProxyEnable = { type: 'REG_DWORD', data: '1' }
          current.ProxyServer = { type: 'REG_SZ', data: '127.0.0.1:7890' }
          writeFileSync(store, JSON.stringify(current))
        }
        if (options.pathChangesDuringProbe) pathId = 'direct-route:after'
        if (counters.directProbes >= 2 && options.pathChangesDuringReverify) pathId = 'direct-route:after'
        if (counters.directProbes >= 2 && options.pacAppearsDuringReverify) {
          const current = JSON.parse(readFileSync(store, 'utf8')) as Record<string, { type: string; data: string }>
          current.AutoConfigURL = { type: 'REG_SZ', data: 'http://127.0.0.1:7890/proxy.pac' }
          writeFileSync(store, JSON.stringify(current))
        }
        if (counters.directProbes >= 2 && options.manualProxyAppearsDuringReverify) {
          const current = JSON.parse(readFileSync(store, 'utf8')) as Record<string, { type: string; data: string }>
          current.ProxyEnable = { type: 'REG_DWORD', data: '1' }
          current.ProxyServer = { type: 'REG_SZ', data: '127.0.0.1:7890' }
          writeFileSync(store, JSON.stringify(current))
        }
        if (options.directThrows === true) throw new Error('探测本身炸了')
        if (!(options.directUsable ?? (() => true))()) throw new Error('到不了 AI 服务')
        return { direct: true }
      },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { counters.connectorStarts += 1 }, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.6' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined }),
      intentPollMs: 100
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string; reusedProxy?: { kind: string } }
    const registry = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}) as Record<string, { data: string }>
    return { daemon, counters, view, registry }
  }

  it('判据是「客户真正要用的那些服务」,⛔ 通用探测点', () => {
    // 上一任撤线的真因就在这一行：公司网络常放行 Google 却拦 AI，拿通用点当判据会把这种客户
    // 判成「他自己就能用」而永远等不到我们接管。
    expect(AI_SERVICE_PROBE_URLS).toEqual(['https://chatgpt.com/', 'https://api.anthropic.com/'])
  })

  it('意图不带开关:一次都不探,照旧建来信连接（现有用例的行为一字不差）', async () => {
    const h = harness({})
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    // 正向证据：确实走了来信连接这条老路，⛔ 只断言「没探」——什么都没做也长这样
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().state).toBe('connected')
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('带开关且本来就能到 AI:复用它,不改任何系统设置,不起来信连接', async () => {
    const h = harness({ reuseDirect: true })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.view().reusedProxy).toMatchObject({ kind: 'direct' })
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.registry()).toEqual({})
    // 一次 inspect 与目标探测前后各一次；显式传入 path 时不再重算并丢弃两份路径读数。
    expect(h.counters.pathReads).toBe(3)
  })

  it('PAC 存在时直连探通不能证明 AI 实际路径可用：接管后断开还原原 PAC', async () => {
    const originalWininet = {
      DefaultConnectionSettings: { type: 'REG_BINARY', data: '460000000000000001000000' },
      ProxyEnable: { type: 'REG_DWORD', data: '0' },
      ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      ProxyOverride: { type: 'REG_SZ', data: 'localhost;10.*' },
      AutoConfigURL: { type: 'REG_SZ', data: 'http://127.0.0.1:7890/proxy.pac' }
    }
    const h = harness({ reuseDirect: true, existingWininet: originalWininet })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().state).toBe('connected')
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.registry().AutoConfigURL).toBeUndefined()

    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'pac-stop' })
    clock.advance(600); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().state).toBe('stopped-restored')
    expect(h.registry()).toEqual(originalWininet)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('WPAD 开启不复用直连，受管连接结束后还原自动检测', async () => {
    const original = { ProxyEnable: { type: 'REG_DWORD', data: '0' },
      DefaultConnectionSettings: { type: 'REG_BINARY', data: '460000000000000009000000' } }
    const h = harness({ reuseDirect: true, existingWininet: original })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
    expect(h.registry().DefaultConnectionSettings.data).toBe('460000000100000001000000')
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'wpad-stop' })
    clock.advance(600); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry()).toEqual(original)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('探测中启用 WPAD，旧直连证据失效且不接管新设置', async () => {
    const h = harness({ reuseDirect: true, wpadAppearsDuringProbe: true,
      existingWininet: { ProxyEnable: { type: 'REG_DWORD', data: '0' } } })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
    expect(h.registry().DefaultConnectionSettings.data).toBe('460000000000000009000000')
  })

  it('PAC 读取瞬时失败时不能把未知路径当作无代理直连', async () => {
    const h = harness({ reuseDirect: true, proxyReadFailsOnce: true, existingWininet: {
      ProxyEnable: { type: 'REG_DWORD', data: '0' },
      AutoConfigURL: { type: 'REG_SZ', data: 'http://127.0.0.1:7890/proxy.pac' }
    } })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('直连探测期间新启用 PAC 时不能把探测结果当作客户路径或直接落入本地建链', async () => {
    const h = harness({ reuseDirect: true, pacAppearsDuringProbe: true, existingWininet: {
      ProxyEnable: { type: 'REG_DWORD', data: '0' }
    } })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
  })

  it('直连探测期间 TUN/默认路由身份变化时，迟到绿灯不能宣布复用或本地建链', async () => {
    const h = harness({ reuseDirect: true, pathChangesDuringProbe: true })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
  })

  it('默认路径/TUN 身份无法确认时不把 unresolved 当作可复用路径，也不改建本地 connector', async () => {
    const h = harness({ reuseDirect: true, pathIdentityUnavailable: true })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view()).toMatchObject({ state: 'error', code: 'TUNNEL_AVAILABILITY_OBJECT_IDENTITY_MISSING' })
  })

  it('适配器尚无默认路径读取能力时不复用直连，但仍以快照和租约接管', async () => {
    const h = harness({ reuseDirect: true, pathIdentityUnsupported: true })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(0)
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view()).toMatchObject({ state: 'connected' })
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('直连探测期间新启用可用的第三方代理时仍复用它，不抢设置', async () => {
    const h = harness({ reuseDirect: true, manualProxyAppearsDuringProbe: true, existingWininet: {
      ProxyEnable: { type: 'REG_DWORD', data: '0' }
    } })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.counters.proxyProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.view().reusedProxy).toMatchObject({ kind: 'http' })
    expect(h.registry()).toMatchObject({
      ProxyEnable: { data: '1' }, ProxyServer: { data: '127.0.0.1:7890' }
    })
  })

  it('新代理复用时校验路径出错不应被吞掉并转为接管', async () => {
    const h = harness({ reuseDirect: true, manualProxyAppearsDuringProbe: true, proxyValidationThrows: true,
      existingWininet: { ProxyEnable: { type: 'REG_DWORD', data: '0' } } })
    await h.daemon.run()
    expect(h.counters.proxyProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.registry()).toMatchObject({
      ProxyEnable: { data: '1' }, ProxyServer: { data: '127.0.0.1:7890' }
    })
  })

  it('直连形态的说法里 ⛔ 出现 undefined（它没有 host/port,⛔ 套代理那句模板）', async () => {
    const h = harness({ reuseDirect: true })
    await h.daemon.run()
    expect(h.view().message).toContain('这台电脑本来就能直接访问')
    expect(h.view().message).not.toContain('undefined')
  })

  it('带开关但到不了 AI:接管建来信连接（误判代价不对称,宁可多接管一次）', async () => {
    const h = harness({ reuseDirect: true, directUsable: () => false })
    await h.daemon.run()
    expect(h.counters.directProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('探测本身出错也当作不能直连,⛔ 把异常当成「他能用」', async () => {
    const h = harness({ reuseDirect: true, directThrows: true })
    await h.daemon.run()
    expect(h.counters.connectorStarts).toBe(1)
    expect(h.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('复用直连后那条路断了:确认轮之后改建来信连接,⛔ 一次抖动就拆', async () => {
    let usable = true
    const h = harness({ reuseDirect: true, directUsable: () => usable })
    await h.daemon.run()
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')

    // 客户的 VPN 关了 / 人回国了
    usable = false
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    // 第一轮探不通只进「正在复查」，⛔ 当场拆掉
    expect(h.view().state).toBe('degraded')
    expect(h.counters.connectorStarts).toBe(0)

    // 确认轮仍不通 → 改建来信连接
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.connectorStarts).toBe(1)
  })

  it('复用直连周期复验重读当前代理与路径；未变化时仍保留直连复用', async () => {
    const h = harness({ reuseDirect: true })
    await h.daemon.run()
    const before = h.counters.connectorStarts
    // 复验一轮：直连仍通 → 继续复用（若走了「读当前代理设置」那条路，会判成已关闭并当场改建）
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.counters.connectorStarts).toBe(before)
    expect(h.counters.directProbes).toBe(2)
    expect(h.counters.proxyReads).toBeGreaterThan(2)
  })

  it('直连复验和多次连接意图切换后不保留终态可用性操作', async () => {
    const h = harness({ reuseDirect: true })
    const operations = (h.daemon as unknown as { availability: { operations: Map<string, unknown> } }).availability.operations
    await h.daemon.run()
    expect(operations.size).toBe(0)
    for (let round = 0; round < 12; round += 1) {
      clock.advance(30_000)
      await flushMicrotasks(); await flushMicrotasks()
      expect(operations.size).toBe(0)
    }
    for (let round = 0; round < 12; round += 1) {
      writeIntentFile(dataDir, {
        desired: 'connected', sessionToken: `direct-switch-${String(round)}`, bridgePort: 18080, reuseDirect: true,
        connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.6' }
      })
      clock.advance(100)
      await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
      expect(h.view().state).toBe('connected')
      expect(operations.size).toBe(0)
    }
    h.daemon.requestShutdown()
  })

  it('直连复用后的周期探测若出现 PAC，必须重新裁决而不沿用旧绿灯', async () => {
    const pac = harness({ reuseDirect: true, pacAppearsDuringReverify: true, existingWininet: {
      ProxyEnable: { type: 'REG_DWORD', data: '0' }
    } })
    await pac.daemon.run()
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(pac.counters.connectorStarts).toBe(1)
    expect(pac.view().code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('直连复用后的周期探测若路径/TUN 变化，必须重新取证而不沿用旧绿灯', async () => {
    const tun = harness({ reuseDirect: true, pathChangesDuringReverify: true })
    await tun.daemon.run()
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(tun.counters.directProbes).toBe(3)
    expect(tun.counters.connectorStarts).toBe(0)
    expect(tun.view().code).toBe('TUNNEL_REUSED_EXISTING')
  })

  it('直连复用后的周期探测若出现可用 HTTP 代理，重新取证后改为复用该代理而不接管', async () => {
    const h = harness({ reuseDirect: true, manualProxyAppearsDuringReverify: true, existingWininet: {
      ProxyEnable: { type: 'REG_DWORD', data: '0' }
    } })
    await h.daemon.run()
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.counters.proxyProbes).toBe(1)
    expect(h.counters.connectorStarts).toBe(0)
    expect(h.view().reusedProxy).toMatchObject({ kind: 'http' })
  })
})
