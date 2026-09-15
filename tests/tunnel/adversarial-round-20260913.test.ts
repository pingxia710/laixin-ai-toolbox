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

  it('另一款代理软件反复改系统代理:第一次改回、第二次止损并保留对方现值,账本只多一条、退出还它最后写的值', async () => {
    // 2026-09-15 创始人定「两次连续被改即止损」,撤销原「每次都改回(硬标准 ⛔ 放弃)」。
    // 止损的是**跟别人抢系统代理**这个动作,不是连接努力本身:保留对方现值 + 稳定报冲突 + 等客户显式重新接管。
    // 本用例仍然盯住两条没变的意图:账本这一项只多一条;原值跟着对方**最后**写的值走(GPT-6 补核 R6)。
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
    // 第二次又被改:止损。⛔ 写回、⛔ 继续「已改回 N 次」数下去
    h.write('ProxyServer', 'other.proxy:7892')
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7892')
    // 止损后要稳定停在冲突态(正向证据:⛔ 只断言「没再改回」——那条在什么都不做时也成立)
    expect(h.view().state).toBe('error')
    expect(h.view().code).toBe('TUNNEL_SETTINGS_CONTEST_STOPPED')
    // 再放两轮:对方继续改,我们一次都不再写回(这才是「不再循环」)
    for (const port of [7893, 7894]) {
      h.write('ProxyServer', `other.proxy:${String(port)}`)
      clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
      expect(h.registry().ProxyServer?.data).toBe(`other.proxy:${String(port)}`)
    }
    // 账本:本会话这一项仍只多一条,原值跟着对方最后写的值走
    const repairEntries = loadLedger(dataDir).filter((entry) => entry.kind === 'setting')
    expect(repairEntries.length).toBe(ledgerBefore + 1)
    expect((repairEntries.at(-1) as { originalValue: { data: string } }).originalValue.data).toBe('other.proxy:7892')
    // ⛔ 自动恢复(创始人 2026-09-15 定:进入冲突态后不再定时探测、不自己抢回,只给明确的「重试连接」)。
    // 对方停手很久也不许自己爬回来——自动恢复正是这次反复横跳的放大器。
    clock.advance(6 * 60_000); await flushMicrotasks(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7894')
    expect(h.view().state).toBe('error')
    // 退出时按所有权还原:还给对方**最后**写的那个值,⛔ 把人家的设置清掉
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.registry().ProxyServer?.data).toBe('other.proxy:7894')
  })
})
