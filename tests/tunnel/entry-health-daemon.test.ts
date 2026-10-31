import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { CONTROL_CODES, ConnectorError, createLoopbackProbeConnector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon, type ConnectorSpec } from '../../sidecar/mac/daemon-core.mjs'
import { makeRealClock } from '../../sidecar/mac/tunnel-daemon.mjs'
import { createAdapter, type FakeAdapter } from './fixtures/fake-adapter.mjs'
import { fakeAdapterEnv, makeTempDir, readJsonFile, removeTempDir, startFakeUpstream, waitFor, writeIntentFile, type FakeUpstream } from './helpers'

// N-86 守护级:多入口意图下,当头入口连续失败到阈值 → 冷却 → 重连轮自动换到好入口;
// 全部入口冷却 → 不再空转换序(退避/还原链兜底)。单入口语义不变由既有 lifecycle 用例守护。
const EXIT_IP = '203.0.113.7'
const BRIDGE_PORT = 18080
const BAD = 'bad.test'
const GOOD = 'good.test'

describe('入口健康守门换序(守护级,N-86)', () => {
  let dataDir: string
  let upstream: FakeUpstream
  let adapter: FakeAdapter

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-entry-health-')
    upstream = await startFakeUpstream()
    adapter = createAdapter({ ...fakeAdapterEnv(`${dataDir}/fake-system.json`) } as NodeJS.ProcessEnv)
    attempts.length = 0
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function dualIntent(badFirst: boolean) {
    const bad = { kind: 'vless-reality', node: { host: BAD, port: 1 }, credentialPath: '/tmp/none', localPort: BRIDGE_PORT, verifyUrl: 'https://v.test/ip' }
    const good = { kind: 'vless-reality', node: { host: GOOD, port: 2 }, credentialPath: '/tmp/none', localPort: BRIDGE_PORT, verifyUrl: 'https://v.test/ip' }
    const connectors = badFirst ? [bad, good] : [good, bad]
    return {
      desired: 'connected', sessionToken: 'test-session', bridgePort: BRIDGE_PORT,
      connector: connectors[0], connectors,
      reuseDirect: false,
      // vless-reality 意图必须带授权期限(loopback-probe 才有测试豁免,见 authorizationCode 注释)。
      authorization: { id: `lx-${'a'.repeat(32)}`, expiresAt: 4_102_444_800_000 }
    }
  }

  function singleAddressIntent() {
    const intent = dualIntent(true)
    return { ...intent, singleAddressMode: true }
  }

  const attempts: Array<{ host: string; at: number }> = []

  function spawnDaemonWith(badFirst: boolean, allBad = false, attemptLog = attempts) {
    return createDaemon({
      random: () => 0,
      dataDir, clock: makeRealClock(), adapter,
      connectorFactory: (spec: ConnectorSpec) => {
        const host = 'node' in spec ? String(spec.node?.host ?? '') : ''
        const connector: Connector = createLoopbackProbeConnector({ kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP })
        const originalStart = connector.start.bind(connector)
        // attempts 只记当头入口:entryConnectors 会为每条入口都建 connector 对象,
        // 但只有当头会被 start——在 start 里计数才不混入非当头。
        connector.start = async () => {
          attemptLog.push({ host, at: Date.now() })
          if (host === BAD || allBad) throw new ConnectorError(CONTROL_CODES.upstreamUnreachable)
          return originalStart()
        }
        return connector
      },
      bridgeFactory: () => ({ listen: () => undefined, close: () => undefined }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 100, parentPollMs: 100, verifyIntervalMs: 60_000
    })
  }

  function stateOf(): { state?: string; message?: string } {
    try { return readJsonFile<{ state?: string; message?: string }>(`${dataDir}/state.json`) } catch { return {} }
  }
  function healthOf(): { entries?: Record<string, { state?: string }> } {
    try { return readJsonFile<{ entries?: Record<string, { state?: string }> }>(join(dataDir, 'entry-health.json')) } catch { return {} }
  }

  it('一坏一好:当头坏入口冷却后自动换到好入口连上;坏入口留档 cooling', { timeout: 40_000 }, async () => {
    writeIntentFile(dataDir, dualIntent(true))
    void spawnDaemonWith(true).run()
    // 真实时钟:初连失败(bad)→ 2s、4s 退避两轮 bad 冷却 → 8s 轮凭证据换 good 连上(≈15s 内)。
    await waitFor(() => stateOf().state === 'connected', 30_000)
    const hosts = attempts.map((attempt) => attempt.host)
    // 坏入口先试、凭证据(连续失败)换到好入口、好入口当头连上;换序前至少失败过一轮 bad。
    expect(hosts[0]).toBe(BAD)
    expect(hosts.indexOf(GOOD)).toBeGreaterThan(0)
    expect(hosts.at(-1)).toBe(GOOD)
    expect(healthOf().entries![`${BAD}:1`]!.state).toBe('cooling')
    // 好入口从未失败 → 不入账(recordSuccess 对无记录者 no-op),无记录即健康语义。
    expect(healthOf().entries?.[`${GOOD}:2`]?.state ?? 'healthy').toBe('healthy')
  })

  it('全部失败:两个入口都冷却后不再换序,退避照常推进(无空转、无死循环)', { timeout: 40_000 }, async () => {
    writeIntentFile(dataDir, dualIntent(true))
    void spawnDaemonWith(true, true).run()
    await waitFor(() => attempts.length >= 6, 90_000)
    expect(attempts.filter((attempt) => attempt.host === GOOD).length).toBeGreaterThanOrEqual(2)
    await waitFor(() => healthOf().entries?.[`${BAD}:1`]?.state === 'cooling', 10_000)
    await waitFor(() => healthOf().entries?.[`${GOOD}:2`]?.state === 'cooling', 30_000)
    // 耗尽后守护仍在 error/退避轨道(⛔ 崩溃、⛔ 死循环换序):状态可读且稳定。
    expect(['error', 'connecting'].includes(stateOf().state ?? '')).toBe(true)
  })

  it('单地址模式即使意外残留 connectors 也不在客户端轮转', { timeout: 20_000 }, async () => {
    const singleAttempts: Array<{ host: string; at: number }> = []
    writeIntentFile(dataDir, singleAddressIntent())
    void spawnDaemonWith(true, false, singleAttempts).run()
    await waitFor(() => stateOf().state === 'error', 15_000)
    expect(singleAttempts.length).toBeGreaterThan(0)
    expect(singleAttempts.every((attempt) => attempt.host === BAD)).toBe(true)
  })
})
