import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { createLoopbackProbeConnector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { createAdapter, type FakeAdapter } from './fixtures/fake-adapter.mjs'
import { fakeAdapterEnv, makeTempDir, readJsonFile, removeTempDir, startFakeUpstream, waitFor, writeIntentFile, type FakeUpstream } from './helpers'

// N-78:平台事件源丢失唤醒输入时(Windows PowerShell 源可放弃),守护靠
// 「挂起后第一个轮询 tick 的墙钟间距远超轮询间隔」识别唤醒,立即复验/立即重试。
// 手工时钟:jump() 只推墙钟、不触发 interval——忠实模拟挂起期间定时器停走。
const EXIT_IP = '203.0.113.7'
const BRIDGE_PORT = 18080

class ManualIntervalClock {
  private current = 1_000_000
  private sequence = 0
  private timers: Array<{ id: number; at: number; fn: () => void; interval: number | undefined }> = []

  now(): number { return this.current }
  setTimeout(fn: () => void, delayMs: number): number {
    this.sequence += 1
    this.timers.push({ id: this.sequence, at: this.current + delayMs, fn, interval: undefined })
    return this.sequence
  }
  setInterval(fn: () => void, intervalMs: number): number {
    this.sequence += 1
    this.timers.push({ id: this.sequence, at: this.current + intervalMs, fn, interval: intervalMs })
    return this.sequence
  }
  clearTimer(id: number): void { this.timers = this.timers.filter((timer) => timer.id !== id) }
  /** 挂起语义:墙钟前进,定时器一个都不跑。 */
  jump(ms: number): void { this.current += ms }
  /** 周期任务数:等守护把 interval 注册起来。 */
  intervalCount(): number { return this.timers.filter((timer) => timer.interval !== undefined).length }

  /** 醒来语义:到期的周期任务各补跑一拍(挂起期间停走的,醒来时按到期补发)。 */
  fireIntervalsOnce(): void {
    for (const timer of [...this.timers]) {
      if (timer.interval === undefined || timer.at > this.current) continue
      timer.fn()
      timer.at = this.current + timer.interval
    }
  }
}

describe('唤醒事件丢失时的时钟跳变兜底(N-78)', () => {
  let dataDir: string
  let upstream: FakeUpstream
  let clock: ManualIntervalClock
  let adapter: FakeAdapter

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-wake-')
    upstream = await startFakeUpstream()
    clock = new ManualIntervalClock()
    adapter = createAdapter({ ...fakeAdapterEnv(`${dataDir}/fake-system.json`) } as NodeJS.ProcessEnv)
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function connectIntent() {
    return {
      desired: 'connected',
      sessionToken: 'test-session',
      bridgePort: BRIDGE_PORT,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP }
    }
  }

  it('挂起唤醒后(跳变>阈值)第一个轮询 tick 立即触发复验;小幅抖动不触发', { timeout: 15_000 }, async () => {
    let verifyCalls = 0
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({
      random: () => 0,
      dataDir,
      clock: clock as unknown as Parameters<typeof createDaemon>[0]['clock'],
      adapter,
      connectorFactory: () => {
        const connector: Connector = createLoopbackProbeConnector({ kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP })
        connector.verify = async () => { verifyCalls += 1; return { exitIp: EXIT_IP } }
        return connector
      },
      bridgeFactory: () => ({ listen: () => undefined, close: () => undefined }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 600_000
    })
    void daemon.run()
    await waitFor(() => clock.intervalCount() >= 3, 5_000)
    // 手动推进周期任务直到连上(等价轮询节奏由测试驱动)。
    const currentState = (): string | undefined => {
      try { return readJsonFile<{ state?: string }>(`${dataDir}/state.json`).state } catch { return undefined }
    }
    for (let tick = 0; tick < 80 && currentState() !== 'connected'; tick++) {
      clock.fireIntervalsOnce()
      clock.jump(100)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(currentState()).toBe('connected')
    const baseline = verifyCalls

    // 小幅墙钟抖动(59s,低于阈值)不应触发任何复验。
    clock.jump(59_000)
    clock.fireIntervalsOnce()
    await new Promise((resolve) => setImmediate(resolve))
    expect(verifyCalls).toBe(baseline)

    // 挂起 5 分钟后醒来:第一拍即按唤醒处理,立即复验(事件源丢失也有兜底)。
    clock.jump(5 * 60_000)
    clock.fireIntervalsOnce()
    await waitFor(() => verifyCalls > baseline, 5_000)
    expect(verifyCalls).toBeGreaterThan(baseline)
  })
})
