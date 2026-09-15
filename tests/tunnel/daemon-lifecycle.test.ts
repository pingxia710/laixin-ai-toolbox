import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { ConnectorError, createLoopbackProbeConnector, type Connector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon, readIntent, RECONNECT_BACKOFF_MS, type DaemonState } from '../../sidecar/mac/daemon-core.mjs'
import { lastIntent, loadLedger, type SettingEntry } from '../../sidecar/mac/ledger.mjs'
import { createAdapter, type FakeAdapter } from './fixtures/fake-adapter.mjs'
import {
  FakeClock,
  fakeAdapterEnv,
  flushMicrotasks,
  makeTempDir,
  readFakeStore,
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
  dataDir: string
  storePath: string
  clock: FakeClock
  adapter: FakeAdapter
  upstream: FakeUpstream
  startCalls: number[]
  exited: number | undefined
}

describe('守护核心(判据 1/2/8,连接时指纹核验)', () => {
  let dataDir: string
  let storePath: string
  let upstream: FakeUpstream
  let clock: FakeClock
  let adapter: FakeAdapter

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-daemon-')
    storePath = `${dataDir}/fake-system.json`
    upstream = await startFakeUpstream()
    clock = new FakeClock()
    adapter = createAdapter({
      ...fakeAdapterEnv(storePath)
    } as NodeJS.ProcessEnv)
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function harness(): Harness {
    return { dataDir, storePath, clock, adapter, upstream, startCalls: [], exited: undefined }
  }

  function connectorFactory(h: Harness, behavior?: (connector: Connector) => void) {
    return () => {
      const connector = createLoopbackProbeConnector({
        kind: 'loopback-probe',
        host: '127.0.0.1',
        port: h.upstream.port,
        exitIp: EXIT_IP
      })
      const originalStart = connector.start.bind(connector)
      connector.start = async () => {
        h.startCalls.push(h.clock.now())
        await originalStart()
      }
      behavior?.(connector)
      return connector
    }
  }

  function fakeBridgeFactory() {
    return () => ({ listen: () => undefined, close: () => undefined })
  }

  function spawnDaemon(h: Harness) {
    const daemon = createDaemon({ random: () => 0,
      dataDir: h.dataDir,
      clock: h.clock,
      adapter: h.adapter,
      connectorFactory: connectorFactory(h),
      bridgeFactory: fakeBridgeFactory(),
      parentAlive: () => true,
      onExit: (code) => {
        h.exited = code
      },
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 5_000
    })
    return daemon
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

  it('复验未返回时不重复发起，用户断开后的迟到成功不能重新显示已连', async () => {
    const h = harness()
    let verifyCalls = 0
    let finishVerify: ((value: { exitIp: string }) => void) | undefined
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({ random: () => 0, dataDir, clock, adapter,
      connectorFactory: connectorFactory(h, (connector) => {
        connector.verify = async () => {
          verifyCalls += 1
          if (verifyCalls === 1) return { exitIp: EXIT_IP }
          return new Promise((resolve) => { finishVerify = resolve })
        }
      }),
      bridgeFactory: fakeBridgeFactory(), parentAlive: () => true, onExit: () => undefined, verifyIntervalMs: 100, intentPollMs: 50
    })
    await daemon.run()
    clock.advance(100)
    await flushMicrotasks()
    clock.advance(100)
    await flushMicrotasks()
    expect(verifyCalls).toBe(2)
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    clock.advance(50)
    await waitFor(() => stateOf().state === 'stopped-restored')
    finishVerify?.({ exitIp: EXIT_IP })
    await flushMicrotasks()
    expect(stateOf().state).toBe('stopped-restored')
    expect(readFakeStore(storePath)).toEqual({})
    daemon.requestShutdown()
  })

  it('内核首次失败或运行中退出均不能假连通，重启内核后才恢复且不重复覆盖原设置', async () => {
    const h = harness()
    let canStart = false
    let bridgeAlive = false
    let onLost: ((error: Error) => void) | undefined
    let bridgeStarts = 0
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({ random: () => 0,
      dataDir, clock, adapter, connectorFactory: connectorFactory(h),
      bridgeFactory: () => ({
        listen: () => { bridgeStarts += 1; if (!canStart) throw new Error('KERNEL_FAILED'); bridgeAlive = true },
        close: () => { bridgeAlive = false },
        isAlive: () => bridgeAlive,
        onLost: (callback) => { onLost = callback }
      }),
      parentAlive: () => true, onExit: () => undefined
    })
    await daemon.run()
    expect(stateOf().state).toBe('error')
    expect(loadLedger(dataDir).filter((entry) => entry.kind === 'setting')).toHaveLength(0)
    canStart = true
    clock.advance(2_000)
    await waitFor(() => stateOf().state === 'connected')
    expect(readJsonFile(`${dataDir}/connection-verified.json`)).toEqual({ verifiedAt: clock.now() })
    expect(bridgeStarts).toBe(2)
    bridgeAlive = false
    onLost?.(new Error('KERNEL_EXITED'))
    expect(stateOf().state).toBe('error')
    // 断了不占代理(创始人 09-13):中继(内核)不在了,系统代理先还给客户,⛔ 让整机断网等重连
    expect(stateOf().message).toContain('已先恢复电脑正常上网')
    expect(readFakeStore(storePath)).toEqual({})
    clock.advance(2_000)
    await waitFor(() => stateOf().state === 'connected')
    expect(bridgeStarts).toBe(3)
    // 重连成功后重新记账写回:第一条已恢复,第二条的原值仍是真正的原值(⛔ 被我们自己的值覆盖)
    const settings = loadLedger(dataDir).filter((entry) => entry.kind === 'setting')
    expect(settings).toHaveLength(2)
    expect(settings[0].status).toBe('restored')
    expect(settings[1].originalValue).toEqual(settings[0].originalValue)
    expect(readFakeStore(storePath)).not.toEqual({})
    daemon.requestShutdown()
    await waitFor(() => stateOf().state === 'stopped-restored')
  })

  it('判据 1 正常闭环:起 → 账本写入 → 复验通过 → 停 → 每项已恢复 → 假适配器读数与起前逐字相同', async () => {
    const h = harness()
    const storeBefore = readFakeStore(storePath)
    writeIntentFile(dataDir, connectIntent())

    await spawnDaemon(h).run()
    expect(stateOf().state).toBe('connected')
    expect(stateOf().exitIp).toBe(EXIT_IP)
    const applied = loadLedger(dataDir).filter(
      (entry): entry is SettingEntry => entry.kind === 'setting'
    )
    expect(applied).toHaveLength(1)
    expect(applied[0].status).toBe('applied')
    expect(readFakeStore(storePath)['Wi-Fi/socks-proxy']).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: BRIDGE_PORT
    })

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    h.clock.advance(100)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(stateOf().state).toBe('stopped-restored')
    const entries = loadLedger(dataDir).filter(
      (entry): entry is SettingEntry => entry.kind === 'setting'
    )
    expect(entries.every((entry) => entry.status === 'restored')).toBe(true)
    expect(readFakeStore(storePath)).toEqual(storeBefore)
    expect(h.exited).toBeUndefined() // 主动停止后守护仍存活(判据 2 前提)
  })

  it('流量遥测文件不可替换时仍保持连接', async () => {
    const h = harness()
    let observations = 0
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({ random: () => 0, dataDir, clock, adapter,
      connectorFactory: connectorFactory(h),
      bridgeFactory: () => ({
        listen: () => undefined,
        close: () => undefined,
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

  it('判据 2:主动断开 → 注入连接丢失 + 推过 62 秒 → 连接尝试 0 次、守护存活;重起 sidecar 意图仍是主动断开仍不连', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    await spawnDaemon(h).run()
    expect(stateOf().state).toBe('connected')
    const callsBefore = h.startCalls.length

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    h.clock.advance(100)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(stateOf().state).toBe('stopped-restored')

    // 注入「连接丢失」(杀掉假上游)并把时钟推过全部退避总和 2+4+8+16+32=62 秒
    await upstream.killAll()
    h.clock.advance(62_000)
    await flushMicrotasks()

    expect(h.startCalls.length).toBe(callsBefore) // 连接尝试 = 0
    expect(h.exited).toBeUndefined() // 守护整段存活
    expect(lastIntent(dataDir)).toBe('user-disconnected')

    // 重起 sidecar(进程内等价:新 daemon 实例读同一数据目录)
    const h2 = harness()
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    await spawnDaemon(h2).run()
    h2.clock.advance(10_000)
    await flushMicrotasks()
    expect(h2.startCalls.length).toBe(0) // 仍不连
    expect(lastIntent(dataDir)).toBe('user-disconnected')
    expect(h2.exited).toBeUndefined()
  })

  it('杀假 SOCKS 后五次快速退避，再进入低频恢复', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    await spawnDaemon(h).run()
    expect(stateOf().state).toBe('connected')

    await upstream.killAll()
    await waitFor(() => stateOf().state === 'error')
    for (const [index, backoff] of RECONNECT_BACKOFF_MS.entries()) {
      h.clock.advance(backoff)
      // 重连尝试的 TCP 失败走真实回环 I/O,等它落定再推下一秒
      await waitFor(() => h.startCalls.length === index + 2)
      await waitFor(() => stateOf().state === 'error')
    }
    // 重连尝试发生在 2/4/8/16/32 秒处:首次 start + 5 次重连 = 6 个时点
    expect(h.startCalls).toHaveLength(6)
    const intervals = h.startCalls.slice(1).map((at, index) => at - h.startCalls[index])
    expect(intervals).toEqual([...RECONNECT_BACKOFF_MS])

    // 快速退避用尽:不管中继活不活,先把系统代理还给客户(酒店登录页/节点长时间不通),再低频重试
    await waitFor(() => stateOf().message === '连接中断，已先恢复电脑正常上网；正在低频重试')
    expect(readFakeStore(storePath)).toEqual({})

    h.clock.advance(59_999)
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(6)
    h.clock.advance(1)
    await waitFor(() => h.startCalls.length === 7)
    await waitFor(() => stateOf().message === '连接中断，已先恢复电脑正常上网；正在低频重试')
  })

  it('重连途中用户断开 → 立即停止重连并恢复', async () => {
    const h = harness()
    writeIntentFile(dataDir, connectIntent())
    await spawnDaemon(h).run()
    await upstream.killAll()
    await waitFor(() => stateOf().state === 'error')

    h.clock.advance(2_000) // 第 1 次重连(失败)
    await waitFor(() => h.startCalls.length === 2)
    await waitFor(() => stateOf().state === 'error')

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    h.clock.advance(100)
    await flushMicrotasks()
    await flushMicrotasks()
    h.clock.advance(600_000)
    await flushMicrotasks()
    expect(h.startCalls).toHaveLength(2) // 不再重连
    expect(stateOf().state).toBe('stopped-restored')
  })

  it('判据 6(连接时指纹不符):连接器抛「节点身份不符」→ 拒绝、不起、不重连、系统设置一个字节没动', async () => {
    const h = harness()
    const storeBefore = readFakeStore(storePath)
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({ random: () => 0,
      dataDir: h.dataDir,
      clock: h.clock,
      adapter: h.adapter,
      connectorFactory: () => {
        h.startCalls.push(h.clock.now())
        return {
          kind: 'loopback-probe',
          localProxyPort: () => upstream.port,
          onLost: () => undefined,
          start: () => Promise.reject(new ConnectorError('节点身份不符')),
          verify: () => Promise.resolve({ exitIp: EXIT_IP }),
          stop: () => undefined
        }
      },
      bridgeFactory: fakeBridgeFactory(),
      parentAlive: () => true,
      onExit: (code) => {
        h.exited = code
      }
    })
    await daemon.run()
    h.clock.advance(600_000)
    await flushMicrotasks()

    expect(stateOf().state).toBe('error')
    expect(stateOf().code).toBe('节点身份不符')
    expect(h.startCalls).toHaveLength(1) // 致命码不重连
    expect(loadLedger(dataDir).filter((entry) => entry.kind === 'setting')).toHaveLength(0)
    expect(readFakeStore(storePath)).toEqual(storeBefore)
  })

  it('判据 3③(sidecar 侧重起):上次崩溃留下未恢复账目,守护启动先恢复再待命', async () => {
    // 构造崩溃现场:账本一条 applied,假系统里还是我们的值
    const h = harness()
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    const { appendSettingEntry, generateSessionToken } = await import('../../sidecar/mac/ledger.mjs')
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi',
      item: 'socks-proxy',
      originalValue: null,
      writtenValue: { enabled: true, host: '127.0.0.1', port: BRIDGE_PORT },
      sessionToken: generateSessionToken(),
      time: 1
    })
    adapter.write({ service: 'Wi-Fi', item: 'socks-proxy' }, { enabled: true, host: '127.0.0.1', port: BRIDGE_PORT })

    await spawnDaemon(h).run()
    h.clock.advance(10_000)
    await flushMicrotasks()

    const entries = loadLedger(dataDir).filter(
      (entry): entry is SettingEntry => entry.kind === 'setting'
    )
    expect(entries.every((entry) => entry.status === 'restored')).toBe(true)
    expect(readFakeStore(storePath)).toEqual({})
    expect(h.startCalls).toHaveLength(0) // 意图是主动断开,恢复完不连
  })

  it('意图文件缺失时按账本意图待命;shutdown 意图 → 恢复并退出', async () => {
    const h = harness()
    const { appendIntentEntry } = await import('../../sidecar/mac/ledger.mjs')
    appendIntentEntry(dataDir, { intent: 'user-disconnected', time: 1 })
    expect(readIntent(dataDir)).toBeUndefined()

    await spawnDaemon(h).run()
    expect(['user-disconnected', 'stopped-restored']).toContain(stateOf().state)
    expect(h.exited).toBeUndefined()

    writeIntentFile(dataDir, { desired: 'shutdown' })
    h.clock.advance(100)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(h.exited).toBe(0)
    expect(stateOf().state).toBe('stopped-restored')
  })
})
