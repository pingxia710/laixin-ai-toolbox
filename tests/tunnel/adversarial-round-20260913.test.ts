// 09-13 对抗检测轮(创始人:「你要是担心这些就再去检测一轮」):在本机能造出来的故障里,挑客户现场最可能撞上、
// 而现有用例没钉住的两种——
// ① Windows 上通知通道(PowerShell/原生)整个坏掉:设置已经写进系统,连接必须照样成功,通知记欠账稍后补;
// ② 客户电脑上另一款代理软件也在守它自己的系统代理:两边互相改回不能无限打架,更不能因此停网。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { notifyOwed } from '../../sidecar/win/restore.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('对抗检测轮 · 通知通道坏掉 / 另一款代理软件争抢', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-adversarial-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function harness(overrides: { broadcast?: () => void; verifyIntervalMs?: number } = {}) {
    const store = `${dataDir}/registry.json`
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const state = { broadcasts: 0, broadcastFails: false }
    const adapter = { ...base, reapplyOnChange: () => true,
      broadcastSettingsChanged: () => { state.broadcasts += 1; if (state.broadcastFails) throw new Error('powershell unavailable'); overrides.broadcast?.() } }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'adv', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.3' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: overrides.verifyIntervalMs ?? 30_000,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.3' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string }
    const registry = () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, { type: string; data: string }>
    const write = (item: string, data: string) => base.write({ service: 'WinINET', item }, { type: item === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', data })
    return { daemon, state, view, registry, write }
  }

  it('通知通道整个坏掉:连接照样成功(设置已写进系统),通知记欠账,通道修好后 5 秒补发并销账', async () => {
    const h = harness()
    h.state.broadcastFails = true
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.registry().ProxyEnable?.data).toBe('1')
    expect(notifyOwed(dataDir)).toBe(true)
    h.state.broadcastFails = false
    const before = h.state.broadcasts
    clock.advance(5_000); await flushMicrotasks()
    expect(h.state.broadcasts).toBe(before + 1)
    expect(notifyOwed(dataDir)).toBe(false)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('另一款代理软件反复改系统代理:按本意图有界夺回，到顶后保留对方现值并不再写入', async () => {
    const h = harness({ verifyIntervalMs: 30_000 })
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    const ledgerBefore = loadLedger(dataDir).filter((entry) => entry.kind === 'setting').length
    // 第一次被改:改回来,通道照常连着,状态里带一句提示
    h.write('ProxyServer', 'other.proxy:7881')
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    expect(h.view().state).toBe('connected')
    expect(h.view().code).toBe('TUNNEL_SETTINGS_CONTESTED')
    expect(h.view().message).toContain('另一款代理软件')
    // 第二、三次都仍有当前对象、租约和目标实测，允许受控夺回；旧的“第二次即停”不能复活。
    h.write('ProxyServer', 'other.proxy:7892')
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.write('ProxyServer', 'other.proxy:7893')
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    // 第四次超过本意图上限：不再抢写，并以受控限制码说明原因。
    h.write('ProxyServer', 'other.proxy:7894')
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7894')
    expect(h.view().state).toBe('error')
    expect(h.view().code).toBe('TUNNEL_AVAILABILITY_RECLAIM_LIMIT')
    // 账本:本会话这一项仍只多一条,原值跟着对方最后写的值走
    const repairEntries = loadLedger(dataDir).filter((entry) => entry.kind === 'setting')
    expect(repairEntries.length).toBe(ledgerBefore + 1)
    expect((repairEntries.at(-1) as { originalValue: { data: string } }).originalValue.data).toBe('other.proxy:7894')
    // 到顶后不再定时抢回；新意图或新的路径证据才会重新裁决。
    clock.advance(6 * 60_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7894')
    expect(h.view().state).toBe('error')
    // 退出时按所有权还原:还给对方**最后**写的那个值,⛔ 把人家的设置清掉
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7894')
  })
})
