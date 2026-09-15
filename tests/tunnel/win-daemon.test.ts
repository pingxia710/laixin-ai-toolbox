// Windows 守护闭环(逻辑层):sidecar/win/daemon-core + 假 WinINET 适配器 + 回环假上游。
// 判据:原语闭环(起→账本四键→写入→停→逐字恢复)、冲突不覆盖、策略锁拒、半途失败回滚、
// 睡眠唤醒/网络变化 = 新的恢复小节(⛔ 自动拉起用户已断开的通道)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { createDaemon, type DaemonState } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger, type SettingEntry } from '../../sidecar/win/ledger.mjs'
import { ConnectorError, CONTROL_CODES } from '../../sidecar/win/connectors.mjs'
import { createAdapter, type FakeWininetStore } from './fixtures/fake-wininet-adapter.mjs'
import {
  FakeClock,
  flushMicrotasks,
  makeTempDir,
  readFakeOps,
  readJsonFile,
  removeTempDir,
  startFakeUpstream,
  waitFor,
  writeIntentFile,
  type FakeUpstream
} from './helpers'

const EXIT_IP = '203.0.113.7' // TEST-NET-3 文档保留段,假值
const BRIDGE_PORT = 18080

interface Harness {
  readonly dataDir: string
  readonly storePath: string
  readonly clock: FakeClock
  adapter: ReturnType<typeof createAdapter>
  readonly upstream: FakeUpstream
  readonly startCalls: number[]
  verifyCalls: number
  startShouldFail: boolean
  startFailureCode: string
  verifyQueue: Array<() => Promise<{ exitIp: string }>>
  lost: (error: unknown) => void
  exited: number | undefined
}

describe('Windows 守护(WinINET 四键,账本驱动)', () => {
  let dataDir: string
  let storePath: string
  let upstream: FakeUpstream
  let clock: FakeClock

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-win-daemon-')
    storePath = `${dataDir}/fake-wininet.json`
    upstream = await startFakeUpstream()
    clock = new FakeClock()
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function adapter(env: NodeJS.ProcessEnv = {}) {
    return createAdapter({ FAKE_WININET_STORE: storePath, ...env } as NodeJS.ProcessEnv)
  }

  function connectIntent() {
    return {
      desired: 'connected',
      sessionToken: 'test-session',
      bridgePort: BRIDGE_PORT,
      connector: {
        kind: 'loopback-probe',
        host: '127.0.0.1',
        port: upstream.port,
        exitIp: EXIT_IP
      }
    }
  }

  function stateOf(): DaemonState {
    return readJsonFile<DaemonState>(`${dataDir}/state.json`)
  }

  function settingEntries(): SettingEntry[] {
    return loadLedger(dataDir).filter((entry): entry is SettingEntry => entry.kind === 'setting')
  }

  function harness(env: NodeJS.ProcessEnv = {}): Harness {
    return {
      dataDir,
      storePath,
      clock,
      adapter: adapter(env),
      upstream,
      startCalls: [],
      verifyCalls: 0,
      startShouldFail: false,
      startFailureCode: CONTROL_CODES.upstreamUnreachable,
      verifyQueue: [],
      lost: () => undefined,
      exited: undefined
    }
  }

  function connectorFactory(h: Harness) {
    return () => {
      let lostCallback: ((error: ConnectorError) => void) | undefined
      h.lost = (error) => lostCallback?.(error as ConnectorError)
      return {
        kind: 'loopback-probe',
        localProxyPort: () => h.upstream.port,
        onLost: (callback: (error: ConnectorError) => void) => {
          lostCallback = callback
        },
        start: async () => {
          h.startCalls.push(h.clock.now())
          if (h.startShouldFail) {
            throw new ConnectorError(h.startFailureCode as never, '连接器注入的失败')
          }
        },
        stop: async () => {},
        verify: async () => {
          h.verifyCalls += 1
          const gated = h.verifyQueue.shift()
          if (gated !== undefined) {
            return gated()
          }
          return { exitIp: EXIT_IP }
        }
      }
    }
  }

  function spawnDaemon(h: Harness) {
    return createDaemon({ random: () => 0,
      dataDir: h.dataDir,
      clock: h.clock,
      adapter: h.adapter,
      connectorFactory: connectorFactory(h),
      bridgeFactory: () => ({ listen: () => Promise.resolve(), close: () => Promise.resolve() }),
      parentAlive: () => true,
      onExit: (code) => {
        h.exited = code
      },
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 5_000
    })
  }

  it.each(['<LOCAL>;localhost;127.*;', '127.*; localhost;<local>', '<local>;;localhost;127.*;localhost'])('豁免列表等价变化 %s 不停通道、不重复写设置', async (data) => {
    const h = harness(); writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h); await daemon.run()
    h.adapter.write({ service: 'WinINET', item: 'ProxyOverride' }, { type: 'REG_SZ', data })
    for (let cycle = 0; cycle < 10; cycle++) {
      clock.advance(5_000); await flushMicrotasks()
      expect(stateOf().state).toBe('connected')
    }
    expect(h.startCalls).toHaveLength(1)
    expect(settingEntries()).toHaveLength(4)
    daemon.requestShutdown(); await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath)).toEqual({})
  })

  it('连接中系统代理被改写时自动修复接入，不拆通道；退出保留后来设置', async () => {
    const h = harness(); writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h); await daemon.run()
    const later = { type: 'REG_SZ', data: '10.0.0.9:7890' }
    h.adapter.write({ service: 'WinINET', item: 'ProxyServer' }, later)
    clock.advance(5_000); await flushMicrotasks()
    expect(stateOf().state).toBe('connected')
    expect(h.startCalls).toHaveLength(1)
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyServer?.data).toBe(`127.0.0.1:${BRIDGE_PORT}`)
    daemon.requestShutdown(); await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyServer).toEqual(later)
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyEnable).toBeUndefined()
    expect(settingEntries().some((entry) => entry.status === 'preserved')).toBe(true)
  })

  it('退出时发现真实外改能够结束恢复，下次点击连接可重新接入', async () => {
    const h = harness(); writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h); await daemon.run()
    const later = { type: 'REG_SZ', data: 'new.corp.example' }
    h.adapter.write({ service: 'WinINET', item: 'ProxyOverride' }, later)
    daemon.requestShutdown(); await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyOverride).toEqual(later)
    const next = harness(); writeIntentFile(dataDir, connectIntent())
    const restarted = spawnDaemon(next); await restarted.run()
    expect(stateOf().state).toBe('connected')
    restarted.requestShutdown(); await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyOverride).toEqual(later)
  })

  it('系统设置一次读取失败只做复查，恢复读数后继续使用同一通道', async () => {
    const h = harness(); writeIntentFile(dataDir, connectIntent())
    const originalRead = h.adapter.read; let fail = false
    h.adapter = { ...h.adapter, read: (ref) => {
      if (fail) { fail = false; throw new ConnectorError(CONTROL_CODES.settingsTransient, 'temporary read failure') }
      return originalRead(ref)
    } }
    const daemon = spawnDaemon(h); await daemon.run(); fail = true
    clock.advance(5_000); await flushMicrotasks(); expect(stateOf().state).toBe('degraded')
    clock.advance(1_000); await flushMicrotasks(); expect(stateOf().state).toBe('connected')
    expect(h.startCalls).toHaveLength(1)
    daemon.requestShutdown(); await waitFor(() => stateOf().state === 'stopped-restored')
  })

  it('原语闭环:起 → 账本四键 → 写入 → 停 → 逐字恢复原值 → 广播', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    expect(stateOf().exitIp).toBe(EXIT_IP)

    const store = readJsonFile<FakeWininetStore>(storePath)
    expect(store.ProxyEnable).toEqual({ type: 'REG_DWORD', data: '1' })
    expect(store.ProxyServer).toEqual({ type: 'REG_SZ', data: `127.0.0.1:${String(BRIDGE_PORT)}` })
    expect(store.ProxyOverride).toEqual({ type: 'REG_SZ', data: '<local>;localhost;127.*' })
    expect(store.AutoConfigURL).toBeUndefined()
    expect(settingEntries()).toHaveLength(4)
    expect(settingEntries().every((entry) => entry.status === 'applied')).toBe(true)
    expect(readFakeOps(storePath).some((op) => op.op === 'broadcast')).toBe(true)

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(100)
    await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath)).toEqual({})
    expect(settingEntries().every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('流量遥测文件不可替换时仍保持连接', async () => {
    const h = harness()
    let observations = 0
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({ random: () => 0, dataDir, clock, adapter: h.adapter,
      connectorFactory: connectorFactory(h),
      bridgeFactory: () => ({
        listen: () => Promise.resolve(),
        close: () => Promise.resolve(),
        traffic: () => {
          observations += 1
          return { uploadBytes: observations * 10, downloadBytes: observations * 20, observedAt: clock.now() }
        }
      }),
      parentAlive: () => true,
      onExit: (code) => { h.exited = code },
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 5_000
    })
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    rmSync(`${dataDir}/traffic.json`, { force: true })
    mkdirSync(`${dataDir}/traffic.json`)
    expect(() => clock.advance(2_000)).not.toThrow()
    expect(stateOf().state).toBe('connected')
    expect(h.exited).toBeUndefined()
    expect(observations).toBeGreaterThan(1)
    rmSync(`${dataDir}/traffic.json`, { recursive: true, force: true })
    daemon.requestShutdown()
    await waitFor(() => stateOf().state === 'stopped-restored')
  })

  it('ProxyOverride 合并 ⛔ 覆盖:客户原有条目保留,停止后逐字恢复', async () => {
    const h = harness()
    const original = 'corpxy.example; internal.example'
    h.adapter.write({ service: 'WinINET', item: 'ProxyOverride' }, { type: 'REG_SZ', data: original })
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    const store = readJsonFile<FakeWininetStore>(storePath)
    expect(store.ProxyOverride?.data).toBe('corpxy.example;internal.example;<local>;localhost;127.*')

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(100)
    await waitFor(() => stateOf().state === 'stopped-restored')
    const restored = readJsonFile<FakeWininetStore>(storePath)
    expect(restored.ProxyOverride?.data).toBe(original)
    expect(restored.ProxyEnable).toBeUndefined()
    expect(restored.ProxyServer).toBeUndefined()
  })

  it('客户点击连接时使用来信代理，退出后恢复原有代理', async () => {
    const h = harness()
    h.adapter.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '10.0.0.1:8080' })
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyServer?.data).toBe(`127.0.0.1:${BRIDGE_PORT}`)
    daemon.requestShutdown()
    await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath).ProxyServer?.data).toBe('10.0.0.1:8080')
  })

  it('客户点击连接时保存原 PAC，断开后逐字恢复', async () => {
    const h = harness()
    h.adapter.write({ service: 'WinINET', item: 'AutoConfigURL' }, { type: 'REG_SZ', data: 'http://pac.corp.example/wpad.dat' })
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    expect(readJsonFile<FakeWininetStore>(storePath).AutoConfigURL).toBeUndefined()
    daemon.requestShutdown()
    await waitFor(() => stateOf().state === 'stopped-restored')
    expect(readJsonFile<FakeWininetStore>(storePath).AutoConfigURL?.data).toBe('http://pac.corp.example/wpad.dat')
  })

  it('受管理环境:策略锁 → 起前拒绝并显示原因,写调用 = 0', async () => {
    const h = harness({ FAKE_WININET_POLICY: '1' })
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('error')
    expect(stateOf().message).toBe('受管理环境')
    expect(settingEntries()).toHaveLength(0)
    expect(readFakeOps(storePath).some((op) => op.op === 'write')).toBe(false)
  })

  it('半途写失败:已写入项按账本回滚,不留下半套代理设置', async () => {
    const h = harness({
      FAKE_WININET_FAILURES: JSON.stringify({
        write: [{ key: 'ProxyEnable', message: '注册表写入被拒' }]
      })
    })
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    await flushMicrotasks()
    expect(stateOf().state).toBe('error')
    // 写入顺序先 Server 后 Enable:ProxyEnable(第二项)写失败未生效,
    // ProxyServer(第一项)已写入又被账本回滚 → 存储回到空
    const store = readJsonFile<FakeWininetStore>(storePath)
    expect(store.ProxyServer).toBeUndefined()
    expect(store.ProxyEnable).toBeUndefined()
    // ProxyServer 写回并读回；ProxyEnable 从未生效，读数已经等于原值，同样可确认恢复。
    const statuses = settingEntries().map((entry) => entry.status).sort()
    expect(statuses).toEqual(['restored', 'restored'])
  })

  it('睡眠唤醒:快速退避用尽后进入低频恢复,唤醒事件立即重连', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')
    expect(h.startCalls).toHaveLength(1)

    // 睡眠期间网络断:连接丢失 → 5 次退避全部失败 → 低频恢复
    h.startShouldFail = true
    h.lost(new Error('睡眠期间上游不可达'))
    await waitFor(() => stateOf().state === 'error')
    clock.advance(2_000)
    await flushMicrotasks()
    clock.advance(4_000)
    await flushMicrotasks()
    clock.advance(8_000)
    await flushMicrotasks()
    clock.advance(16_000)
    await flushMicrotasks()
    clock.advance(32_000)
    await flushMicrotasks()
    clock.advance(32_000)
    await flushMicrotasks()
    expect(stateOf().message).toBe('连接中断，已先恢复电脑正常上网；正在低频重试')
    expect(h.startCalls).toHaveLength(6) // 首发 1 + 退避 5;第 6 次不出现

    // 唤醒 + 网络已回来:事件开新小节,立即重连(无需再等退避),成功即回到已连
    h.startShouldFail = false
    daemon.notifyEvent('wake')
    await flushMicrotasks()
    await waitFor(() => stateOf().state === 'connected')
    expect(h.startCalls).toHaveLength(7)
    expect(stateOf().exitIp).toBe(EXIT_IP)
  })

  it('睡眠唤醒:退避未用尽时 network-change 同样立即重试;已连则立即复验', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()

    h.startShouldFail = true
    h.lost(new Error('上游不可达'))
    await waitFor(() => stateOf().state === 'error')
    h.startShouldFail = false
    daemon.notifyEvent('network-change')
    await flushMicrotasks()
    await waitFor(() => stateOf().state === 'connected')
    const verifiesAfterReconnect = h.verifyCalls

    // 已连状态收到唤醒:不等 30s 复验 tick,立即复验一次
    daemon.notifyEvent('wake')
    await flushMicrotasks()
    expect(h.verifyCalls).toBe(verifiesAfterReconnect + 1)
    expect(stateOf().state).toBe('connected')
  })

  it('在途恢复未决时合并后续事件:⛔ 并发重连,旧任务的超时失败不得覆盖最终成功(验收 P1#2)', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')

    // 睡眠断网;唤醒启动第一轮重连,复验结果挂起(模拟唤醒后网络慢恢复)
    h.startShouldFail = true
    h.lost(new Error('上游不可达'))
    await waitFor(() => stateOf().state === 'error')
    h.startShouldFail = false
    let release!: (ok: boolean) => void
    h.verifyQueue.push(
      () =>
        new Promise<{ exitIp: string }>((resolve, reject) => {
          release = (ok) => (ok ? resolve({ exitIp: EXIT_IP }) : reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '复验超时')))
        })
    )
    daemon.notifyEvent('wake')
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(2)

    // network-change 到达:在途未决 → 合并,⛔ 第二轮并发
    daemon.notifyEvent('network-change')
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(2)

    // 第一轮复验超时失败(未过期)→ 如实进入退避;退避到期重连成功,状态只由在途任务写
    release(false)
    await waitFor(() => stateOf().message.includes('自动重连中(1/5)'))
    clock.advance(4_000)
    await flushMicrotasks()
    await waitFor(() => stateOf().state === 'connected')
    expect(h.startCalls).toHaveLength(3)
    expect(stateOf().exitIp).toBe(EXIT_IP)
    expect(stateOf().message).toBe('')
  })

  it('重连中致命错误(授权失效)后,唤醒/网络事件 ⛔ 重试;仅意图驱动的新连接清除(验收 P2#3)', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    expect(stateOf().state).toBe('connected')

    // 中断进入退避;第一次退避重连命中连接器致命错误(授权失效)
    h.startShouldFail = true
    h.startFailureCode = CONTROL_CODES.authFailed
    h.lost(new Error('上游不可达'))
    await waitFor(() => stateOf().state === 'error')
    clock.advance(2_000)
    await flushMicrotasks()
    expect(stateOf().message).toBe('授权失效')
    expect(h.startCalls).toHaveLength(2)

    // 时间推进与后续事件都不再发起连接(致命停止记档)
    clock.advance(120_000)
    await flushMicrotasks()
    daemon.notifyEvent('wake')
    daemon.notifyEvent('network-change')
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(2)
    expect(stateOf().message).toBe('授权失效')
    // 致命停止后:时间与事件都推不动任何新的设置写入(在致命前快照)
    const writesAtFatal = readFakeOps(storePath).filter((op) => op.op === 'write').length
    clock.advance(60_000)
    await flushMicrotasks()
    expect(readFakeOps(storePath).filter((op) => op.op === 'write').length).toBe(writesAtFatal)

    // 用户重新连接:意图驱动的新 connect 清除致命停止,恢复正常连接
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(100)
    await waitFor(() => stateOf().state === 'stopped-restored')
    h.startShouldFail = false
    writeIntentFile(dataDir, connectIntent())
    clock.advance(100)
    await waitFor(() => stateOf().state === 'connected')
    expect(h.startCalls).toHaveLength(3)
  })

  it('组件缺失(componentMissing)为致命码:首发失败即停,⛔ 每 60 秒无限低频重试(收敛包2 件2)', async () => {
    const h = harness()
    h.startShouldFail = true
    h.startFailureCode = CONTROL_CODES.componentMissing
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    await waitFor(() => stateOf().state === 'error')
    expect(stateOf().code).toBe('组件缺失')
    expect(h.startCalls).toHaveLength(1) // 首发 1 次

    // 推进远超快速退避 + 低频周期:致命停止后不再有任何重连尝试
    clock.advance(10 * 60_000)
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(1)

    // 唤醒 / 网络事件同样推不动(致命态只有意图驱动的新 connect 清除)
    daemon.notifyEvent('wake')
    daemon.notifyEvent('network-change')
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(1)
    expect(stateOf().message).toBe('组件缺失')

    // 用户重连(新意图)→ 致命清除,恢复常规连接行为
    h.startShouldFail = false
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(100)
    await waitFor(() => stateOf().state === 'stopped-restored')
    writeIntentFile(dataDir, connectIntent())
    clock.advance(100)
    await waitFor(() => stateOf().state === 'connected')
    expect(h.startCalls).toHaveLength(2)
  })

  it('用户主动断开后唤醒不自动拉起；组织策略禁止时不反复尝试写入', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon(h)
    await daemon.run()
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(100)
    await waitFor(() => stateOf().state === 'stopped-restored')
    const startsAtDisconnect = h.startCalls.length
    daemon.notifyEvent('wake')
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(startsAtDisconnect)
    expect(stateOf().state).toBe('stopped-restored')

    // 致命态:换一个冲突环境的守护,唤醒不发起重试(⛔ 每次唤醒撞一次策略)
    const conflict = harness({ FAKE_WININET_POLICY: '1' })
    writeIntentFile(dataDir, connectIntent())
    const conflictDaemon = spawnDaemon(conflict)
    await conflictDaemon.run()
    expect(stateOf().message).toBe('受管理环境')
    conflictDaemon.notifyEvent('wake')
    await flushMicrotasks()
    expect(conflict.startCalls).toHaveLength(0)
    expect(stateOf().message).toBe('受管理环境')
  })
})
