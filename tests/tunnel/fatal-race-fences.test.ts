// 第三轮复审补强：恢复接管必须证明「在本守护启动之后发生」；所有 bridge 代际关闭必须串行，
// 旧多入口重连不得在新意图已经接管后继续写共享 Xray config/PID 或再建第三代。
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemon as macDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { CONTROL_CODES, ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const DEAD_PROXY = '127.0.0.1:18080'
const roots: string[] = []

afterEach(() => { roots.splice(0).forEach(removeTempDir) })

async function settle(): Promise<void> {
  await flushMicrotasks()
  await flushMicrotasks()
}

function seedInterrupted(dataDir: string): void {
  writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify([
    { id: 'stale-owner-setting', kind: 'setting', service: 'test', item: 'proxy', originalValue: null,
      writtenValue: DEAD_PROXY, sessionToken: 'old-session', time: 1, status: 'applied', note: '' }
  ])}\n`, { mode: 0o600 })
  writeFileSync(join(dataDir, 'state.json'), `${JSON.stringify({ state: 'connected', runId: 'old-run', updatedAt: 1 })}\n`, { mode: 0o600 })
}

it.each([
  ['带 generation 的旧接管令牌', { runId: 'old-run', generation: 41, claimedAt: 1 }],
  ['升级前无 generation 的旧接管令牌', { runId: 'old-run', claimedAt: 1 }]
] as const)('%s：fresh-run 启动恢复先撞锁再立即 shutdown，不能把旧令牌误认成刚发生的交接', async (_label, owner) => {
  const dataDir = makeTempDir('fatal-stale-owner-')
  roots.push(dataDir)
  const clock = new FakeClock()
  let value: unknown = DEAD_PROXY
  const exits: number[] = []
  seedInterrupted(dataDir)
  writeFileSync(join(dataDir, 'recovery-owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 })
  writeIntentFile(dataDir, {
    desired: 'connected', sessionToken: 'fresh-session', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
  })
  const daemon = winDaemon({
    dataDir, runId: 'fresh-run', clock, parentAlive: () => true, onExit: (code: number) => { exits.push(code) },
    adapter: {
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value,
      write: (_ref: unknown, next: unknown) => { value = next }
    },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })
  })
  const realRestore = daemon.restoreSettings.bind(daemon)
  let restoreCalls = 0
  daemon.restoreSettings = (options) => {
    restoreCalls += 1
    if (restoreCalls === 1) { daemon.settingsBusy = true; return undefined }
    daemon.settingsBusy = false
    return realRestore(options)
  }

  await daemon.run()
  expect(value).toBe(DEAD_PROXY)
  daemon.requestShutdown()
  await settle()

  expect(restoreCalls).toBe(2)
  expect(value).toBeNull()
  expect(loadLedger(dataDir).find((entry) => entry.id === 'stale-owner-setting')).toMatchObject({ kind: 'setting', status: 'restored' })
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ state: 'stopped-restored', runId: 'fresh-run' })
  expect(exits).toEqual([0])
})

describe.each([
  ['macOS', macDaemon],
  ['Windows', winDaemon]
] as const)('%s bridge teardown generation fence', (_platform, createDaemon) => {
  it('多入口 rotate 的旧 close 延迟时，新意图只能建第二代；旧重连不得误杀第二代后再建第三代', async () => {
    const dataDir = makeTempDir('fatal-rotate-generation-')
    roots.push(dataDir)
    const clock = new FakeClock()
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    let value: unknown = null
    let bridgeSequence = 0
    let releaseOldClose = () => {}
    let oldCloseEnteredResolve = () => {}
    const oldCloseGate = new Promise<void>((resolve) => { releaseOldClose = resolve })
    const oldCloseEntered = new Promise<void>((resolve) => { oldCloseEnteredResolve = resolve })
    const killedPids: number[] = []
    const lossCallbacks: Array<(error: ConnectorError) => void> = []
    const bridges = new Map<number, { running: boolean }>()
    const entries = [1, 2].map((index) => ({
      kind: 'vless-reality' as const,
      node: { host: `entry-${String(index)}.test.invalid`, port: 443 },
      credentialPath: join(dataDir, `credential-${String(index)}.json`),
      localPort: 10808,
      verifyUrl: 'https://verify.test.invalid/ip'
    }))
    const intent = (sessionToken: string) => ({
      desired: 'connected' as const,
      sessionToken,
      bridgePort: 18080,
      authorization: { id: 'network-access', expiresAt: 9_999_999 },
      connector: entries[0],
      connectors: entries
    })
    writeIntentFile(dataDir, intent('rotate-r1'))

    const currentPid = () => (JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }).pid
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
        kind: 'vless-reality',
        start: async () => {},
        stop: async () => {},
        localProxyPort: () => 1,
        xrayOutbound: () => ({}),
        onLost: (callback: (error: ConnectorError) => void) => { lossCallbacks.push(callback) },
        verify: async () => ({ exitIp: '203.0.113.1' })
      }),
      bridgeFactory: () => {
        const pid = 8_100 + (++bridgeSequence)
        const state = { running: false }
        bridges.set(pid, state)
        const usable = () => state.running && existsSync(pidPath) && currentPid() === pid
        return {
          listen: async () => { writeFileSync(pidPath, `${JSON.stringify({ pid })}\n`); state.running = true },
          close: async () => {
            state.running = false
            if (pid === 8_101) { oldCloseEnteredResolve(); await oldCloseGate }
            if (!existsSync(pidPath)) return
            const victim = currentPid()
            killedPids.push(victim)
            bridges.get(victim)!.running = false
            rmSync(pidPath, { force: true })
          },
          isAlive: usable,
          verify: async () => {
            if (!usable()) throw new Error('stale rotate teardown removed current bridge resources')
            return { exitIp: '203.0.113.1' }
          },
          onLost: () => {}
        }
      }
    })

    await daemon.run()
    expect(currentPid()).toBe(8_101)
    lossCallbacks[0](new ConnectorError(CONTROL_CODES.upstreamUnreachable))
    clock.advance(2_000)
    await oldCloseEntered

    writeIntentFile(dataDir, intent('rotate-r2'))
    clock.advance(100)
    await settle()
    releaseOldClose()
    await settle()
    await expect.poll(() => (JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { intentToken: string }).intentToken)
      .toBe('rotate-r2')

    expect(killedPids).toEqual([8_101])
    expect(bridgeSequence).toBe(2)
    expect(currentPid()).toBe(8_102)
    expect(bridges.get(8_102)?.running).toBe(true)
  })
})

it('bridge teardown 首次拒绝：本轮不得放行新代，后续显式连接可重试旧 teardown 后恢复', async () => {
  const dataDir = makeTempDir('fatal-teardown-retry-')
  roots.push(dataDir)
  const clock = new FakeClock()
  let value: unknown = null
  let bridgeCount = 0
  let closeAttempts = 0
  writeIntentFile(dataDir, {
    desired: 'connected', sessionToken: 'teardown-r1', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
  })
  const daemon = winDaemon({
    dataDir, clock, parentAlive: () => true, onExit: () => {},
    adapter: {
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: DEAD_PROXY }],
      read: () => value,
      write: (_ref: unknown, next: unknown) => { value = next }
    },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => {
      bridgeCount += 1
      let running = false
      return {
        listen: async () => { running = true },
        close: async () => {
          closeAttempts += 1
          if (closeAttempts === 1) throw new Error('temporary runner teardown failure')
          running = false
        },
        isAlive: () => running,
        onLost: () => {}
      }
    }
  })
  const internal = daemon as typeof daemon & { stopConnection(): Promise<void>; connect(): Promise<void> }
  await daemon.run()

  await expect(internal.stopConnection()).rejects.toThrow('temporary runner teardown failure')
  expect(bridgeCount).toBe(1)
  await expect(internal.connect()).resolves.toBeUndefined()

  expect(closeAttempts).toBe(2)
  expect(bridgeCount).toBe(2)
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).state).toBe('connected')
})
