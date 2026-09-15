// 系统代理写入权(创始人 2026-09-15 三条硬线)的行为覆盖。
//
// 这三组是审查点名要补的:
//  ① 跨数据目录的恢复不得越权写 —— 恢复也是写系统代理,不能只给 applySettings 加闸;
//  ② WAIT_ABANDONED 之后恢复失败不得接管 —— 前一会话的设置还没还干净,继续写就是往上盖;
//  ③ 停止并恢复之后必须交还写入权 —— 否则另一份安装会一直被误挡成「有人正在管理网络」。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { appendSettingEntry, loadLedger } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

/** 假的会话级互斥体:同一时刻只有一个持有者,跨「数据目录」共享——真实语义就是这样。 */
function sharedWriteRight() {
  let holder: string | undefined
  let abandonNext = false
  return {
    holder: () => holder,
    abandonNextAcquire: () => { abandonNext = true },
    seize: (who: string) => { holder = who },
    issue: (who: string) => () => {
      if (holder !== undefined && holder !== who) return { acquired: false as const, reason: 'held' as const }
      holder = who
      const abandoned = abandonNext
      abandonNext = false
      return { acquired: true as const, abandoned, release: () => { if (holder === who) holder = undefined } }
    }
  }
}

describe('系统代理写入权', () => {
  let dirA: string
  let dirB: string
  let clock: FakeClock
  beforeEach(() => { dirA = makeTempDir('wr-a-'); dirB = makeTempDir('wr-b-'); clock = new FakeClock() })
  afterEach(() => { removeTempDir(dirA); removeTempDir(dirB) })

  function build(dataDir: string, right: () => unknown, store: string, overrides: Record<string, unknown> = {}) {
    const base = createAdapter({ FAKE_WININET_STORE: store })
    const adapter = { ...base, acquireWriteRight: right, ...overrides }
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: `s-${dataDir}`, bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' } })
    const daemon = createDaemon({ dataDir, clock, adapter, random: () => 0, parentAlive: () => true, onExit: () => undefined,
      verifyIntervalMs: 30_000,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined }) })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; message: string }
    const registry = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}) as Record<string, { data: string }>
    return { daemon, view, registry, adapter }
  }

  it('① 跨数据目录:权被别人持有时,恢复一个字节都不许写,保持现值并给出可解释状态', async () => {
    const right = sharedWriteRight()
    const store = `${dirB}/registry.json`
    const seed = createAdapter({ FAKE_WININET_STORE: store })
    // 现值必须**正是 B 上次写进去的那个值**,还原才会真的发生写入。
    // ⛔ 随便填一个第三方的值:restoreLedger 会判成「被别人改过」直接跳过写入,
    // 这条用例就永远不会红(撤掉写入权检查也照样绿)。
    seed.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
    // 另一份安装(不同数据目录)已经拿着写入权。
    right.seize('installation-A')
    // B 的账本里留着上次没结算的设置项 → run() 会走启动恢复这条路径,并且会想写回 7890。
    appendSettingEntry(dirB, { service: 'WinINET', item: 'ProxyServer',
      originalValue: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'stale', time: 1 })

    const b = build(dirB, right.issue('installation-B'), store)
    await b.daemon.run()
    await flushMicrotasks()

    // 恢复没有发生:现值原样停着,⛔ 被 B 按自己的账本越权写回 7890——
    // 系统代理此刻归持权的那一份管,B 一个字节都不许动。
    expect(b.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    // 状态说得出原因,⛔ 沉默,也 ⛔ 谎称已连接。
    expect(b.view().state).toBe('error')
    expect(b.view().code).toBe('TUNNEL_WRITE_RIGHT_HELD')
    expect(right.holder()).toBe('installation-A')
    b.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('② WAIT_ABANDONED 后恢复失败:拒绝接管、⛔ 写新设置,并交还写入权', async () => {
    const right = sharedWriteRight()
    const store = `${dirA}/registry.json`
    const seed = createAdapter({ FAKE_WININET_STORE: store })
    // 前一会话崩在半路的真实现场:系统里**还停在它写的 18080**,账本记着客户原本是 7890。
    // ⛔ 把现值设成原值——那样 restoreLedger 会判定「已经还原过」直接结算,根本走不到写入这一幕。
    seed.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
    appendSettingEntry(dirA, { service: 'WinINET', item: 'ProxyServer',
      originalValue: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'crashed', time: 1 })
    right.abandonNextAcquire()
    // 让还原写不进去 → restoreSettings 返回 undefined(未恢复项)。
    const a = build(dirA, right.issue('installation-A'), store, {
      write: () => { throw new Error('registry locked') }
    })
    await a.daemon.run()
    await flushMicrotasks()

    // 还原写不进去,设置只能停在前任留下的值上——这是事实,⛔ 假装还干净了。
    expect(a.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    // 关键:**没有接管**。没有新的 applied 账目产生(接管会为每一项记一条新账)。
    expect(loadLedger(dirA).filter((entry) => entry.kind === 'setting' && entry.sessionToken !== 'crashed')).toHaveLength(0)
    // 恢复状态必须明确保留,⛔ 滑到「上游不可达」这类与真因无关的码。
    expect(a.view().state).toBe('error')
    expect(a.view().code).toBe('TUNNEL_RESTORE_INCOMPLETE')
    // 权已交还:⛔ 攥着一把自己都没法用的锁把别人挡在外面。
    expect(right.holder()).toBeUndefined()
    a.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('④ 启动恢复失败后守护不能失聪:客户再点连接,必须真的被处理', async () => {
    // 这一条盯的是上一轮修复引入的回归:run() 在恢复失败时提前 return,意图轮询还没装,
    // 而外层 keepalive 让进程继续活着、监管器认为守护在跑 —— 客户点「重新连接」只改了
    // intent 文件,守护永远不会读它,界面卡在「连接中」,只能退出重开工具箱。
    const store = `${dirA}/registry.json`
    const seed = createAdapter({ FAKE_WININET_STORE: store })
    seed.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
    appendSettingEntry(dirA, { service: 'WinINET', item: 'ProxyServer',
      originalValue: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'stale', time: 1 })

    // 启动这一刻权被别人拿着 → 启动恢复必然失败。
    const right = sharedWriteRight()
    right.seize('installation-other')
    const a = build(dirA, right.issue('installation-A'), store)
    await a.daemon.run()
    await flushMicrotasks()
    expect(a.view().state).toBe('error')
    expect(a.view().code).toBe('TUNNEL_WRITE_RIGHT_HELD')

    // 对方退出了,权空出来;客户在界面上点「重新连接」——写入一份新的连接意图。
    right.seize(undefined as unknown as string)
    writeIntentFile(dirA, { desired: 'connected', sessionToken: 'retry-by-customer', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' } })
    clock.advance(5_000); await flushMicrotasks(); await flushMicrotasks(); await flushMicrotasks()

    // 守护必须真的读到并处理了它 —— ⛔ 停在错误态等客户去重开工具箱。
    expect(a.view().state).toBe('connected')
    expect(right.holder()).toBe('installation-A')
    a.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('③ 停止并恢复之后交还写入权:第二个实例随即能取得', async () => {
    const right = sharedWriteRight()
    const store = `${dirA}/registry.json`
    const a = build(dirA, right.issue('installation-A'), store)
    await a.daemon.run()
    await flushMicrotasks()
    expect(a.view().state).toBe('connected')
    expect(right.holder()).toBe('installation-A')

    // 客户主动断开 → 还原干净 → 必须交还写入权(⛔ 只在让路或进程退出时才释放)。
    writeIntentFile(dirA, { desired: 'user-disconnected' })
    clock.advance(5_000); await flushMicrotasks(); await flushMicrotasks()
    expect(a.view().state).toBe('stopped-restored')
    expect(right.holder()).toBeUndefined()

    // 正向证据:另一份安装现在真的拿得到 —— ⛔ 只断言「holder 为空」,那在什么都没做时也成立。
    const second = right.issue('installation-B')()
    expect(second.acquired).toBe(true)
    a.daemon.requestShutdown(); await flushMicrotasks()
  })
})
