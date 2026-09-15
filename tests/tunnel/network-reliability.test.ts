import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { createDaemon as macDaemon, startPowerEvents as macStartPowerEvents } from '../../sidecar/mac/daemon-core.mjs'
import { createDaemon as winDaemon, startPowerEvents as winStartPowerEvents } from '../../sidecar/win/daemon-core.mjs'
import * as macLedger from '../../sidecar/mac/ledger.mjs'
import * as winLedger from '../../sidecar/win/ledger.mjs'
import { restoreLedger as macRestore } from '../../sidecar/mac/restore.mjs'
import { restoreLedger as winRestore } from '../../sidecar/win/restore.mjs'
import { ConnectorError, CONTROL_CODES } from '../../sidecar/mac/connectors.mjs'
import { DaemonSupervisor } from '../../app/main/tunnel/supervisor'
import { FakeClock, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, writeIntentFile } from './helpers'

const dirs: string[] = []
function temp() { const dir = makeTempDir('network-reliability-'); dirs.push(dir); return dir }
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

describe.each([
  ['macOS', macDaemon, macLedger, macRestore, macStartPowerEvents],
  ['Windows', winDaemon, winLedger, winRestore, winStartPowerEvents]
] as const)('%s 网络故障回归', (_platform, createDaemon, ledger, restore, startPowerEvents) => {
  function harness() {
    const dir = temp()
    const clock = new FakeClock()
    let value: unknown = null
    let unavailable = false
    let restoreFails = false
    let writeIgnored = false
    let activeStreams = 0
    let lost: (error: ConnectorError) => void = () => {}
    const starts = vi.fn(async () => { if (unavailable) throw new Error('offline') })
    const stop = vi.fn(async () => {})
    const adapter = {
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }],
      read: () => value,
      write: (_ref: unknown, next: unknown) => {
        if (next === null && restoreFails) throw new Error('permission denied')
        if (!writeIgnored) value = next
      }
    }
    const intent = { desired: 'connected', sessionToken: 'first', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
    writeIntentFile(dir, intent)
    const exit = vi.fn()
    const daemon = createDaemon({ random: () => 0, dataDir: dir, clock, adapter, parentAlive: () => true, onExit: exit,
      connectorFactory: () => ({ kind: 'loopback-probe', start: starts, stop, localProxyPort: () => 1,
        onLost: (callback) => { lost = callback }, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => {}, close: async () => {},
        traffic: () => ({ uploadBytes: 0, downloadBytes: 0, activeStreams, observedAt: 1 }) }) })
    return { dir, clock, daemon, starts, exit, adapter, intent,
      setActiveStreams: (next: number) => { activeStreams = next },
      traffic: () => readJsonFile<{ interruptedStreams: number; activeStreams: number }>(`${dir}/traffic.json`),
      trafficFileExists: () => existsSync(`${dir}/traffic.json`),
      state: () => readJsonFile<{ state: string; code: string }>(`${dir}/state.json`),
      value: () => value, offline: (next: boolean) => { unavailable = next },
      failRestore: (next: boolean) => { restoreFails = next }, ignoreWrite: () => { writeIgnored = true },
      lose: () => lost(new ConnectorError(CONTROL_CODES.upstreamUnreachable, 'offline')) }
  }

  it('五次自动重试用尽后，新连接请求能成功；同一请求不重复启动', async () => {
    const h = harness()
    h.offline(true)
    await h.daemon.run()
    for (const delay of [2000, 4000, 8000, 16000, 32000]) { h.clock.advance(delay); await flushMicrotasks() }
    expect(h.starts).toHaveBeenCalledTimes(6)
    h.offline(false)
    writeIntentFile(h.dir, { ...h.intent, sessionToken: 'retry' })
    h.clock.advance(500); await flushMicrotasks()
    expect(h.state().state).toBe('connected')
    expect(h.starts).toHaveBeenCalledTimes(7)
    h.clock.advance(500); await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(7)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('恢复失败显示错误；再次断开能重试恢复且不覆盖原值', async () => {
    const h = harness()
    await h.daemon.run()
    h.failRestore(true)
    writeIntentFile(h.dir, { desired: 'user-disconnected', sessionToken: 'stop-1' })
    h.clock.advance(500); await flushMicrotasks()
    expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE' })
    expect(h.value()).toBe(true)
    h.failRestore(false)
    writeIntentFile(h.dir, { desired: 'user-disconnected', sessionToken: 'stop-2' })
    h.clock.advance(500); await flushMicrotasks()
    expect(h.state().state).toBe('stopped-restored')
    expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('写入静默不生效:不能显示已连;按硬标准继续重试(⛔ 致命停),始终不假装已连', async () => {
    const h = harness()
    h.ignoreWrite()
    await h.daemon.run()
    expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_SETTINGS_NOT_APPLIED' })
    h.clock.advance(60000); await flushMicrotasks()
    // 客户点了连接就要连上(创始人 09-13 晚硬标准):设置写不进去也按退避继续试,而不是停下来等人
    expect(h.starts.mock.calls.length).toBeGreaterThan(1)
    expect(h.state().state).not.toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('恢复写入后仍为旧值必须保留失败账目', () => {
    const dir = temp()
    ledger.appendSettingEntry(dir, { service: 'test', item: 'proxy', originalValue: null, writtenValue: true, sessionToken: 'x', time: 1 })
    const result = restore(dir, { read: () => true, write: () => {} })
    expect(result.failed).toHaveLength(1)
    expect(ledger.loadLedger(dir)[0]).toMatchObject({ status: 'restore-failed' })
  })

  it('注册表 DWORD 的十进制和十六进制相同值可恢复', () => {
    const dir = temp()
    ledger.appendSettingEntry(dir, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0x0' },
      writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'x', time: 1 })
    let value = { type: 'REG_DWORD', data: '0x1' }
    expect(restore(dir, { read: () => value, write: (_ref, next) => { value = next as typeof value } }).restored).toHaveLength(1)
    expect(value.data).toBe('0x0')
  })

  it('非法账本持久拒绝，重启不能把它当作空账本', () => {
    const dir = temp()
    writeFileSync(`${dir}/ledger.json`, '[{}]')
    expect(() => ledger.loadLedger(dir)).toThrow()
    expect(() => ledger.loadLedger(dir)).toThrow()
  })

  it('换网能恢复耗尽的重试；重复事件合并，主动断开后不拉起', async () => {
    const h = harness()
    h.offline(true)
    await h.daemon.run()
    for (const delay of [2000, 4000, 8000, 16000, 32000]) { h.clock.advance(delay); await flushMicrotasks() }
    h.offline(false)
    h.daemon.notifyEvent('network-change')
    h.daemon.notifyEvent('wake')
    await flushMicrotasks()
    expect(h.state().state).toBe('connected')
    expect(h.starts).toHaveBeenCalledTimes(7)
    writeIntentFile(h.dir, { desired: 'user-disconnected' })
    h.clock.advance(500); await flushMicrotasks()
    h.daemon.notifyEvent('wake'); h.daemon.notifyEvent('network-change')
    h.clock.advance(60000); await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(7)
    expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('关闭可打断未完成的连接，迟到的成功不能重新写系统设置', async () => {
    const h = harness()
    let finish!: () => void
    h.starts.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const running = h.daemon.run()
    await flushMicrotasks()
    h.daemon.requestShutdown()
    await flushMicrotasks()
    finish()
    await running
    expect(h.value()).toBeNull()
    expect(h.state().state).toBe('stopped-restored')
    expect(h.exit).toHaveBeenCalledOnce()
  })

  // D2(0.4.9 网络组):换网、休眠后的恢复四场景。断线自动重连本来就有,这里补的是
  // 「什么时候该拉起、什么时候别拉起」——抖动期间反复拉起会把客户的网反复切断。
  it('D2 场景一 · Wi-Fi 切热点:新网络就绪的那条网卡变化立即恢复,⛔ 干等退避', async () => {
    const h = harness()
    await h.daemon.run()
    expect(h.state().state).toBe('connected')
    h.offline(true)
    h.lose(); await flushMicrotasks()
    expect(h.state().state).toBe('error')
    const baseline = h.starts.mock.calls.length

    h.offline(false)
    h.daemon.notifyEvent('network-change') // 热点已连上
    await flushMicrotasks()

    expect(h.starts).toHaveBeenCalledTimes(baseline + 1)
    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D2 场景二 · 合盖唤醒:唤醒是一次性事件,始终立即恢复(⛔ 被抖动闸挡住)', async () => {
    const h = harness()
    await h.daemon.run()
    h.offline(true)
    h.lose(); await flushMicrotasks()
    const baseline = h.starts.mock.calls.length

    // 先来一条网络变化占掉抖动窗口,再来唤醒:唤醒不受窗口限制
    h.daemon.notifyEvent('network-change')
    await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(baseline + 1)
    h.offline(false)
    h.daemon.notifyEvent('wake')
    await flushMicrotasks()

    expect(h.starts).toHaveBeenCalledTimes(baseline + 2)
    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D2 场景三 · 短暂离线(<30 秒)没有任何事件也自愈:常规退避把它捞回来', async () => {
    const h = harness()
    await h.daemon.run()
    h.offline(true)
    h.lose(); await flushMicrotasks()

    h.clock.advance(2_000); await flushMicrotasks() // 第 1 次退避,仍离线
    h.clock.advance(4_000); await flushMicrotasks() // 第 2 次退避,仍离线
    expect(h.state().state).toBe('error')
    h.offline(false)                                 // 网络在第 6 秒回来
    h.clock.advance(8_000); await flushMicrotasks()  // 第 3 次退避:14 秒,远小于 30 秒

    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D2 场景四 · 网络抖动:一串网卡变化只放行一次立即恢复,退避照常增长(⛔ 反复拉起)', async () => {
    const h = harness()
    await h.daemon.run()
    h.offline(true)
    h.lose(); await flushMicrotasks()
    const baseline = h.starts.mock.calls.length

    h.daemon.notifyEvent('network-change') // 第 1 条:放行,立即试一次(仍离线,失败)
    await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(baseline + 1)

    // 抖动:此后 9 秒内每秒一条。抑制期内一条都不该各拉一次——
    // 这 9 秒里只该有常规退避的那一次(事件后退避重排为 4 秒,下一档 8 秒落在窗口外)。
    // 改前:9 条事件各清一次退避、各拉一次 ⇒ baseline+10。
    for (let index = 0; index < 9; index += 1) {
      h.clock.advance(1_000)
      h.daemon.notifyEvent('network-change')
      await flushMicrotasks()
    }
    expect(h.starts).toHaveBeenCalledTimes(baseline + 2)

    // 抖动停了:静默 10 秒(期间无事件,网络仍没回来)让抑制窗口过去,
    // 此后的第一条变化重新算「网络稳定后的新证据」,立即恢复照旧生效。
    h.clock.advance(10_000); await flushMicrotasks()
    const beforeStable = h.starts.mock.calls.length
    h.offline(false)
    h.daemon.notifyEvent('network-change')
    await flushMicrotasks()

    expect(h.starts.mock.calls.length).toBeGreaterThan(beforeStable)
    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  // 上线检查 §4-4:事件源此前只在 darwin 创建(tunnel-daemon.mjs),sidecar/win/power-events.mjs
  // 在生产入口从未被创建过 ⇒ **Windows 的抖动闸根本没有输入**,换网只能靠退避与 30 秒复验。
  it('D2 · 事件源 mac 与 Windows 都要创建,发出的网卡变化要真进抖动闸', async () => {
    const h = harness()
    await h.daemon.run()
    h.offline(true)
    h.lose(); await flushMicrotasks()
    const baseline = h.starts.mock.calls.length

    // 只验「哪个平台会创建它、它发的事件走不走进闸」,真实事件源换成可驱动的桩
    let emit: ((event: string) => void) | undefined
    const create = vi.fn((options: { emit?: (event: string) => void }) => { emit = options.emit; return { stop: () => undefined } })

    for (const platform of ['linux', 'freebsd', 'android'] as const) {
      expect(startPowerEvents({ platform, emit: () => undefined, create }).stop).toBeTypeOf('function')
    }
    expect(create).not.toHaveBeenCalled() // 只有两个桌面平台有事件源

    for (const platform of ['darwin', 'win32'] as const) {
      const source = startPowerEvents({ platform, emit: (event: string) => h.daemon.notifyEvent(event), create })
      expect(create).toHaveBeenCalled()
      source.stop()
    }
    expect(create).toHaveBeenCalledTimes(2)

    // Windows 那一次发出的 network-change 要真走进闸:第一条放行、立即试一次
    emit!('network-change')
    await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(baseline + 1)

    // 抖动窗口内的后续事件被闸挡住,⛔ 每条各拉一次
    h.clock.advance(1_000)
    emit!('network-change')
    await flushMicrotasks()
    expect(h.starts).toHaveBeenCalledTimes(baseline + 1)

    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  // 上面那条验的是「这支函数按平台怎么走」;这条卡的是**生产入口真的用了它**——
  // 原来的写法是 `process.platform === 'darwin' ? createPowerEventSource(...) : { stop }`,
  // 两个平台目录的 tunnel-daemon.mjs 是同一份共享源的副本,少一边就不可能只修好一边。
  it('D2 · 守护入口按这支创建事件源,⛔ 退回「只在 darwin 建」的写法', () => {
    const entry = readFileSync(fileURLToPath(new URL(`../../sidecar/${_platform === 'macOS' ? 'mac' : 'win'}/tunnel-daemon.mjs`, import.meta.url)), 'utf8')
    expect(entry).toContain('startPowerEvents({')
    expect(entry).not.toMatch(/process\.platform === 'darwin'/)
  })

  it('D2 · 用户主动断开始终优先:抖动窗口里的事件与其后的稳定事件都 ⛔ 把它拉起来', async () => {
    const h = harness()
    await h.daemon.run()
    h.offline(true)
    h.lose(); await flushMicrotasks()
    h.daemon.notifyEvent('network-change')
    await flushMicrotasks()
    const baseline = h.starts.mock.calls.length

    writeIntentFile(h.dir, { desired: 'user-disconnected' })
    h.clock.advance(500); await flushMicrotasks()
    h.offline(false)
    h.daemon.notifyEvent('network-change') // 抖动窗口内
    h.daemon.notifyEvent('wake')
    h.clock.advance(60_000); await flushMicrotasks()
    h.daemon.notifyEvent('network-change') // 窗口外(网络已稳定)
    h.clock.advance(60_000); await flushMicrotasks()

    expect(h.starts).toHaveBeenCalledTimes(baseline)
    expect(h.value()).toBeNull() // 系统设置已还原且没被重新写回
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  // D3(0.4.9):客户说的「AI 回答到一半断掉」= 通道断的那一刻有连接正在回数据。
  // relay 只看得到本机 xray 怎么收尾,分不出远端是正常结束还是半路截断;
  // 「断的那一刻在途几条」却是守护确定知道的,按这个口径统计。
  it('D3 · 通道中断时在途 3 条正在回数据的连接 → 计 3 条「被打断」,用户自己断开的不计故障', async () => {
    const h = harness()
    await h.daemon.run()
    h.clock.advance(2_000); await flushMicrotasks() // 让流量 tick 落一次盘
    h.setActiveStreams(3)

    h.lose(); await flushMicrotasks() // 通道断了

    expect(h.traffic().interruptedStreams).toBe(3)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D3 · 用户主动断开时在途 2 条 → ⛔ 记成故障(那不是故障)', async () => {
    const h = harness()
    await h.daemon.run()
    h.clock.advance(2_000); await flushMicrotasks()
    h.setActiveStreams(2)
    expect(h.traffic().interruptedStreams).toBe(0)

    writeIntentFile(h.dir, { desired: 'user-disconnected', sessionToken: 'stop' })
    h.clock.advance(500); await flushMicrotasks()

    expect(h.state().state).toBe('stopped-restored')
    expect(h.trafficFileExists()).toBe(false) // 断开后不再展示流量(既有行为)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D3 · 断开时没有连接在回数据 → 两个计数都不动(⛔ 凭空记一笔故障)', async () => {
    const h = harness()
    await h.daemon.run()
    h.clock.advance(2_000); await flushMicrotasks()

    h.lose(); await flushMicrotasks()

    expect(h.traffic().interruptedStreams).toBe(0)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('恢复通知失败:设置已写回就是已恢复,只留痕 ⛔ 记成失败锁死连接(创始人 09-13 真机)', () => {
    const dir = temp()
    ledger.appendSettingEntry(dir, { service: 'test', item: 'proxy', originalValue: null, writtenValue: true, sessionToken: 'x', time: 1 })
    let value: unknown = true
    const notify = vi.fn().mockImplementationOnce(() => { throw new Error('notification failed') }).mockImplementation(() => {})
    const adapter = { read: () => value, write: (_ref: unknown, next: unknown) => { value = next }, broadcastSettingsChanged: notify }
    const first = restore(dir, adapter)
    expect(value).toBeNull()
    expect(first.failed).toHaveLength(0)
    expect(first.restored).toHaveLength(1)
    expect(first.notifyFailed).toBe(true)
    expect(first.restored[0].note).toContain('通知未送达')
    // 没有待恢复项了:连接不再被「原设置尚未恢复」挡住;欠着的通知在下一次恢复时补发,发成即销账
    expect(restore(dir, adapter)).toEqual({ restored: [], keptModified: [], failed: [] })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(restore(dir, adapter)).toEqual({ restored: [], keptModified: [], failed: [] })
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

it('新守护成功前保留旧异常，只有本次运行的连接确认能清除', () => {
  const children: EventEmitter[] = []
  const spawnDaemon = vi.fn(() => { const child = new EventEmitter(); children.push(child); return child })
  const supervisor = new DaemonSupervisor({ dataDir: temp(), spawnDaemon, spawnRestore: () => {} })
  supervisor.ensureRunning()
  children[0].emit('exit', 1)
  supervisor.ensureRunning()
  expect(supervisor.lastUnexpectedExitAt()).toBeDefined()
  // The run id is passed only by the trusted parent, never supplied by the renderer.
  const runId = (spawnDaemon.mock.calls as unknown as string[][])[1][0]
  expect(supervisor.lastUnexpectedExitAt({ state: 'connected', runId: 'old' })).toBeDefined()
  expect(supervisor.lastUnexpectedExitAt({ state: 'connected', runId })).toBeUndefined()
})

it('退出等待真正的守护结束；磁盘上的旧已连状态不能充当本次连接', async () => {
  const child = new EventEmitter()
  const supervisor = new DaemonSupervisor({ dataDir: temp(), spawnDaemon: () => child, spawnRestore: () => {} })
  expect(supervisor.currentState({ state: 'connected', runId: 'previous' })).toBeUndefined()
  supervisor.ensureRunning()
  expect(supervisor.currentState({ state: 'connected', runId: 'previous' })?.state).toBe('connecting')
  let completed = false
  const waiting = supervisor.waitForExit().then(() => { completed = true })
  await flushMicrotasks()
  expect(completed).toBe(false)
  child.emit('exit', 0)
  await waiting
  expect(completed).toBe(true)
})

it.each([false, true])('崩溃后的恢复确认清理旧错误；恢复失败=%s 时仍保留错误', (restoreFails) => {
  const dir = temp()
  const child = new EventEmitter()
  const recovery = new EventEmitter()
  const supervisor = new DaemonSupervisor({ dataDir: dir, spawnDaemon: () => child, spawnRestore: () => recovery })
  supervisor.ensureRunning(); child.emit('exit', 1)
  macLedger.appendSettingEntry(dir, { service: 'test', item: 'proxy', originalValue: null, writtenValue: true, sessionToken: 'x', time: 1 })
  supervisor.recoverOnBoot()
  let value: unknown = true
  macRestore(dir, { read: () => value, write: (_ref, next) => { if (!restoreFails) value = next } })
  writeFileSync(`${dir}/state.json`, JSON.stringify({ state: restoreFails ? 'error' : 'stopped-restored' }))
  recovery.emit('exit', restoreFails ? 65 : 0)
  expect(supervisor.lastUnexpectedExitAt() !== undefined).toBe(restoreFails)
})
