import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger, settingsLockPath } from '../../sidecar/win/ledger.mjs'
import { clearWriteRightOwner } from '../../sidecar/win/write-right-owner.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  clearWriteRightOwner(process.pid)
  roots.splice(0).forEach(removeTempDir)
})

const connectedIntent = {
  desired: 'connected' as const, sessionToken: 'stop-hang-1', bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
}
const clock = () => ({
  now: Date.now,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
  clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
})

type StopPart = 'bridge' | 'connector' | 'bridge-reject' | 'connector-reject' | 'connector-reject-later'
type StopMode = 'shutdown' | 'fatal'

function harness(stalled: StopPart, selfHealShouldExit = true, laterConnectorStopsNormally = false) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const root = makeTempDir('stop-hang-restore-')
  roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreFailures = 0
  const exits: number[] = []
  let selfHealCalls = 0
  let stopCalls = 0
  let connectorCount = 0
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer' && value === null && restoreFailures > 0) {
      restoreFailures -= 1
      throw new Error('temporary WinINET write failure')
    }
    base.write(ref, value)
  } }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, runId: 'old-run', adapter, clock: clock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) }, intentPollMs: 100, parentPollMs: 100,
    residentSelfHeal: () => { selfHealCalls += 1; return { shouldExit: selfHealShouldExit } },
    connectorFactory: () => {
      const generation = ++connectorCount
      return { kind: 'loopback-probe', start: async () => {},
        stop: () => {
          stopCalls += 1
          if (generation > 1 && laterConnectorStopsNormally) return Promise.resolve()
          return stalled === 'connector' ? new Promise<void>(() => {})
            : stalled === 'connector-reject' ? Promise.reject(new Error('connector stop rejected'))
              : stalled === 'connector-reject-later' ? new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('connector stop rejected')), 10)
              }) : Promise.resolve()
        },
        localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }
    },
    bridgeFactory: () => ({ listen: async () => {},
      close: () => stalled === 'bridge' ? new Promise<void>(() => {})
        : stalled === 'bridge-reject' ? Promise.reject(new Error('bridge close rejected')) : Promise.resolve(),
      isAlive: () => true, onLost: () => {} }) })
  return {
    root, daemon, exits, selfHealCalls: () => selfHealCalls, stopCalls: () => stopCalls,
    failNextRestore: () => { restoreFailures = 1 },
    proxy: () => (base.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data ?? null,
    state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { runId: string; state: string; code?: string },
    proxyLedger: () => loadLedger(root).filter((entry) => entry.kind === 'setting' && entry.item === 'ProxyServer')
      .map((entry) => 'status' in entry ? entry.status : undefined),
    plantSuccessor: () => {
      writeFileSync(join(root, 'recovery-owner.json'), JSON.stringify({ runId: 'new-run', generation: 2 }))
      writeFileSync(join(root, 'state.json'), JSON.stringify({ runId: 'new-run', state: 'connected', updatedAt: Date.now() }))
      base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:19090' })
    }
  }
}

function stop(daemon: ReturnType<typeof createDaemon>, mode: StopMode): void {
  const internal = daemon as unknown as { shutdown: () => void; stopForFatal: (code: string) => Promise<void> }
  if (mode === 'shutdown') internal.shutdown()
  else void internal.stopForFatal('TUNNEL_SETTINGS_CONTEST_STOPPED')
}

it.each([
  ['shutdown', 'bridge'], ['shutdown', 'connector'], ['fatal', 'bridge'], ['fatal', 'connector']
] as const)('%s 的 %s 停止永久挂起：先还代理，停止未确认时有界报错重启', async (mode, stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  expect(h.proxy()).toBe('127.0.0.1:18080')

  stop(h.daemon, mode)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state().state).not.toBe('stopped-restored')
  expect(h.state().code).not.toBe('TUNNEL_SETTINGS_CONTEST_STOPPED')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['shutdown', 'fatal'] as const)('%s 停止挂起且首次代理恢复失败：还账成功前不能退出', async (mode) => {
  const h = harness('connector')
  await h.daemon.run()
  h.failNextRestore()
  stop(h.daemon, mode)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.exits).toEqual([])
  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['shutdown', 'fatal'] as const)('%s 停止挂起期间新守护接手：旧轮不得覆盖新连接', async (mode) => {
  const h = harness('connector')
  await h.daemon.run()
  stop(h.daemon, mode)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  h.plantSuccessor()

  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ runId: 'new-run', state: 'connected' })
  expect(h.proxy()).toBe('127.0.0.1:19090')
  expect(h.exits).toEqual([0])
})

it('fatal 旧桥停止挂起且同进程收到新连接意图：有界重启完成收尾', async () => {
  const h = harness('bridge')
  await h.daemon.run()
  stop(h.daemon, 'fatal')
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()

  writeIntentFile(h.root, { ...connectedIntent, sessionToken: 'next-connection' })
  await vi.advanceTimersByTimeAsync(100)
  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['bridge', 'connector'] as const)('fatal 的 %s 停止挂起后收到 shutdown：二次停止不能冒充旧停止完成', async (stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  stop(h.daemon, 'fatal')
  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.state().state).not.toBe('stopped-restored')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['bridge-reject', 'connector-reject'] as const)('fatal 的 %s 停止拒绝后收到 shutdown：不能写停止成功', async (stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  stop(h.daemon, 'fatal')
  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each([
  ['authorization', 'connector'], ['authorization', 'connector-reject-later'],
  ['disconnect', 'connector'], ['disconnect', 'connector-reject-later']
] as const)('%s 的 %s 已摘走后收到 shutdown：仍须核对旧停止结果', async (entry, stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  const internal = h.daemon as unknown as {
    stopForAuthorization: (code: string) => Promise<void>
    applyIntent: (intent: { desired: 'user-disconnected'; sessionToken: string }) => Promise<void>
  }
  if (entry === 'authorization') void internal.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  else void internal.applyIntent({ desired: 'user-disconnected', sessionToken: 'stop-before-shutdown' })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.stopCalls()).toBe(1)
  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.state().state).not.toBe('stopped-restored')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(stalled === 'connector' ? 30_100 : 100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['connector', 'connector-reject-later'] as const)('重连的 stopConnectorOnly %s 已摘走后收到 shutdown：不能误报停止成功', async (stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  const reconnect = (h.daemon as unknown as { attemptReconnect: () => Promise<void> }).attemptReconnect()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.stopCalls()).toBe(1)
  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.state().state).not.toBe('stopped-restored')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(stalled === 'connector' ? 30_100 : 100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
  if (stalled === 'connector-reject-later') await reconnect
})

it('旧 connector.stop 已拒绝且离开未决集合：shutdown 仍保留失败结论', async () => {
  const h = harness('connector-reject')
  await h.daemon.run()
  const internal = h.daemon as unknown as {
    stopConnectorOnly: () => Promise<void>
    pendingConnectorStops: Set<Promise<boolean>>
  }
  await internal.stopConnectorOnly().catch(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(internal.pendingConnectorStops.size).toBe(0)
  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each([
  ['fatal', 'connector'], ['authorization', 'connector'], ['disconnect', 'connector'], ['resident', 'connector'],
  ['fatal', 'connector-reject-later'], ['authorization', 'connector-reject-later'],
  ['disconnect', 'connector-reject-later'], ['resident', 'connector-reject-later']
] as const)('重连后 %s 遇旧 %s：最终停止状态不能冒充成功', async (entry, stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  const internal = h.daemon as unknown as {
    stopConnectorOnly: () => Promise<void>
    stopForFatal: (code: string) => Promise<void>
    stopForAuthorization: (code: string) => Promise<void>
    applyIntent: (intent: { desired: 'user-disconnected'; sessionToken: string }) => Promise<void>
    runResidentSelfHeal: () => Promise<void>
  }
  void internal.stopConnectorOnly().catch(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.stopCalls()).toBe(1)
  if (entry === 'fatal') void internal.stopForFatal('TUNNEL_SETTINGS_CONTEST_STOPPED')
  else if (entry === 'authorization') void internal.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  else if (entry === 'disconnect') {
    const intent = { desired: 'user-disconnected' as const, sessionToken: 'old-stop-pending' }
    writeIntentFile(h.root, intent)
    void internal.applyIntent(intent)
  }
  else void internal.runResidentSelfHeal()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(stalled === 'connector' ? 30_100 : 100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([entry === 'resident' ? 0 : 65])
})

it('断开后旧 connector.stop 永久挂起：新连接意图仍可建立并保持连通', async () => {
  const h = harness('connector')
  await h.daemon.run()
  const internal = h.daemon as unknown as {
    applyIntent: (intent: { desired: 'user-disconnected'; sessionToken: string }) => Promise<void>
  }
  void internal.applyIntent({ desired: 'user-disconnected', sessionToken: 'old-disconnect' })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  writeIntentFile(h.root, { ...connectedIntent, sessionToken: 'new-connection' })

  await vi.advanceTimersByTimeAsync(200)
  expect(h.state().state).toBe('connected')
  expect(h.proxy()).toBe('127.0.0.1:18080')
  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state().state).toBe('connected')
  expect(h.exits).toEqual([])
})

it('旧 connector 停止挂起后新连接成功：shutdown 仍关闭新连接并记旧停止未完成', async () => {
  const h = harness('connector', true, true)
  await h.daemon.run()
  const internal = h.daemon as unknown as {
    applyIntent: (intent: { desired: 'user-disconnected'; sessionToken: string }) => Promise<void>
  }
  void internal.applyIntent({ desired: 'user-disconnected', sessionToken: 'old-disconnect' })
  await vi.advanceTimersByTimeAsync(0)
  writeIntentFile(h.root, { ...connectedIntent, sessionToken: 'new-connection' })
  await vi.advanceTimersByTimeAsync(200)
  expect(h.state().state).toBe('connected')

  h.daemon.requestShutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.stopCalls()).toBe(2)
  expect(h.proxy()).toBeNull()
  expect(h.state().state).not.toBe('stopped-restored')
  await vi.advanceTimersByTimeAsync(30_100)
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it.each(['bridge', 'connector'] as const)('常驻自救的 %s 停止永久挂起：先还代理，超时标记失败后撤常驻', async (stalled) => {
  const h = harness(stalled)
  await h.daemon.run()
  const selfHeal = (h.daemon as unknown as { runResidentSelfHeal: () => Promise<void> }).runResidentSelfHeal()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.exits).toEqual([])
  expect(h.selfHealCalls()).toBe(0)

  await vi.advanceTimersByTimeAsync(30_100)
  await selfHeal
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.selfHealCalls()).toBe(1)
  expect(h.exits).toEqual([0])
})

it('常驻自救 bridge.close 抛错：原代理已还，但停止未确认仍为错误态', async () => {
  const h = harness('bridge-reject')
  await h.daemon.run()
  await (h.daemon as unknown as { runResidentSelfHeal: () => Promise<void> }).runResidentSelfHeal()
  expect(h.proxy()).toBeNull()
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([0])
})

it('常驻自救停止挂起且恢复首轮失败：恢复前不得撤常驻或退出', async () => {
  const h = harness('connector')
  await h.daemon.run()
  h.failNextRestore()
  const selfHeal = (h.daemon as unknown as { runResidentSelfHeal: () => Promise<void> }).runResidentSelfHeal()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.selfHealCalls()).toBe(0)
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.selfHealCalls()).toBe(0)
  await vi.advanceTimersByTimeAsync(30_100)
  await selfHeal
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([0])
})

it('常驻自救设置锁忙后下一轮恢复：不能遗忘旧停止仍挂起', async () => {
  const h = harness('connector')
  await h.daemon.run()
  const internal = h.daemon as unknown as { runResidentSelfHeal: () => Promise<void> }
  writeFileSync(settingsLockPath(h.root), JSON.stringify({ token: 'other-task', pid: process.pid, at: Date.now() }))
  await internal.runResidentSelfHeal()
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.selfHealCalls()).toBe(0)
  expect(h.exits).toEqual([])

  rmSync(settingsLockPath(h.root))
  const second = internal.runResidentSelfHeal()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBeNull()
  expect(h.selfHealCalls()).toBe(0)
  await vi.advanceTimersByTimeAsync(30_100)
  await second
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([0])
})

it('常驻自救遇损坏账本：保留原 callback 的留守处理', async () => {
  const h = harness('connector', false)
  await h.daemon.run()
  writeFileSync(join(h.root, 'ledger.json'), '{broken')
  const internal = h.daemon as unknown as { runResidentSelfHeal: () => Promise<void> }
  const selfHeal = internal.runResidentSelfHeal()
  await vi.advanceTimersByTimeAsync(30_100)
  await selfHeal
  expect(h.selfHealCalls()).toBe(1)
  expect(h.exits).toEqual([])
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_RESIDENT_SELF_HEAL' })
})
