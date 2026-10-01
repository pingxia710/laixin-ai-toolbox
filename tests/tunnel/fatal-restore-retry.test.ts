// 致命连接故障已经关闭本机 bridge 时，系统代理仍可能指向这个死端口。
// 恢复写入的第一次临时失败不能丢掉恢复责任；同时，致命故障也不能被 wake/network-change 重新拉起。
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemon as macDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { CONTROL_CODES, ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { clearWriteRightOwner } from '../../sidecar/win/write-right-owner.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const DEAD_PROXY = '127.0.0.1:18080'
const EXTERNAL_PROXY = '127.0.0.1:7890'

const roots: string[] = []
afterEach(() => {
  clearWriteRightOwner(process.pid)
  roots.splice(0).forEach(removeTempDir)
})

const fatalError = () => new ConnectorError(CONTROL_CODES.hostKeyMismatch)

async function settle(): Promise<void> {
  await flushMicrotasks()
  await flushMicrotasks()
}

describe.each([
  ['macOS', macDaemon],
  ['Windows', winDaemon]
] as const)('%s fatal restore responsibility', (_platform, createDaemon) => {
  function harness() {
    const dataDir = makeTempDir('fatal-restore-retry-')
    roots.push(dataDir)
    const clock = new FakeClock()
    let value: unknown = null
    let restoreFailures = 0
    let bridgeCloses = 0
    let connectorStarts = 0
    let nextStopGate: Promise<void> | undefined
    const startErrors: Error[] = []
    let preflightError: Error | undefined
    let preflightCalls = 0
    const lossCallbacks: Array<(error: ConnectorError) => void> = []
    const writes: unknown[] = []
    const bridges: Array<{ closed: boolean }> = []

    const intent = (sessionToken: string) => ({
      desired: 'connected' as const,
      sessionToken,
      bridgePort: 18080,
      connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
    })
    writeIntentFile(dataDir, intent('fatal-r1'))

    const adapter = {
      preflight: () => { preflightCalls += 1; if (preflightError) throw preflightError },
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value,
      write: (_ref: unknown, next: unknown) => {
        writes.push(next)
        if (next === null && restoreFailures > 0) {
          restoreFailures -= 1
          throw new Error('temporary registry write failure')
        }
        value = next
      },
      preserveExternalChanges: () => true
    }
    const daemon = createDaemon({
      dataDir,
      clock,
      adapter,
      random: () => 0,
      parentAlive: () => true,
      onExit: () => {},
      intentPollMs: 100,
      connectorFactory: () => ({
        kind: 'loopback-probe',
        start: async () => {
          connectorStarts += 1
          const error = startErrors.shift()
          if (error !== undefined) throw error
        },
        stop: async () => {
          const gate = nextStopGate
          nextStopGate = undefined
          if (gate !== undefined) await gate
        },
        localProxyPort: () => 1,
        onLost: (callback: (error: ConnectorError) => void) => { lossCallbacks.push(callback) },
        verify: async () => ({ exitIp: '203.0.113.1' })
      }),
      bridgeFactory: () => {
        const bridgeState = { closed: false }
        bridges.push(bridgeState)
        return {
          listen: async () => {},
          close: async () => { if (!bridgeState.closed) bridgeCloses += 1; bridgeState.closed = true },
          isAlive: () => !bridgeState.closed,
          onLost: () => {}
        }
      }
    })

    const state = () => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { state: string; code?: string }
    const settingStatuses = () => loadLedger(dataDir)
      .filter((entry) => entry.kind === 'setting')
      .map((entry) => entry.status)
    const advance = async (ms: number) => { clock.advance(ms); await settle() }

    return {
      dataDir,
      daemon,
      intent,
      state,
      settingStatuses,
      advance,
      value: () => value,
      setValue: (next: unknown) => { value = next },
      failNextRestores: (count = 1) => { restoreFailures = count },
      failNextStart: (error: Error) => startErrors.push(error),
      setPreflightError: (error?: Error) => { preflightError = error },
      preflightCalls: () => preflightCalls,
      blockNextConnectorStop: () => {
        let release = () => {}
        nextStopGate = new Promise<void>((resolve) => { release = resolve })
        return release
      },
      lose: (error: ConnectorError) => lossCallbacks.at(-1)?.(error),
      bridgeCloses: () => bridgeCloses,
      bridges: () => bridges.map(({ closed }) => ({ closed })),
      connectorStarts: () => connectorStarts,
      writes: () => [...writes]
    }
  }

  it.each(['TUNNEL_PROXY_AUTH_REQUIRED', 'TUNNEL_PROXY_HELPER_FAILED'])('%s 不启动连接器、不轮换入口、不被唤醒事件重新连接', async (code) => {
    const h = harness()
    h.setPreflightError(Object.assign(new Error('local authorization failure'), { code }))
    await h.daemon.run()
    await settle()
    expect(h.state()).toMatchObject({ state: 'error', code })
    expect(h.connectorStarts()).toBe(0)
    expect(h.writes()).toEqual([])
    h.daemon.notifyEvent('wake')
    h.daemon.notifyEvent('network-change')
    await h.advance(120_000)
    expect(h.connectorStarts()).toBe(0)
    expect(h.preflightCalls()).toBe(1)
    expect(h.settingStatuses()).toEqual([])
    h.setPreflightError()
    writeIntentFile(h.dataDir, h.intent('authorized-r2'))
    await h.advance(200)
    expect(h.connectorStarts()).toBe(1)
    expect(h.value()).toBe(DEAD_PROXY)
  })

  it('已连接后首次致命故障：bridge 关闭且首次还原失败时继续按梯子恢复，wake 不会重连', async () => {
    const h = harness()
    await h.daemon.run()
    expect(h.value()).toBe(DEAD_PROXY)

    h.failNextRestores()
    h.lose(fatalError())
    await settle()

    expect(h.bridgeCloses()).toBe(1)
    expect(h.value()).toBe(DEAD_PROXY)
    expect(h.settingStatuses()).toEqual(['restore-failed'])
    expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE' })

    const startsAtFatal = h.connectorStarts()
    h.daemon.notifyEvent('wake')
    await h.advance(999)
    expect(h.value()).toBe(DEAD_PROXY)
    await h.advance(1)

    expect(h.value()).toBeNull()
    expect(h.settingStatuses()).toEqual(['restored'])
    expect(h.state()).toMatchObject({ state: 'error', code: CONTROL_CODES.hostKeyMismatch })
    h.daemon.notifyEvent('network-change')
    await h.advance(120_000)
    expect(h.connectorStarts()).toBe(startsAtFatal)
  })

  it('自动重连途中遇致命故障：关闭仍存活的 bridge 后，首次还原失败仍继续恢复', async () => {
    const h = harness()
    await h.daemon.run()
    h.lose(new ConnectorError(CONTROL_CODES.upstreamUnreachable))
    await settle()

    h.failNextStart(fatalError())
    h.failNextRestores()
    await h.advance(2_000)

    expect(h.connectorStarts()).toBe(2)
    expect(h.bridgeCloses()).toBe(1)
    expect(h.value()).toBe(DEAD_PROXY)
    expect(h.settingStatuses()).toEqual(['restore-failed'])
    expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE' })

    await h.advance(1_000)
    expect(h.value()).toBeNull()
    expect(h.settingStatuses()).toEqual(['restored'])
    expect(h.state()).toMatchObject({ state: 'error', code: CONTROL_CODES.hostKeyMismatch })
  })

  it('致命恢复梯子等待中客户新建连接：旧梯子不得删除新会话刚写下的代理', async () => {
    const h = harness()
    await h.daemon.run()
    h.failNextRestores()
    h.lose(fatalError())
    await settle()
    expect(h.settingStatuses()).toEqual(['restore-failed'])

    writeIntentFile(h.dataDir, h.intent('fatal-r2'))
    await h.advance(100)
    expect(h.value()).toBe(DEAD_PROXY)
    const writesAfterReconnect = h.writes()
    expect(h.connectorStarts()).toBe(2)

    await h.advance(1_000)
    expect(h.value()).toBe(DEAD_PROXY)
    expect(h.writes()).toEqual(writesAfterReconnect)
    expect(h.state().state).toBe('connected')
    const newSessionEntry = loadLedger(h.dataDir).find((entry) => entry.kind === 'setting' && entry.sessionToken === 'fatal-r2')
    expect(newSessionEntry?.kind === 'setting' ? newSessionEntry.status : undefined).toBe('applied')
  })

  it('致命恢复等待期间第三方接管代理：重试保留第三方现值并结清恢复责任', async () => {
    const h = harness()
    await h.daemon.run()
    h.failNextRestores()
    h.lose(fatalError())
    await settle()
    expect(h.settingStatuses()).toEqual(['restore-failed'])

    h.setValue(EXTERNAL_PROXY)
    await h.advance(1_000)

    expect(h.value()).toBe(EXTERNAL_PROXY)
    expect(h.settingStatuses()).toEqual(['preserved'])
    expect(h.state()).toMatchObject({ state: 'error', code: CONTROL_CODES.hostKeyMismatch })
  })

  it('旧 connector.stop 阻塞时新连接完成：旧停止收尾不得关闭新 bridge', async () => {
    const h = harness()
    await h.daemon.run()
    const releaseOldStop = h.blockNextConnectorStop()

    h.lose(fatalError())
    await settle()
    writeIntentFile(h.dataDir, h.intent('fatal-r2'))
    await h.advance(100)

    expect(h.connectorStarts()).toBe(2)
    expect(h.state().state).toBe('connected')
    expect(h.value()).toBe(DEAD_PROXY)
    expect(h.bridges()).toEqual([{ closed: true }, { closed: false }])

    releaseOldStop()
    await settle()

    expect(h.state().state).toBe('connected')
    expect(h.value()).toBe(DEAD_PROXY)
    expect(h.bridges()).toEqual([{ closed: true }, { closed: false }])
  })

  it('旧 bridge.close 延迟时新连接接续：旧收尾不得强杀或删除新 bridge 的共享资源', async () => {
    const dataDir = makeTempDir('fatal-bridge-generation-')
    roots.push(dataDir)
    const clock = new FakeClock()
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    const configPath = join(dataDir, 'xray-bridge.json')
    let value: unknown = null
    let bridgeSequence = 0
    let connectorStarts = 0
    let releaseOldClose = () => {}
    let oldCloseEnteredResolve = () => {}
    const oldCloseGate = new Promise<void>((resolve) => { releaseOldClose = resolve })
    const oldCloseEntered = new Promise<void>((resolve) => { oldCloseEnteredResolve = resolve })
    const lossCallbacks: Array<(error: ConnectorError) => void> = []
    const killedPids: number[] = []
    const deletedPidRecords: number[] = []
    const bridgeStates = new Map<number, { running: boolean }>()

    const intent = (sessionToken: string) => ({
      desired: 'connected' as const,
      sessionToken,
      bridgePort: 18080,
      connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
    })
    writeIntentFile(dataDir, intent('bridge-r1'))

    const currentRecord = () => JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
    const daemon = createDaemon({
      dataDir,
      clock,
      adapter: {
        managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
        read: () => value,
        write: (_ref: unknown, next: unknown) => { value = next }
      },
      random: () => 0,
      parentAlive: () => true,
      onExit: () => {},
      intentPollMs: 100,
      connectorFactory: () => ({
        kind: 'loopback-probe',
        start: async () => { connectorStarts += 1 },
        stop: async () => {},
        localProxyPort: () => 1,
        onLost: (callback: (error: ConnectorError) => void) => { lossCallbacks.push(callback) },
        verify: async () => ({ exitIp: '203.0.113.1' })
      }),
      bridgeFactory: () => {
        const pid = 7_100 + (++bridgeSequence)
        const bridgeState = { running: false }
        bridgeStates.set(pid, bridgeState)
        const usable = () => bridgeState.running && existsSync(pidPath) && currentRecord().pid === pid
        return {
          listen: async () => {
            writeFileSync(configPath, `${JSON.stringify({ pid })}\n`)
            writeFileSync(pidPath, `${JSON.stringify({ pid })}\n`)
            bridgeState.running = true
          },
          close: async () => {
            bridgeState.running = false
            if (pid === 7_101) {
              oldCloseEnteredResolve()
              await oldCloseGate
            }
            // 真实 local-bridge 的 1s 兜底会重读共享 PID 档后强杀；随后旧 runner
            // close 清理又会按同一路径删档。新 bridge 若已覆写，两步都会落到新一代。
            if (existsSync(pidPath)) {
              const recorded = currentRecord().pid
              killedPids.push(recorded)
              bridgeStates.get(recorded)!.running = false
              deletedPidRecords.push(currentRecord().pid)
              rmSync(pidPath, { force: true })
            }
          },
          isAlive: usable,
          verify: async () => {
            if (!usable()) throw new Error('bridge resource was removed by stale teardown')
            return { exitIp: '203.0.113.1' }
          },
          onLost: () => {}
        }
      }
    })

    await daemon.run()
    expect(currentRecord().pid).toBe(7_101)

    lossCallbacks[0](fatalError())
    await oldCloseEntered
    writeIntentFile(dataDir, intent('bridge-r2'))
    clock.advance(100)
    await settle()

    releaseOldClose()
    await settle()
    await expect.poll(() => connectorStarts).toBe(2)
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).state).toBe('connected')

    expect(killedPids).toEqual([7_101])
    expect(deletedPidRecords).toEqual([7_101])
    expect(currentRecord().pid).toBe(7_102)
    expect(bridgeStates.get(7_102)?.running).toBe(true)
  })
})

it('致命恢复释放写权后新 runId 接管：旧守护最终落状态前必须复查并让位', async () => {
  const dataDir = makeTempDir('fatal-restore-handover-')
  roots.push(dataDir)
  const clock = new FakeClock()
  let value: unknown = null
  let holder: string | undefined
  const oldExits: number[] = []
  const lossCallbacks: Array<(error: ConnectorError) => void> = []
  let oldConnectorStarts = 0

  const intent = (sessionToken: string) => ({
    desired: 'connected' as const,
    sessionToken,
    bridgePort: 18080,
    connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
  })
  const issueWriteRight = (owner: string) => () => {
    if (holder !== undefined && holder !== owner) return { acquired: false as const, reason: 'held' as const }
    holder = owner
    return {
      acquired: true as const,
      abandoned: false,
      release: () => { if (holder === owner) holder = undefined }
    }
  }
  const adapter = (owner: string) => ({
    managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
    read: () => value,
    write: (_ref: unknown, next: unknown) => { value = next },
    acquireWriteRight: issueWriteRight(owner)
  })
  const oldConnectorFactory = () => ({
    kind: 'loopback-probe',
    start: async () => { oldConnectorStarts += 1 },
    stop: async () => {},
    localProxyPort: () => 1,
    onLost: (callback: (error: ConnectorError) => void) => { lossCallbacks.push(callback) },
    verify: async () => ({ exitIp: '203.0.113.1' })
  })
  const bridgeFactory = () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })

  writeIntentFile(dataDir, intent('old-session'))
  const oldDaemon = winDaemon({ dataDir, runId: 'old-run', clock, adapter: adapter('old-run'), random: () => 0,
    parentAlive: () => true, onExit: (code: number) => { oldExits.push(code) }, intentPollMs: 100,
    connectorFactory: oldConnectorFactory, bridgeFactory })
  await oldDaemon.run()
  expect(holder).toBe('old-run')

  let releaseOldFinal = () => {}
  let restoredResolve = () => {}
  const oldFinalGate = new Promise<void>((resolve) => { releaseOldFinal = resolve })
  const restored = new Promise<void>((resolve) => { restoredResolve = resolve })
  const realRestoreLadder = oldDaemon.restoreWithRetryLadder.bind(oldDaemon)
  oldDaemon.restoreWithRetryLadder = async (...args: Parameters<typeof realRestoreLadder>) => {
    const result = await realRestoreLadder(...args)
    restoredResolve()
    await oldFinalGate
    return result
  }

  lossCallbacks[0](fatalError())
  await restored
  expect(holder).toBeUndefined()
  expect(value).toBeNull()

  writeIntentFile(dataDir, intent('new-session'))
  let releaseNewStart = () => {}
  let connectingAttemptResolve = () => {}
  const newStartGate = new Promise<void>((resolve) => { releaseNewStart = resolve })
  const connectingAttempt = new Promise<void>((resolve) => { connectingAttemptResolve = resolve })
  const newDaemon = winDaemon({ dataDir, runId: 'new-run', clock, adapter: adapter('new-run'), random: () => 0,
    parentAlive: () => true, onExit: () => {}, intentPollMs: 100,
    connectorFactory: () => ({
      kind: 'loopback-probe',
      start: async () => { await newStartGate },
      stop: async () => {},
      localProxyPort: () => 1,
      onLost: () => {},
      verify: async () => ({ exitIp: '203.0.113.1' })
    }),
    bridgeFactory })
  // 把普通 connecting 落盘卡在写入口，暴露「初始 restore 已完成，state.json 还是旧 runId」的真实窗口。
  const instrumentedNewDaemon = newDaemon as typeof newDaemon & {
    writeStateNow(state: string, extra?: Record<string, unknown>): void
  }
  const realNewWriteState = instrumentedNewDaemon.writeStateNow.bind(instrumentedNewDaemon)
  instrumentedNewDaemon.writeStateNow = (state: string, extra?: Record<string, unknown>) => {
    if (state === 'connecting') { connectingAttemptResolve(); return }
    realNewWriteState(state, extra)
  }
  const newRun = newDaemon.run()
  await connectingAttempt
  expect(holder).toBeUndefined()
  expect(value).toBeNull()
  const stateBeforeOldFinal = readFileSync(join(dataDir, 'state.json'), 'utf8')
  expect(JSON.parse(stateBeforeOldFinal)).toMatchObject({ runId: 'old-run' })

  releaseOldFinal()
  await settle()

  expect(oldExits).toEqual([0])
  expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(stateBeforeOldFinal)
  clock.advance(500)
  await settle()
  expect(oldConnectorStarts).toBe(1)

  releaseNewStart()
  await newRun
  expect(holder).toBe('new-run')
  expect(value).toBe(DEAD_PROXY)
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ state: 'connected', runId: 'new-run' })
})
