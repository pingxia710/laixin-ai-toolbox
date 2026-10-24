// N-27 恢复知情:重连成功必须有下文——成功日志(次数+中断时长)与待展示恢复事件(桌面弹一次通知的事实来源)。
// 此前 establish 后 attempts 静默归零,日志停在「重连尝试 4/5」没有下文(09-21 事故实证)。
import { describe, expect, it } from 'vitest'
import { ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { createDaemon, RECONNECT_BACKOFF_MS } from '../../sidecar/mac/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, fakeAdapterEnv, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, startFakeUpstream, waitFor, writeIntentFile } from './helpers'

const EXIT_IP = '203.0.113.7' // TEST-NET-3 文档保留段,假值
const BRIDGE_PORT = 18080

interface StateWithRecovery {
  state: string
  recovery?: { readonly id: number; readonly attempts: number; readonly outageMs: number }
}

interface Harness {
  dataDir: string
  storePath: string
  clock: FakeClock
  startCalls: number[]
  verifyCalls: number
  logs: string[]
  lost: Array<(error: ConnectorError) => void>
}

function harness(): Harness {
  return { dataDir: makeTempDir('laixin-n27-'), storePath: '', clock: new FakeClock(), startCalls: [], verifyCalls: 0, logs: [], lost: [] }
}

// 脚本化连接器:第 N 次 start 按脚本成功/失败;onLost 存进 h.lost 供用例手动触发「已连 → 通道丢失」。
function scriptedFactory(h: Harness, upstreamPort: number, script: Array<'ok' | 'fail'>) {
  return () => {
    const index = h.startCalls.length
    return {
      kind: 'loopback-probe',
      localProxyPort: () => upstreamPort,
      onLost: (callback: (error: ConnectorError) => void) => { h.lost.push(callback) },
      start: () => {
        h.startCalls.push(h.clock.now())
        return (script[index] ?? 'ok') === 'fail'
          ? Promise.reject(new ConnectorError('上游不可达', '测试注入:上游不可达'))
          : Promise.resolve()
      },
      verify: () => {
        h.verifyCalls += 1
        return Promise.resolve({ exitIp: EXIT_IP })
      },
      stop: () => undefined
    }
  }
}

function fakeBridgeFactory() {
  return () => ({ listen: () => undefined, close: () => undefined })
}

function spawn(h: Harness, script: Array<'ok' | 'fail'>, upstreamPort: number) {
  return createDaemon({ random: () => 0,
    dataDir: h.dataDir,
    clock: h.clock,
    adapter: createAdapter({ ...fakeAdapterEnv(h.storePath) } as NodeJS.ProcessEnv),
    connectorFactory: scriptedFactory(h, upstreamPort, script),
    bridgeFactory: fakeBridgeFactory(),
    parentAlive: () => true,
    onExit: () => undefined,
    log: (line: string) => { h.logs.push(line) },
    intentPollMs: 100,
    parentPollMs: 100,
    verifyIntervalMs: 5_000
  })
}

function connectIntent(upstreamPort: number, sessionToken: string) {
  return { desired: 'connected', sessionToken, bridgePort: BRIDGE_PORT,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstreamPort, exitIp: EXIT_IP } }
}

function stateOf(dataDir: string): StateWithRecovery {
  return readJsonFile<StateWithRecovery>(`${dataDir}/state.json`)
}

async function loseConnection(h: Harness): Promise<number> {
  const lostAt = h.clock.now()
  h.lost[h.lost.length - 1]?.(new ConnectorError('上游不可达', '测试注入:上游不可达'))
  await flushMicrotasks()
  await waitFor(() => stateOf(h.dataDir).state === 'error')
  return lostAt
}

describe('N-27 恢复知情(成功日志 + 待展示恢复事件)', () => {
  it('已连 → 上游丢失 → 第 3 次重连成功:日志带次数与中断时长,state 带恢复事件,后续状态写出不翻倍不丢失', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      const daemon = spawn(h, ['ok', 'fail', 'fail', 'ok'], upstream.port)
      await daemon.run()
      expect(stateOf(h.dataDir).state).toBe('connected')
      const verifiesAfterConnect = h.verifyCalls

      const lostAt = await loseConnection(h)
      // 快速退避 [2,4,8]:前两次失败,第 3 次(random=0,无抖动)在 lostAt+14s 接上
      h.clock.advance(RECONNECT_BACKOFF_MS[0])
      await waitFor(() => h.startCalls.length === 2)
      await waitFor(() => stateOf(h.dataDir).state === 'error')
      h.clock.advance(RECONNECT_BACKOFF_MS[1])
      await waitFor(() => h.startCalls.length === 3)
      await waitFor(() => stateOf(h.dataDir).state === 'error')
      h.clock.advance(RECONNECT_BACKOFF_MS[2])
      await waitFor(() => h.startCalls.length === 4)
      await waitFor(() => stateOf(h.dataDir).state === 'connected')

      expect(h.logs.some((line) => line.includes('重连成功：第 3 次重连后通道恢复，本次中断 14 秒'))).toBe(true)
      expect(stateOf(h.dataDir).recovery).toEqual({ id: lostAt, attempts: 3, outageMs: 14_000 })

      // 之后的状态写出(定时复验)必须继续带同一份恢复事件:晚到的桌面轮询只认这一个事实,且不重复
      h.clock.advance(5_000)
      await waitFor(() => h.verifyCalls > verifiesAfterConnect)
      expect(stateOf(h.dataDir).state).toBe('connected')
      expect(stateOf(h.dataDir).recovery).toEqual({ id: lostAt, attempts: 3, outageMs: 14_000 })
      daemon.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })

  it('快速退避用尽后低频阶段接上:日志如实区分「第 6 次·低频」,事件如实记 6 次与 122 秒', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      const daemon = spawn(h, ['ok', 'fail', 'fail', 'fail', 'fail', 'fail', 'ok'], upstream.port)
      await daemon.run()
      const lostAt = await loseConnection(h)
      let attempts = 1 // 首次连接已发生
      for (const backoff of RECONNECT_BACKOFF_MS) {
        h.clock.advance(backoff)
        attempts += 1
        await waitFor(() => h.startCalls.length === attempts)
        await waitFor(() => stateOf(h.dataDir).state === 'error')
      }
      // 低频一拍(60s)后第 6 次尝试接上:2+4+8+16+32+60 = 122s
      h.clock.advance(60_000)
      await waitFor(() => h.startCalls.length === 7)
      await waitFor(() => stateOf(h.dataDir).state === 'connected')

      expect(h.logs.some((line) => line.includes('第 6 次') && line.includes('低频') && line.includes('本次中断 2 分 2 秒'))).toBe(true)
      expect(stateOf(h.dataDir).recovery).toEqual({ id: lostAt, attempts: 6, outageMs: 122_000 })
      daemon.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })

  it('初次连接一次成功:无成功日志、无恢复事件', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      const daemon = spawn(h, ['ok'], upstream.port)
      await daemon.run()
      expect(stateOf(h.dataDir).state).toBe('connected')
      expect(h.logs.some((line) => line.includes('重连成功'))).toBe(false)
      expect(stateOf(h.dataDir).recovery).toBeUndefined()
      daemon.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })

  it('初次连接失败后自动重试接上(客户就在屏幕前):有成功日志,⛔ 不挂恢复事件', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      const daemon = spawn(h, ['fail', 'ok'], upstream.port)
      await daemon.run()
      h.clock.advance(2_000)
      await waitFor(() => h.startCalls.length === 2)
      await waitFor(() => stateOf(h.dataDir).state === 'connected')

      expect(h.logs.some((line) => line.includes('重连成功：自动重连第 1 次尝试后接上'))).toBe(true)
      expect(stateOf(h.dataDir).recovery).toBeUndefined()
      daemon.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })

  it('恢复事件只属于当前片段:新故障压掉未被消费的旧事件,再次恢复是新 id', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      // 每次故障后的第 1 次重连就接上:attempts=1、中断=2s,断言最短恢复片段
      const daemon = spawn(h, ['ok', 'ok', 'ok'], upstream.port)
      await daemon.run()
      const firstLostAt = await loseConnection(h)
      h.clock.advance(RECONNECT_BACKOFF_MS[0])
      await waitFor(() => h.startCalls.length === 2)
      await waitFor(() => stateOf(h.dataDir).state === 'connected')
      expect(stateOf(h.dataDir).recovery).toEqual({ id: firstLostAt, attempts: 1, outageMs: 2_000 })

      // 第二次故障:旧恢复事件必须立刻被压掉(新故障期间 ⛔ 弹「已恢复」)
      const secondLostAt = await loseConnection(h)
      expect(secondLostAt).toBeGreaterThan(firstLostAt)
      expect(stateOf(h.dataDir).recovery).toBeUndefined()
      h.clock.advance(RECONNECT_BACKOFF_MS[0])
      await waitFor(() => h.startCalls.length === 3)
      await waitFor(() => stateOf(h.dataDir).state === 'connected')
      expect(stateOf(h.dataDir).recovery).toEqual({ id: secondLostAt, attempts: 1, outageMs: 2_000 })
      daemon.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })

  it('用户主动断开终止片段:此后重开连接成功不算恢复,无成功日志、无恢复事件', async () => {
    const h = harness()
    h.storePath = `${h.dataDir}/fake-system.json`
    const upstream = await startFakeUpstream()
    try {
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session'))
      const daemon = spawn(h, ['ok', 'fail'], upstream.port)
      await daemon.run()
      await loseConnection(h)
      h.clock.advance(RECONNECT_BACKOFF_MS[0])
      await waitFor(() => h.startCalls.length === 2)
      await waitFor(() => stateOf(h.dataDir).state === 'error')

      writeIntentFile(h.dataDir, { desired: 'user-disconnected' })
      h.clock.advance(100)
      await flushMicrotasks()
      await waitFor(() => stateOf(h.dataDir).state === 'stopped-restored')
      daemon.requestShutdown()

      // 用户再点连接 = 全新连接(进程内等价:同一数据目录新守护实例,同「守护重启」语义)
      writeIntentFile(h.dataDir, connectIntent(upstream.port, 'test-session-2'))
      const daemon2 = spawn(h, ['ok'], upstream.port)
      await daemon2.run()
      expect(stateOf(h.dataDir).state).toBe('connected')
      expect(h.logs.some((line) => line.includes('重连成功'))).toBe(false)
      expect(stateOf(h.dataDir).recovery).toBeUndefined()
      daemon2.requestShutdown()
    } finally {
      await upstream.killAll()
      removeTempDir(h.dataDir)
    }
  })
})
