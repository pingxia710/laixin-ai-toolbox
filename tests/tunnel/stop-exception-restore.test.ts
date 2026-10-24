import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

const connectedIntent = {
  desired: 'connected' as const, sessionToken: 'stop-exception-1', bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
}
const clock = () => ({
  now: Date.now,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
  clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
})

function harness(pollMs = 100) {
  vi.useFakeTimers()
  const root = makeTempDir('stop-exception-restore-')
  roots.push(root)
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreFailures = 0
  let closeCalls = 0
  const exits: number[] = []
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer' && value === null && restoreFailures > 0) {
      restoreFailures -= 1
      throw new Error('temporary WinINET write failure')
    }
    base.write(ref, value)
  } }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: clock(), parentAlive: () => true,
    onExit: (code: number) => { exits.push(code) }, intentPollMs: pollMs, parentPollMs: pollMs,
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => { closeCalls += 1; throw Error('bridge close failed') },
      isAlive: () => true, onLost: () => {} }) })
  return {
    root, daemon, exits,
    failNextRestore: (count = 1) => { restoreFailures = count },
    allowRestores: () => { restoreFailures = 0 },
    useExternalProxyWithoutPreserve: () => {
      adapter.preserveExternalChanges = () => false
      base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:7890' })
    },
    closeCalls: () => closeCalls,
    proxy: () => (base.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data ?? null,
    state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code?: string },
    proxyLedger: () => loadLedger(root).filter((entry) => entry.kind === 'setting' && entry.item === 'ProxyServer')
      .map((entry) => 'status' in entry ? entry.status : undefined)
  }
}

it('关停时 bridge.close 抛错且首次代理恢复失败：继续重试还原，才以停止失败退出', async () => {
  const h = harness()
  await h.daemon.run()
  expect(h.proxy()).toBe('127.0.0.1:18080')
  h.failNextRestore()

  ;(h.daemon as unknown as { shutdown: () => void }).shutdown()
  await vi.advanceTimersByTimeAsync(200)
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it('用户断开时 bridge.close 抛错：还原梯子未完成前不能由异常收尾提前退出', async () => {
  const h = harness()
  await h.daemon.run()
  h.failNextRestore()
  writeIntentFile(h.root, { desired: 'user-disconnected', sessionToken: 'disconnect-2' })

  await vi.advanceTimersByTimeAsync(200)
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])
  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it('授权停止旧桥接关闭报错后新连接接手：关停二次报错也须先还原死代理', async () => {
  const h = harness()
  await h.daemon.run()
  h.failNextRestore(2)
  void (h.daemon as unknown as { stopForAuthorization(code: string): Promise<void> }).stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  await vi.advanceTimersByTimeAsync(200)
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])

  writeIntentFile(h.root, { ...connectedIntent, sessionToken: 'new-connection' })
  await vi.advanceTimersByTimeAsync(200)
  expect(h.closeCalls()).toBeGreaterThanOrEqual(2)
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])

  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(h.exits).toEqual([65]) // 旧桥看门狗不得再写回旧设置或重复退出
})

it.each(['shutdown', 'user-disconnected', 'authorization', 'fatal'] as const)(
  '%s 时旧桥关闭失败且恢复梯子耗尽：留守重试到 WinINET 真正还原', async (mode) => {
  const h = harness(1_000_000)
  await h.daemon.run()
  h.failNextRestore(1_000)
  const internal = h.daemon as unknown as {
    shutdown: () => void
    applyIntent: (intent: unknown) => Promise<void>
    stopForAuthorization: (code: string) => Promise<void>
    stopForFatal: (code: string) => Promise<void>
  }
  if (mode === 'shutdown') internal.shutdown()
  else if (mode === 'user-disconnected') {
    const intent = { desired: 'user-disconnected', sessionToken: 'long-stop' }
    writeIntentFile(h.root, intent)
    await internal.applyIntent(intent)
  } else if (mode === 'authorization') void internal.stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  else await internal.stopForFatal('TUNNEL_SETTINGS_CONTEST_STOPPED')

  await vi.advanceTimersByTimeAsync(1_900_000) // 快速 68 秒 + 慢梯子 60×30 秒已耗尽
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.proxy()).toBe('127.0.0.1:18080')
  expect(h.exits).toEqual([])
  h.allowRestores()
  await vi.advanceTimersByTimeAsync(30_001)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})

it('非可保留设置被外部改动后停在 kept-modified，不应无意义无限重试', async () => {
  const h = harness()
  await h.daemon.run()
  h.useExternalProxyWithoutPreserve()
  const internal = h.daemon as unknown as {
    restoreWithRetryLadder: (label: string, options: { stayUntilRestored: boolean }) => Promise<unknown>
  }
  let finished = false
  void internal.restoreWithRetryLadder('外部设置已修改', { stayUntilRestored: true }).then(() => { finished = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.proxy()).toBe('127.0.0.1:7890')
  expect(h.proxyLedger()).toContain('kept-modified')
  expect(finished).toBe(true)
})

it('授权停止时 bridge.close 抛错：仍按账本恢复，再报告停止不完整', async () => {
  const h = harness()
  await h.daemon.run()
  h.failNextRestore()
  const stopping = (h.daemon as unknown as { stopForAuthorization: (code: string) => Promise<void> })
    .stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  await vi.advanceTimersByTimeAsync(200)
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])
  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
  await stopping
})

it('致命连接停止时 bridge.close 抛错：仍按账本恢复，再报告停止不完整', async () => {
  const h = harness()
  await h.daemon.run()
  h.failNextRestore()
  await (h.daemon as unknown as { stopForFatal: (code: string) => Promise<void> })
    .stopForFatal('TUNNEL_SETTINGS_CONTEST_STOPPED')
  await vi.advanceTimersByTimeAsync(200)
  expect(h.proxyLedger()).toContain('restore-failed')
  expect(h.exits).toEqual([])
  await vi.advanceTimersByTimeAsync(1_100)
  expect(h.proxy()).toBeNull()
  expect(h.proxyLedger()).toContain('restored')
  expect(h.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(h.exits).toEqual([65])
})
