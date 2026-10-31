import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { ConnectorError, CONTROL_CODES, createLoopbackProbeConnector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { appendFunnelAttempt, blankFunnelAttempt, readFunnelAttempts, writeFunnelAttempts, FUNNEL_LEDGER_LIMIT, type FunnelAttempt } from '../../sidecar/mac/connection-funnel.mjs'
import { createAdapter, type FakeAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, fakeAdapterEnv, makeTempDir, readJsonFile, removeTempDir, startFakeUpstream, waitFor, writeIntentFile, type FakeUpstream } from './helpers'

// N-79 连接漏斗台账:每次连接尝试一条(触发源/各阶段耗时与结局/总结局),
// 只落阶段码与毫秒,⛔ 地址、凭据、令牌。落盘 connection-funnel.json 供诊断包收录。
const EXIT_IP = '203.0.113.7'
const BRIDGE_PORT = 18080

describe('连接漏斗台账(N-79)', () => {
  let dataDir: string
  let upstream: FakeUpstream
  let clock: FakeClock
  let adapter: FakeAdapter

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-funnel-')
    upstream = await startFakeUpstream()
    clock = new FakeClock()
    adapter = createAdapter({ ...fakeAdapterEnv(`${dataDir}/fake-system.json`) } as NodeJS.ProcessEnv)
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function connectorFactory(behavior?: (connector: Connector) => void) {
    return () => {
      const connector = createLoopbackProbeConnector({ kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP })
      behavior?.(connector)
      return connector
    }
  }

  function spawnDaemon(behavior?: (connector: Connector) => void) {
    const daemon = createDaemon({
      random: () => 0,
      dataDir,
      clock,
      adapter,
      connectorFactory: connectorFactory(behavior),
      bridgeFactory: () => ({ listen: () => undefined, close: () => undefined }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 60_000
    })
    void daemon.run()
    return daemon
  }

  function connectIntent() {
    return {
      desired: 'connected',
      sessionToken: 'test-session-secret',
      bridgePort: BRIDGE_PORT,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP }
    }
  }

  function funnelPath() { return join(dataDir, 'connection-funnel.json') }

  function funnelFile() { return readJsonFile<{ attempts?: Array<Record<string, unknown>> }>(funnelPath()) }

  async function waitForState(predicate: (state: { state?: string; code?: string }) => boolean) {
    await waitFor(() => {
      try { return predicate(readJsonFile<{ state?: string; code?: string }>(`${dataDir}/state.json`)) } catch { return false }
    }, 5_000)
  }

  it('成功连接落一条完整漏斗:触发源、各阶段 ok、总结局 connected,且不含地址/令牌', async () => {
    writeIntentFile(dataDir, connectIntent())
    spawnDaemon()
    await waitForState((state) => state.state === 'connected')

    const file = funnelFile()
    const attempt = file.attempts?.[file.attempts.length - 1]
    expect(attempt).toBeDefined()
    expect(attempt!.outcome).toBe('connected')
    expect(attempt!.trigger).toBe('connect')
    const names = (attempt!.stages as Array<{ name: string; outcome: string }>).map((stage) => stage.name)
    expect(names).toContain('connector-start')
    expect(names).toContain('bridge-start')
    expect(names).toContain('path-verify-before-settings')
    expect(names).toContain('path-verify-after-settings')
    for (const stage of attempt!.stages as Array<{ outcome: string; durationMs: number }>) {
      expect(stage.outcome).toBe('ok')
      expect(stage.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(typeof attempt!.endedAt).toBe('number')
    // ⛔ 台账只允许阶段码与毫秒:意图里的地址、会话令牌一个字都不能出现。
    const raw = JSON.stringify(file)
    expect(raw).not.toContain('test-session-secret')
    expect(raw).not.toContain('127.0.0.1')
  })

  it('连接器阶段失败:阶段行 outcome=error 带受控码,总结局 fatal', async () => {
    writeIntentFile(dataDir, connectIntent())
    spawnDaemon((connector) => {
      connector.start = async () => { throw new ConnectorError(CONTROL_CODES.proxyConflict) }
    })
    await waitForState((state) => state.state === 'error' && state.code === CONTROL_CODES.proxyConflict)

    const file = funnelFile()
    const attempt = file.attempts?.[file.attempts.length - 1]
    expect(attempt).toBeDefined()
    expect(attempt!.outcome).toBe('fatal')
    expect(attempt!.code).toBe(CONTROL_CODES.proxyConflict)
    const startStage = (attempt!.stages as Array<{ name: string; outcome: string; code?: string }>).find((stage) => stage.name === 'connector-start')
    expect(startStage?.outcome).toBe('error')
    expect(startStage?.code).toBe(CONTROL_CODES.proxyConflict)
  })

  it('N-81 连接器带网络证据失败:阶段行 outcome=error 且 phase=tcp;ok 行不带 phase', async () => {
    writeIntentFile(dataDir, connectIntent())
    spawnDaemon((connector) => {
      connector.start = async () => {
        throw Object.assign(new Error('connect failed'), { cause: Object.assign(new Error('cause'), { code: 'ECONNREFUSED' }) })
      }
    })
    await waitForState((state) => state.state === 'error')
    const file = funnelFile()
    const attempt = file.attempts?.[file.attempts.length - 1]
    const startStage = (attempt!.stages as Array<{ name: string; outcome: string; phase?: string }>).find((stage) => stage.name === 'connector-start')
    expect(startStage?.outcome).toBe('error')
    expect(startStage?.phase).toBe('tcp')
    // ok 阶段行不携带 phase。
    writeIntentFile(dataDir, { ...connectIntent(), updatedAt: 2 })
    spawnDaemon()
    await waitForState((state) => state.state === 'connected')
    const okAttempt = funnelFile().attempts?.at(-1)
    const okStage = (okAttempt!.stages as Array<{ name: string; phase?: string }>).find((stage) => stage.name === 'connector-start')
    expect(okStage?.phase).toBeUndefined()
  })

  it('N-87 上一代硬终止遗留的 in-progress 尝试,启动加载时标为 abandoned', async () => {
    writeFileSync(funnelPath(), JSON.stringify({ attempts: [
      { trigger: 'connect', startedAt: 100, stages: [{ name: 'connector-start', durationMs: 5, outcome: 'ok', at: 100 }], outcome: 'in-progress', endedAt: null }
    ] }) + '\n')
    spawnDaemon()
    await waitForState((state) => state.state !== undefined)
    const file = funnelFile()
    expect(file.attempts![0]!.outcome).toBe('abandoned')
    expect(typeof file.attempts![0]!.endedAt).toBe('number')
  })

  it('N-87 开条即落盘:连接卡在半途时,台账已能看到 in-progress 尝试', async () => {
    let release: (() => void) | undefined
    writeIntentFile(dataDir, connectIntent())
    spawnDaemon((connector) => {
      connector.start = async () => { await new Promise<void>((resolve) => { release = resolve }); return undefined }
    })
    await waitFor(() => {
      try { return funnelFile().attempts?.some((attempt) => attempt.outcome === 'in-progress') === true } catch { return false }
    }, 5_000)
    release?.()
    expect(true).toBe(true)
  })

  it('连接阶段完成后立即落盘阶段行，强杀时下一代可定位卡点', async () => {
    let releaseBridge: (() => void) | undefined
    writeIntentFile(dataDir, connectIntent())
    const daemon = createDaemon({
      random: () => 0,
      dataDir,
      clock,
      adapter,
      connectorFactory: connectorFactory(),
      bridgeFactory: () => ({
        listen: () => new Promise<void>((resolve) => { releaseBridge = resolve }),
        close: () => undefined
      }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 60_000
    })
    void daemon.run()
    await waitFor(() => {
      try {
        const attempt = funnelFile().attempts?.at(-1) as { stages?: Array<{ name?: unknown }> } | undefined
        return Array.isArray(attempt?.stages) && attempt.stages.some((stage) => stage.name === 'connector-start')
      } catch { return false }
    }, 5_000)
    expect(funnelFile().attempts?.at(-1)?.outcome).toBe('in-progress')
    expect(funnelFile().attempts?.at(-1)?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'connector-start', outcome: 'ok' })
    ]))
    releaseBridge?.()
  })

  it('环形上限:只保留最近 FUNNEL_LEDGER_LIMIT 条(纯函数)', () => {
    let attempts: readonly FunnelAttempt[] = []
    for (let index = 0; index < FUNNEL_LEDGER_LIMIT + 5; index += 1) {
      attempts = appendFunnelAttempt(attempts, blankFunnelAttempt(`t${index}`, index))
    }
    expect(attempts).toHaveLength(FUNNEL_LEDGER_LIMIT)
    expect(attempts[0]!.trigger).toBe(`t${FUNNEL_LEDGER_LIMIT + 5 - FUNNEL_LEDGER_LIMIT}`)
    expect(attempts[attempts.length - 1]!.trigger).toBe(`t${FUNNEL_LEDGER_LIMIT + 4}`)
  })

  it('读回验形:被改写的行整条丢弃,损坏文件返回空数组', () => {
    const tampered = join(dataDir, 'tampered-funnel.json')
    const ok = blankFunnelAttempt('connect', 1)
    ok.stages = [{ name: 'connector-start', durationMs: 3, outcome: 'ok' }]
    const bad = { ...blankFunnelAttempt('自定义触发源 含自由文本!!', 2) }
    writeFunnelAttempts(tampered, [ok, bad])
    const loaded = readFunnelAttempts(tampered)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.trigger).toBe('connect')

    const corrupt = join(dataDir, 'corrupt-funnel.json')
    writeFileSync(corrupt, '{not-json')
    expect(readFunnelAttempts(corrupt)).toEqual([])
  })
})
