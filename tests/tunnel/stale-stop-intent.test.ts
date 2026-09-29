import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

function setup({ stallBridgeClose = false } = {}) {
  vi.useFakeTimers()
  const root = makeTempDir('laixin-stale-stop-')
  roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreBlocked = false
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (restoreBlocked && ref.item === 'ProxyServer') throw new Error('temporary WinINET lock')
    base.write(ref, value)
  } }
  const initial = { desired: 'connected', sessionToken: 'old-connection', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
  writeIntentFile(root, initial)
  let finishOldStop: (() => void) | undefined
  let stops = 0
  let bridgeCloses = 0
  let exitCode: number | undefined
  const daemon = createDaemon({ dataDir: root, adapter,
    clock: { now: Date.now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 30_000 ? 200 : ms) as unknown as number,
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
      clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout) },
    parentAlive: () => true, onExit: (code: number) => { exitCode = code }, intentPollMs: 50,
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: () => ++stops === 1
      ? new Promise<void>((resolve) => { finishOldStop = resolve }) : Promise.resolve(),
    localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: () => stallBridgeClose && ++bridgeCloses === 1
      ? new Promise<void>(() => {}) : Promise.resolve(), isAlive: () => true, onLost: () => {} }) })
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code?: string }
  const proxy = () => (adapter.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data ?? null
  return { root, daemon, initial, state, proxy, release: () => finishOldStop?.(), exitCode: () => exitCode,
    blockRestore: (blocked: boolean) => { restoreBlocked = blocked } }
}

it('旧授权停止落定后不能还原新授权已经接通的代理', async () => {
  const x = setup()
  const daemon = x.daemon as unknown as { stopForAuthorization: (code: string) => Promise<void>; applyIntent: (intent: unknown) => Promise<void> }
  await x.daemon.run()
  expect(x.proxy()).toBe('127.0.0.1:18080')
  const oldStop = daemon.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  const next = { ...x.initial, sessionToken: 'new-connection', authorization: { id: 'new-authorization', expiresAt: Date.now() + 60_000 } }
  writeIntentFile(x.root, next)
  await daemon.applyIntent(next)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  x.release()
  await oldStop
  await vi.advanceTimersByTimeAsync(0)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  expect(x.exitCode()).toBeUndefined()
})

it('重复断开中的旧停止超时不能杀掉后来已接通的新连接', async () => {
  const x = setup()
  const daemon = x.daemon as unknown as { tickIntent: () => void }
  await x.daemon.run()
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop-one' })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(50)
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop-two' })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  const next = { ...x.initial, sessionToken: 'new-connection' }
  writeIntentFile(x.root, next)
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  await vi.advanceTimersByTimeAsync(250)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  expect(x.exitCode()).toBeUndefined()
  x.release()
  await vi.advanceTimersByTimeAsync(0)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  expect(x.exitCode()).toBeUndefined()
})

it('单次断开停止缓慢时也接纳客户随后发出的新连接意图', async () => {
  const x = setup()
  const daemon = x.daemon as unknown as { tickIntent: () => void }
  await x.daemon.run()
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'slow-stop' })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  const next = { ...x.initial, sessionToken: 'resume-after-stop' }
  writeIntentFile(x.root, next)
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  await vi.advanceTimersByTimeAsync(250)
  expect(x.state().state).toBe('connected')
  expect(x.exitCode()).toBeUndefined()
  x.release()
  await vi.advanceTimersByTimeAsync(0)
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe('127.0.0.1:18080')
  expect(x.exitCode()).toBeUndefined()
})

it('旧桥接停止卡死且新连接正在等旧收尾时有界重启守护', async () => {
  const x = setup({ stallBridgeClose: true })
  const daemon = x.daemon as unknown as { tickIntent: () => void }
  await x.daemon.run()
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stuck-bridge' })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  x.release()
  await vi.advanceTimersByTimeAsync(0)
  expect(x.proxy()).toBeNull()
  const next = { ...x.initial, sessionToken: 'waiting-for-bridge' }
  writeIntentFile(x.root, next)
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(250)
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
  expect(x.exitCode()).toBe(65)
  expect(x.proxy()).toBeNull()
})

it('授权停止遇旧桥接卡死时先还原代理再有界重启以接纳新连接', async () => {
  const x = setup({ stallBridgeClose: true })
  const daemon = x.daemon as unknown as { stopForAuthorization: (code: string) => Promise<void>; tickIntent: () => void }
  await x.daemon.run()
  void daemon.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  await vi.advanceTimersByTimeAsync(0)
  expect(x.proxy()).toBeNull()
  x.release()
  const next = { ...x.initial, sessionToken: 'authorized-resume', authorization: { id: 'new-authorization', expiresAt: Date.now() + 60_000 } }
  writeIntentFile(x.root, next)
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(250)
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
  expect(x.exitCode()).toBe(65)
  expect(x.proxy()).toBeNull()
})

it.each(['user-disconnected', 'authorization'] as const)('%s 恢复暂败后新连接仍被旧桥卡住时有界修复', async (mode) => {
  const x = setup({ stallBridgeClose: true })
  const daemon = x.daemon as unknown as { stopForAuthorization: (code: string) => Promise<void>; tickIntent: () => void }
  await x.daemon.run()
  x.blockRestore(true)
  if (mode === 'authorization') void daemon.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  else {
    writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'restore-first-fails' })
    daemon.tickIntent()
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(x.proxy()).toBe('127.0.0.1:18080')
  x.blockRestore(false)
  x.release()
  writeIntentFile(x.root, { ...x.initial, sessionToken: 'new-after-restore-failure',
    authorization: { id: 'new-authorization', expiresAt: Date.now() + 60_000 } })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(250)
  expect(x.exitCode()).toBe(65)
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
  expect(x.proxy()).toBeNull()
})

it('旧桥卡死且系统设置持续写失败时不能退出并丢掉还原责任', async () => {
  const x = setup({ stallBridgeClose: true })
  const daemon = x.daemon as unknown as { tickIntent: () => void }
  await x.daemon.run()
  x.blockRestore(true)
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'restore-still-failing' })
  daemon.tickIntent()
  await vi.advanceTimersByTimeAsync(250)
  expect(x.exitCode()).toBeUndefined()
  expect(x.proxy()).toBe('127.0.0.1:18080')
  x.blockRestore(false)
  await vi.advanceTimersByTimeAsync(5_100)
  expect(x.exitCode()).toBe(65)
  expect(x.proxy()).toBeNull()
})
