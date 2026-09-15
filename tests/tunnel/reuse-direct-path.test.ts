// 「客户这台电脑本来就能到 AI 服务就用它、不改他的设置」（GPT-6 4.3① / 创始人「复用不抢」）。
//
// 这条上一任接过线又撤了：判据拿的是通用探测点，在能上外网的机器上 122 条用例集体走进复用分支。
// 所以本轮两条边界必须有用例钉住：**判据是 AI 服务不是通用探测点**、**不带开关就一次都不探**。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { AI_SERVICE_PROBE_URLS } from '../../sidecar/win/vless-connector.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('本来就能直连 AI 就复用', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-reuse-direct-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(options: { reuseDirect?: boolean; directUsable?: () => boolean; directThrows?: boolean }) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const counters = { directProbes: 0, connectorStarts: 0 }
    // 客户没设任何代理——直连分支的前提
    const adapter = { ...base, existingProxy: () => undefined }
    writeIntentFile(dataDir, {
      desired: 'connected', sessionToken: 'direct', bridgePort: 18080,
      ...(options.reuseDirect === undefined ? {} : { reuseDirect: options.reuseDirect }),
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.6' }
    })
    const daemon = createDaemon({
      dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      probeProxy: async () => undefined,
      probeDirect: async () => {
        counters.directProbes += 1
        if (options.directThrows === true) throw new Error('探测本身炸了')
        if (!(options.directUsable ?? (() => true))()) throw new Error('到不了 AI 服务')
        return { direct: true }
      },
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { counters.connectorStarts += 1 }, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.6' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
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

  it('复用直连期间 ⛔ 去读代理设置判「已关闭」——直连本来就没有代理设置可读', async () => {
    const h = harness({ reuseDirect: true })
    await h.daemon.run()
    const before = h.counters.connectorStarts
    // 复验一轮：直连仍通 → 继续复用（若走了「读当前代理设置」那条路，会判成已关闭并当场改建）
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.view().code).toBe('TUNNEL_REUSED_EXISTING')
    expect(h.counters.connectorStarts).toBe(before)
    expect(h.counters.directProbes).toBe(2)
  })
})
