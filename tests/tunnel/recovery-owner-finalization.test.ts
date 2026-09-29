// N-27 第四轮复审：恢复责任令牌发布失败不能把全局写权攥死；致命收尾失败也不能伪装成已交接。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemon, installCrashBailout } from '../../sidecar/win/daemon-core.mjs'
import { createDaemon as createMacDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { SettingsBusyError, settingsLockPath, withSettingsLock } from '../../sidecar/win/ledger.mjs'
import { clearWriteRightOwner } from '../../sidecar/win/write-right-owner.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const DEAD_PROXY = '127.0.0.1:18080'
const roots: string[] = []

afterEach(() => {
  clearWriteRightOwner(process.pid)
  roots.splice(0).forEach(removeTempDir)
})

async function settle(): Promise<void> {
  await flushMicrotasks()
  await flushMicrotasks()
}

function inertConnector() {
  return {
    kind: 'loopback-probe',
    start: async () => {},
    stop: async () => {},
    localProxyPort: () => 1,
    onLost: () => {},
    verify: async () => ({ exitIp: '203.0.113.1' })
  }
}

function inertBridge() {
  return { listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }
}

describe.each([
  ['writeFileSync', (dataDir: string) => join(dataDir, 'recovery-owner.json.tmp')],
  ['renameSync', (dataDir: string) => join(dataDir, 'recovery-owner.json')]
] as const)('recovery owner %s failure', (_operation, blockedPath) => {
  it('启动恢复会释放写权、写明失败并按有界梯子重试', async () => {
    const dataDir = makeTempDir('recovery-owner-publish-')
    roots.push(dataDir)
    const clock = new FakeClock()
    let value: unknown = DEAD_PROXY
    let held = false
    let acquisitions = 0
    let releases = 0

    writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify([
      { id: 'stale-setting', kind: 'setting', service: 'test', item: 'proxy', originalValue: null,
        writtenValue: DEAD_PROXY, sessionToken: 'old-session', time: 1, status: 'applied', note: '' }
    ])}\n`, { mode: 0o600 })
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'idle-after-recovery' })
    // tmp 是目录时 writeFileSync 抛错；目标是目录时写 tmp 成功、renameSync 抛错。
    mkdirSync(blockedPath(dataDir))

    const adapter = {
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value,
      write: (_ref: unknown, next: unknown) => { value = next },
      acquireWriteRight: () => {
        if (held) return { acquired: false as const, reason: 'held' as const }
        held = true
        acquisitions += 1
        return {
          acquired: true as const,
          abandoned: false,
          release: () => { held = false; releases += 1 }
        }
      }
    }
    const daemon = createDaemon({
      dataDir,
      runId: 'recovery-run',
      clock,
      parentAlive: () => true,
      onExit: () => {},
      adapter,
      connectorFactory: inertConnector,
      bridgeFactory: inertBridge
    })

    await daemon.run()
    await settle()

    expect(value).toBeNull() // 系统设置本身已经安全还原
    expect(held).toBe(false)
    expect(releases).toBe(1)
    expect(clock.pendingCount()).toBe(4) // 三个常驻 interval + 恢复梯子的 1 秒重试
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
      state: 'error',
      code: 'TUNNEL_RECOVERY_OWNER_PUBLISH_FAILED'
    })

    rmSync(blockedPath(dataDir), { recursive: true, force: true })
    clock.advance(1_000)
    await settle()

    expect(acquisitions).toBe(2)
    expect(releases).toBe(2)
    expect(held).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir, 'recovery-owner.json'), 'utf8'))).toMatchObject({
      runId: 'recovery-run',
      generation: 1
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
      state: 'stopped-restored',
      runId: 'recovery-run'
    })
  })
})

it('普通首次连接无旧账时恢复 owner 写盘失败应保留错误并在解除后自动重试接上', async () => {
  const dataDir = makeTempDir('connect-owner-publish-')
  roots.push(dataDir)
  const clock = new FakeClock()
  const starts: number[] = []
  let value: unknown = null
  const blocked = join(dataDir, 'recovery-owner.json.tmp')
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'fresh-connect', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  mkdirSync(blocked)
  const daemon = createDaemon({
    dataDir, runId: 'fresh-run', clock, parentAlive: () => true, onExit: () => {},
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value, write: (_ref: unknown, next: unknown) => { value = next } },
    connectorFactory: () => ({ ...inertConnector(), start: async () => { starts.push(clock.now()) } }),
    bridgeFactory: inertBridge
  })

  await daemon.run()
  await settle()
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    state: 'error', code: 'TUNNEL_RECOVERY_OWNER_PUBLISH_FAILED'
  })
  expect(starts).toEqual([])
  expect(clock.pendingCount()).toBe(4) // 三个 interval + 普通连接的下一次 owner 重试

  clock.advance(2_000)
  await settle()
  expect(starts).toEqual([])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    state: 'error', code: 'TUNNEL_RECOVERY_OWNER_PUBLISH_FAILED'
  })
  expect(clock.pendingCount()).toBe(4)

  rmSync(blocked, { recursive: true, force: true })
  clock.advance(2_000)
  await settle()
  expect(starts).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dataDir, 'recovery-owner.json'), 'utf8'))).toMatchObject({ runId: 'fresh-run' })
  const finalState = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
  expect(finalState.code).toBe('')
  expect(finalState).toMatchObject({ state: 'connected' })
})

function fatalHarness() {
  const dataDir = makeTempDir('fatal-finalization-')
  roots.push(dataDir)
  const exits: number[] = []
  const clock = new FakeClock()
  writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'fatal-finalization' })
  const daemon = createDaemon({
    dataDir,
    runId: 'fatal-run',
    clock,
    parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: {
      managedItems: () => [],
      read: () => null,
      write: () => {}
    },
    connectorFactory: inertConnector,
    bridgeFactory: inertBridge
  })
  return { daemon, exits, clock, dataDir }
}

it('守护冷启动读取已断开意图且无待还账时写出已恢复终态', async () => {
  const { daemon, dataDir } = fatalHarness()
  await daemon.run()
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    state: 'stopped-restored', intentToken: 'fatal-finalization'
  })
})

it('旧守护崩溃且拿不到写权时，已发布的新守护 connected 状态不能被 DAEMON_CRASH 覆盖', () => {
  const dataDir = makeTempDir('crash-owner-finalization-')
  roots.push(dataDir)
  const exits: number[] = []
  const bailout = installCrashBailout({
    dataDir, runId: 'old', exit: (code: number) => { exits.push(code) },
    adapterOf: () => ({ managedItems: () => [], read: () => null, write: () => {},
      acquireWriteRight: () => ({ acquired: false as const, reason: 'held' as const }) })
  })
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'new', generation: 1 }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'new', state: 'connected', updatedAt: 1 }))
  try {
    const ours = process.listeners('uncaughtException').at(-1) as (error: Error) => void
    ours(new Error('old daemon crashed'))
  } finally { bailout.dispose() }

  expect(exits).toEqual([70])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    runId: 'new', state: 'connected'
  })
})

it('关停恢复尚未完成、最终写盘撞锁时不能 exit 0 冒充交接；锁释放后才如实退出 65', async () => {
  const { daemon, exits, clock, dataDir } = fatalHarness()
  await daemon.run()
  const internal = daemon as unknown as { restoreWithRetryLadder(): Promise<unknown> }
  internal.restoreWithRetryLadder = async () => {
    writeFileSync(settingsLockPath(dataDir), JSON.stringify({ token: 'other-task', pid: process.pid, at: Date.now() }))
    return false
  }

  daemon.requestShutdown()
  await settle()
  expect(exits).toEqual([])

  rmSync(settingsLockPath(dataDir))
  clock.advance(1_000)
  await settle()
  expect(exits).toEqual([65])
}, 10_000)

it('关停最终状态写盘 I/O 失败也不能当成新守护交接而 exit 0', async () => {
  const { daemon, exits, dataDir } = fatalHarness()
  await daemon.run()
  const internal = daemon as unknown as {
    restoreWithRetryLadder(): Promise<unknown>
    writeStateNow(state: string, extra?: Record<string, unknown>): void
  }
  internal.restoreWithRetryLadder = async () => ({ restored: [] })
  const writeStateNow = internal.writeStateNow.bind(internal)
  internal.writeStateNow = (state, extra) => {
    if (state === 'stopped-restored') throw Object.assign(new Error('injected final state EIO'), { code: 'EIO' })
    writeStateNow(state, extra)
  }

  daemon.requestShutdown()
  await settle()
  expect(exits).toEqual([65])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE'
  })
})

it('常驻自愈完成后，新守护已接手时旧守护不能把 connected 覆盖成 stopped-restored', async () => {
  const dataDir = makeTempDir('self-heal-owner-finalization-')
  roots.push(dataDir)
  const exits: number[] = []
  let selfHealCalls = 0
  writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'old' })
  const daemon = createDaemon({
    dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [], read: () => null, write: () => {} },
    connectorFactory: inertConnector, bridgeFactory: inertBridge,
    residentSelfHeal: () => { selfHealCalls += 1; return { shouldExit: true } }
  })
  await daemon.run()
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'new', generation: 1 }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'new', state: 'connected', updatedAt: 1 }))

  await (daemon as unknown as { runResidentSelfHeal(): Promise<void> }).runResidentSelfHeal()
  expect(exits).toEqual([0])
  expect(selfHealCalls).toBe(0)
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    runId: 'new', state: 'connected'
  })
})

it('常驻自愈撞设置锁时保持进程与恢复责任，锁释放后才完整重试', async () => {
  const dataDir = makeTempDir('self-heal-lock-finalization-')
  roots.push(dataDir)
  const exits: number[] = []
  let selfHealCalls = 0
  writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'old' })
  const daemon = createDaemon({
    dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [], read: () => null, write: () => {} },
    connectorFactory: inertConnector, bridgeFactory: inertBridge,
    residentSelfHeal: () => { selfHealCalls += 1; return { shouldExit: true } }
  })
  await daemon.run()
  writeFileSync(settingsLockPath(dataDir), JSON.stringify({ token: 'other-task', pid: process.pid, at: Date.now() }))
  const internal = daemon as unknown as { runResidentSelfHeal(): Promise<void> }
  await internal.runResidentSelfHeal()
  expect(exits).toEqual([])
  expect(selfHealCalls).toBe(0)

  rmSync(settingsLockPath(dataDir))
  await internal.runResidentSelfHeal()
  expect(selfHealCalls).toBe(1)
  expect(exits).toEqual([0])
})

it('用户主动断开写盘的第一拍就不能夹带上一次已恢复事件', async () => {
  const { daemon, dataDir } = fatalHarness()
  await daemon.run()
  let finishStop: () => void = () => undefined
  const stopPending = new Promise<void>((resolve) => { finishStop = resolve })
  const internal = daemon as typeof daemon & {
    connector: unknown
    recoveryNotice: unknown
    applyIntent(intent: unknown): Promise<void>
  }
  internal.connector = { ...inertConnector(), stop: () => stopPending }
  internal.recoveryNotice = { id: 42, attempts: 2, outageMs: 4_000 }
  const disconnect = internal.applyIntent({ desired: 'user-disconnected', sessionToken: 'disconnect' })
  try {
    await settle()
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
      state: 'user-disconnected'
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).recovery).toBeUndefined()
  } finally {
    finishStop()
    await disconnect
  }
})

it('致命收尾的普通 I/O 异常向崩溃兜底传播，不能 exit 0 冒充新守护接手', async () => {
  const { daemon, exits } = fatalHarness()
  await daemon.run()
  const internal = daemon as typeof daemon & {
    fatalStopped: boolean
    intent: unknown
    restoreAfterFatal(failure: { code: string; message: string }, intent: unknown): Promise<void>
    writeStateNow(state: string, extra?: Record<string, unknown>): void
  }
  internal.fatalStopped = true
  internal.writeStateNow = () => { throw Object.assign(new Error('injected final state EIO'), { code: 'EIO' }) }

  await expect(internal.restoreAfterFatal({ code: 'FATAL_TEST', message: 'fatal' }, internal.intent))
    .rejects.toThrow('injected final state EIO')
  expect(exits).toEqual([])
})

it('致命收尾的锁短暂被占后会补写失败状态，不让旧状态永久残留', async () => {
  const { daemon, exits, clock, dataDir } = fatalHarness()
  await daemon.run()
  const internal = daemon as typeof daemon & {
    fatalStopped: boolean
    intent: unknown
    restoreAfterFatal(failure: { code: string; message: string }, intent: unknown): Promise<void>
    writeStateNow(state: string, extra?: Record<string, unknown>): void
  }
  internal.fatalStopped = true
  const writeStateNow = internal.writeStateNow.bind(internal)
  let busyOnce = true
  internal.writeStateNow = (state, extra) => {
    if (busyOnce && state === 'error') { busyOnce = false; throw new SettingsBusyError('busy') }
    writeStateNow(state, extra)
  }

  const finalization = internal.restoreAfterFatal({ code: 'FATAL_TEST', message: 'fatal' }, internal.intent)
  await settle()

  expect(internal.fatalStopped).toBe(true)
  expect(exits).toEqual([])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).code).not.toBe('FATAL_TEST')

  clock.advance(1_000)
  await finalization
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({
    state: 'error', code: 'FATAL_TEST'
  })
  expect(exits).toEqual([])
})

it('旧守护失去写权时，关停不得无锁覆盖已接手的新守护 connected 状态', async () => {
  const { daemon, exits, dataDir } = fatalHarness()
  await daemon.run()
  const internal = daemon as unknown as { adapter: { acquireWriteRight?: () => unknown } }
  internal.adapter.acquireWriteRight = () => ({ acquired: false, reason: 'held' })
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'new', generation: 1 }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'new', state: 'connected', updatedAt: 1 }))

  daemon.requestShutdown()
  await settle()

  expect(exits).toEqual([0])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it('失去写权又撞设置锁时不改状态，解锁后继续原恢复梯子', async () => {
  const { daemon, clock, dataDir } = fatalHarness()
  await daemon.run()
  const internal = daemon as unknown as {
    adapter: { acquireWriteRight?: () => unknown }
    restoreWithRetryLadder(label: string, options: { checkHandover: boolean }): Promise<unknown>
    settingsBusy: boolean
  }
  let blocked = true
  let acquisitions = 0
  internal.adapter.acquireWriteRight = () => {
    acquisitions += 1
    return blocked ? { acquired: false, reason: 'held' } : { acquired: true, release: () => undefined }
  }
  writeFileSync(settingsLockPath(dataDir), JSON.stringify({ token: 'other-task', pid: process.pid, at: Date.now() }))
  const before = readFileSync(join(dataDir, 'state.json'), 'utf8')

  const recovering = internal.restoreWithRetryLadder('写权冲突后的恢复', { checkHandover: true })
  await settle()
  expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toBe(before)
  expect(internal.settingsBusy).toBe(true)

  rmSync(settingsLockPath(dataDir))
  blocked = false
  clock.advance(1_000)
  expect(await recovering).toBeTruthy()
  expect(acquisitions).toBe(2)
})

it.each(['disconnect', 'authorization'] as const)('%s 恢复交权后新守护接手，旧守护不能写最终状态', async (mode) => {
  const { daemon, dataDir } = fatalHarness()
  if (mode === 'authorization') writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  await daemon.run()
  const internal = daemon as unknown as {
    intent: unknown
    stopConnection(): Promise<void>
    restoreWithRetryLadder(...args: unknown[]): Promise<unknown>
    restoreAfterDisconnect(intent: unknown): Promise<void>
    restoreAfterAuthorization(code: string, intent: unknown): Promise<void>
  }
  const originalRestore = internal.restoreWithRetryLadder.bind(internal)
  internal.restoreWithRetryLadder = async (...args) => {
    const restored = await originalRestore(...args)
    const path = join(dataDir, 'recovery-owner.json')
    let generation = 0
    try { generation = (JSON.parse(readFileSync(path, 'utf8')) as { generation: number }).generation } catch { /* no earlier owner */ }
    writeFileSync(path, JSON.stringify({ runId: 'new', generation: generation + 1 }))
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'new', state: 'connected', updatedAt: 1 }))
    return restored
  }

  if (mode === 'disconnect') await internal.restoreAfterDisconnect(internal.intent)
  else {
    await internal.stopConnection()
    await internal.restoreAfterAuthorization('TUNNEL_AUTHORIZATION_EXPIRED', internal.intent)
  }

  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

function plantSuccessor(dataDir: string): void {
  const path = join(dataDir, 'recovery-owner.json')
  let generation = 0
  try { generation = (JSON.parse(readFileSync(path, 'utf8')) as { generation: number }).generation } catch { /* no earlier owner */ }
  writeFileSync(path, JSON.stringify({ runId: 'new', generation: generation + 1 }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'new', state: 'connected', updatedAt: 1 }))
}

it.each(['disconnect', 'authorization'] as const)('%s 在恢复阶段已交接时旧守护立即退出', async (mode) => {
  const { daemon, exits, dataDir } = fatalHarness()
  await daemon.run()
  plantSuccessor(dataDir)
  const internal = daemon as unknown as {
    intent: unknown
    restoreAfterDisconnect(intent: unknown): Promise<void>
    restoreAfterAuthorization(code: string, intent: unknown): Promise<void>
  }

  if (mode === 'disconnect') await internal.restoreAfterDisconnect(internal.intent)
  else await internal.restoreAfterAuthorization('TUNNEL_AUTHORIZATION_EXPIRED', internal.intent)

  expect(exits).toEqual([0])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it.each(['yield', 'connect-failure'] as const)('%s 交还写权后新守护接手，旧守护不能再写状态', async (mode) => {
  const { daemon, dataDir } = fatalHarness()
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  await daemon.run()
  const internal = daemon as unknown as {
    releaseWriteRight(): void
    contender: unknown
    contenderRestoreSafety(): string
    contenderPathMatches(): boolean
    probeProxy(): Promise<void>
    considerYieldingToContender(): Promise<void>
    handleConnectFailure(error: Error): Promise<void>
  }
  const release = internal.releaseWriteRight.bind(internal)
  let planted = false
  internal.releaseWriteRight = () => {
    release()
    if (!planted) { planted = true; plantSuccessor(dataDir) }
  }
  if (mode === 'yield') {
    internal.contender = { kind: 'http', host: '127.0.0.1', port: 18081 }
    // 本用例只隔离检验「交还写权后的旧回调」；有效系统路径由 yield-to-contender 的平台夹具覆盖。
    internal.contenderRestoreSafety = () => 'safe'
    internal.contenderPathMatches = () => true
    internal.probeProxy = async () => undefined
    await internal.considerYieldingToContender()
  } else await internal.handleConnectFailure(Object.assign(new Error('upstream failed'), { code: 'TUNNEL_UPSTREAM_UNREACHABLE' }))

  expect(planted).toBe(true)
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it('启动恢复梯子交权后新守护接手，旧守护落定回调不得写 idle', async () => {
  const { daemon, dataDir } = fatalHarness()
  writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify([
    { id: 'stale-setting', kind: 'setting', service: 'test', item: 'proxy', originalValue: null,
      writtenValue: DEAD_PROXY, sessionToken: 'old-session', time: 1, status: 'applied', note: '' }
  ])}\n`, { mode: 0o600 })
  const internal = daemon as unknown as { restoreWithRetryLadder(...args: unknown[]): Promise<unknown> }
  const restore = internal.restoreWithRetryLadder.bind(internal)
  internal.restoreWithRetryLadder = async (...args) => {
    const result = await restore(...args)
    plantSuccessor(dataDir)
    return result
  }

  await daemon.run()
  await settle()

  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it.each([['win', createDaemon], ['mac', createMacDaemon]] as const)(
  '%s 普通连接等待 connector 后新守护接手，旧守护不得改设置、账本或 connected 状态', async (_platform, daemonFactory) => {
    const dataDir = makeTempDir('connect-successor-fence-')
    roots.push(dataDir)
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
    let releaseStart: () => void = () => undefined
    const startPending = new Promise<void>((resolve) => { releaseStart = resolve })
    const exits: number[] = []
    const writes: unknown[] = []
    let value: unknown = null
    const daemon = daemonFactory({
      dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
      onExit: (code: number) => { exits.push(code) },
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
        read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next } },
      connectorFactory: () => ({ ...inertConnector(), start: () => startPending }),
      bridgeFactory: inertBridge
    })
    const running = daemon.run()
    await settle()
    withSettingsLock(dataDir, () => plantSuccessor(dataDir), { owner: 'new-claim' })
    value = 'new-proxy'
    releaseStart()
    await running
    await settle()

    expect(exits).toEqual([0])
    expect(writes).toEqual([])
    expect(value).toBe('new-proxy')
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
    expect(readFileSync(join(dataDir, 'ledger.json'), 'utf8')).not.toContain(DEAD_PROXY)
  }
)

it('新守护在旧 owner 状态之后，正常连接仍能认领恢复权并写入自己的设置', async () => {
  const dataDir = makeTempDir('connect-successor-positive-')
  roots.push(dataDir)
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'new', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'old', generation: 1 }))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'old', state: 'error', updatedAt: 1 }))
  const writes: unknown[] = []
  let value: unknown = null
  const daemon = createDaemon({ dataDir, runId: 'new', clock: new FakeClock(), parentAlive: () => true, onExit: () => {},
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next } },
    connectorFactory: inertConnector, bridgeFactory: inertBridge })

  await daemon.run()

  expect(writes).toEqual([DEAD_PROXY])
  expect(JSON.parse(readFileSync(join(dataDir, 'recovery-owner.json'), 'utf8'))).toMatchObject({ runId: 'new', generation: 2 })
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it('无 owner 文件的旧守护在新守护构造后更新 state，不能被误认成新接管而阻止新守护 claim', async () => {
  const dataDir = makeTempDir('legacy-state-baseline-')
  roots.push(dataDir)
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'new', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'old', state: 'error', updatedAt: 1 }))
  const exits: number[] = []
  const writes: unknown[] = []
  let value: unknown = null
  const daemon = createDaemon({ dataDir, runId: 'new', clock: new FakeClock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next } },
    connectorFactory: inertConnector, bridgeFactory: inertBridge })
  // 旧常驻还在收尾；它不会发布代次，这一拍不是「新守护接管」证据。
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'old', state: 'stopped-restored', updatedAt: 2 }))

  await daemon.run()

  expect(exits).toEqual([])
  expect(writes).toEqual([DEAD_PROXY])
  expect(JSON.parse(readFileSync(join(dataDir, 'recovery-owner.json'), 'utf8'))).toMatchObject({ runId: 'new', generation: 1 })
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it('无 generation 的旧 owner 在新守护构造后由同一旧 runId 更新，也不能阻止新守护 claim', async () => {
  const dataDir = makeTempDir('legacy-owner-baseline-')
  roots.push(dataDir)
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'new', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'old', claimedAt: 1 }))
  const exits: number[] = []
  const starts: number[] = []
  const daemon = createDaemon({ dataDir, runId: 'new', clock: new FakeClock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => null, write: () => {} },
    connectorFactory: () => ({ ...inertConnector(), start: async () => { starts.push(1) } }),
    bridgeFactory: inertBridge })
  writeFileSync(join(dataDir, 'recovery-owner.json'), JSON.stringify({ runId: 'old', claimedAt: 2 }))

  await daemon.run()

  expect(exits).toEqual([])
  expect(starts).toEqual([1])
  expect(JSON.parse(readFileSync(join(dataDir, 'recovery-owner.json'), 'utf8'))).toMatchObject({ runId: 'new', generation: 1 })
})

it.each([['win', createDaemon], ['mac', createMacDaemon]] as const)(
  '%s 稳态复验遇到更高 owner 时，不得修回旧代理或覆盖新 connected', async (_platform, daemonFactory) => {
    const dataDir = makeTempDir('reverify-successor-fence-')
    roots.push(dataDir)
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
    const exits: number[] = []
    const writes: unknown[] = []
    let value: unknown = null
    const daemon = daemonFactory({ dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
      onExit: (code: number) => { exits.push(code) },
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
        read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next },
        reapplyOnChange: () => true },
      connectorFactory: inertConnector, bridgeFactory: inertBridge })
    await daemon.run()
    expect(writes).toEqual([DEAD_PROXY])
    withSettingsLock(dataDir, () => plantSuccessor(dataDir), { owner: 'new-claim' })
    value = 'new-proxy'

    await (daemon as unknown as { reverify(): Promise<void> }).reverify()

    expect(exits).toEqual([0])
    expect(writes).toEqual([DEAD_PROXY])
    expect(value).toBe('new-proxy')
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
  }
)

it.each([['win', createDaemon], ['mac', createMacDaemon]] as const)(
  '%s 应用设置后、最终 connected 落盘前被接手，旧状态写入必须再次核对 owner', async (_platform, daemonFactory) => {
    const dataDir = makeTempDir('connect-final-state-fence-')
    roots.push(dataDir)
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
    const exits: number[] = []
    const writes: unknown[] = []
    let value: unknown = null
    const daemon = daemonFactory({ dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
      onExit: (code: number) => { exits.push(code) },
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
        read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next } },
      connectorFactory: inertConnector, bridgeFactory: inertBridge })
    const internal = daemon as unknown as { verifySettings(...args: unknown[]): void }
    const verify = internal.verifySettings.bind(internal)
    internal.verifySettings = (...args) => {
      verify(...args)
      withSettingsLock(dataDir, () => plantSuccessor(dataDir), { owner: 'new-claim' })
      value = 'new-proxy'
    }

    await daemon.run()

    expect(exits).toEqual([0])
    expect(writes).toEqual([DEAD_PROXY])
    expect(value).toBe('new-proxy')
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
  }
)

it('授权停止的最终状态持续锁忙直至重试耗尽时，旧守护必须受控退出而非只记日志', async () => {
  const { daemon, exits, dataDir } = fatalHarness()
  await daemon.run()
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ runId: 'fatal-run', state: 'connected', updatedAt: 1 }))
  const internal = daemon as unknown as {
    restoreWithRetryLadder(): Promise<unknown>
    finalizeAfterRestored(): Promise<void>
    stopForAuthorization(code: string): Promise<void>
  }
  internal.restoreWithRetryLadder = async () => ({ restored: [] })
  internal.finalizeAfterRestored = async () => { throw new SettingsBusyError('final state lock exhausted') }

  await internal.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  await settle()

  expect(exits).toEqual([65])
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ state: 'connected' })
})

it('旧守护进入延迟重连后被新 owner 接手，退避定时器不得修回旧代理', async () => {
  const dataDir = makeTempDir('reconnect-successor-fence-')
  roots.push(dataDir)
  const clock = new FakeClock()
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const exits: number[] = []
  const writes: unknown[] = []
  let value: unknown = null
  const daemon = createDaemon({ dataDir, runId: 'old', clock, random: () => 0, parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value, write: (_ref: unknown, next: unknown) => { writes.push(next); value = next },
      reapplyOnChange: () => true },
    connectorFactory: inertConnector, bridgeFactory: inertBridge })
  await daemon.run()
  const internal = daemon as unknown as { onConnectionLost(error: Error): void }
  internal.onConnectionLost(Object.assign(new Error('upstream lost'), { code: 'TUNNEL_UPSTREAM_UNREACHABLE' }))
  withSettingsLock(dataDir, () => plantSuccessor(dataDir), { owner: 'new-claim' })
  value = 'new-proxy'

  clock.advance(2_000)
  await settle()

  expect(exits).toEqual([0])
  expect(writes).toEqual([DEAD_PROXY])
  expect(value).toBe('new-proxy')
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'new', state: 'connected' })
})

it('bridge 读流量期间新守护接手，旧守护不得覆盖新 traffic.json', async () => {
  const dataDir = makeTempDir('traffic-successor-fence-')
  roots.push(dataDir)
  writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'old', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const exits: number[] = []
  let takeOverOnRead = false
  let value: unknown = null
  const daemon = createDaemon({ dataDir, runId: 'old', clock: new FakeClock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) },
    adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value, write: (_ref: unknown, next: unknown) => { value = next } },
    connectorFactory: inertConnector,
    bridgeFactory: () => ({ ...inertBridge(), traffic: () => {
      const changed = takeOverOnRead
      if (changed) {
        takeOverOnRead = false
        withSettingsLock(dataDir, () => plantSuccessor(dataDir), { owner: 'new-claim' })
        writeFileSync(join(dataDir, 'traffic.json'), JSON.stringify({ uploadBytes: 999, updatedAt: 99 }))
      }
      return { uploadBytes: changed ? 2 : 1, downloadBytes: 1, observedAt: changed ? 20 : 10, activeStreams: 0 }
    } }) })
  await daemon.run()
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ runId: 'old', state: 'connected' })
  takeOverOnRead = true

  ;(daemon as unknown as { refreshTraffic(): void }).refreshTraffic()

  expect(JSON.parse(readFileSync(join(dataDir, 'traffic.json'), 'utf8'))).toMatchObject({ uploadBytes: 999 })
  expect(exits).toEqual([0])
})
