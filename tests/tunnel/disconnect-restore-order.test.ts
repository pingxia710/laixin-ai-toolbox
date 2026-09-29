import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { clearWriteRightOwner } from '../../sidecar/win/write-right-owner.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  clearWriteRightOwner(process.pid)
  roots.splice(0).forEach(removeTempDir)
})

function setup(failure: 'write' | 'readback', stallClose = false) {
  vi.useFakeTimers()
  const root = makeTempDir('disconnect-restore-order-')
  roots.push(root)
  const refs = [
    { service: 'WinINET', item: 'ProxyServer' },
    { service: 'Environment', item: 'http_proxy' },
    { service: 'CMD', item: 'AutoRun' },
    { service: 'Shell', item: 'bashrc' }
  ]
  const values = new Map<string, unknown>()
  const key = (ref: { service: string; item: string }) => `${ref.service}/${ref.item}`
  let blocked = false
  let connectorAlive = false
  let bridgeAlive = false
  const closes: string[] = []
  const exits: number[] = []
  const initial = { desired: 'connected', sessionToken: 'initial', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
  writeIntentFile(root, initial)
  const adapter = {
    identifyPortOwner: () => bridgeAlive ? { kind: 'laixin', pid: process.pid } : { kind: 'none' },
    managedItems: () => refs.map((ref) => ({ ref, value: '127.0.0.1:18080' })),
    read: (ref: typeof refs[number]) => values.get(key(ref)) ?? null,
    write: (ref: typeof refs[number], value: unknown) => {
      if (blocked && ref.service === 'WinINET' && value === null) {
        if (failure === 'write') throw new Error('temporary write failure')
        return // 写调用成功但读回仍是旧值。
      }
      values.set(key(ref), value)
    }
  }
  const options = { dataDir: root, adapter, parentAlive: () => true,
    clock: { now: Date.now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
      clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout) },
    onExit: (code: number) => { exits.push(code) },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { connectorAlive = true },
      stop: async () => { closes.push('connector'); connectorAlive = false },
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => { bridgeAlive = true },
      close: async () => {
        closes.push('bridge'); bridgeAlive = false
        if (stallClose) await new Promise<void>(() => {})
      }, isAlive: () => bridgeAlive, onLost: () => {} }) }
  const daemon = createDaemon(options)
  return { root, daemon, initial, closes, exits, refs, adapter,
    alive: () => connectorAlive && bridgeAlive,
    restart: () => createDaemon({ ...options, runId: 'successor' }).run(),
    block: (value: boolean) => { blocked = value },
    state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code?: string } }
}

it.each(['write', 'readback'] as const)('主动断开 %s 暂败：四层还原确认前保留活通道，成功后自动落定', async (failure) => {
  const x = setup(failure)
  await x.daemon.run()
  expect(x.alive()).toBe(true)
  x.block(true)
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop' })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(x.adapter.read(x.refs[0])).toBe('127.0.0.1:18080')
  expect(x.closes).toEqual([])
  expect(x.alive()).toBe(true)
  expect(x.state().code).toBe('TUNNEL_RESTORE_INCOMPLETE')
  expect(x.exits).toEqual([])
  x.block(false)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(x.refs.map(x.adapter.read)).toEqual([null, null, null, null])
  expect(x.closes.sort()).toEqual(['bridge', 'connector'])
  expect(x.alive()).toBe(false)
  expect(x.state()).toMatchObject({ state: 'stopped-restored' })
  expect(x.exits).toEqual([])
})

it('设置已还原但旧桥停止卡死，重启守护后按原断开意图收敛而不重新连接', async () => {
  const x = setup('write', true)
  await x.daemon.run()
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop' })
  await vi.advanceTimersByTimeAsync(31_000)
  expect(x.refs.map(x.adapter.read)).toEqual([null, null, null, null])
  expect(x.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(x.exits).toEqual([65])
  await x.restart()
  expect(x.state()).toMatchObject({ state: 'stopped-restored', intentToken: 'stop' })
  expect(x.alive()).toBe(false)
})

it('恢复等待期间客户重新连接，旧断开恢复任务不能停止新通道或覆盖新状态', async () => {
  const x = setup('write')
  await x.daemon.run()
  x.block(true)
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop' })
  await vi.advanceTimersByTimeAsync(500)
  x.block(false)
  writeIntentFile(x.root, { ...x.initial, sessionToken: 'resume' })
  await vi.advanceTimersByTimeAsync(500)
  expect(x.state().state).toBe('connected')
  const closes = x.closes.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(x.state().state).toBe('connected')
  expect(x.alive()).toBe(true)
  expect(x.closes).toHaveLength(closes)
  expect(x.exits).toEqual([])
})

it('断开恢复等待不能延长原授权：到期仍停通道，继续还原并收敛到已断开', async () => {
  const x = setup('write')
  writeIntentFile(x.root, { ...x.initial, authorization: { id: 'trial', expiresAt: Date.now() + 2_000 } })
  await x.daemon.run()
  x.block(true)
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(x.alive()).toBe(true)
  // 连续点击断开也不能丢失原连接的授权期限。
  writeIntentFile(x.root, { desired: 'user-disconnected', sessionToken: 'stop-again' })
  await vi.advanceTimersByTimeAsync(1_500)
  expect(x.alive()).toBe(false)
  expect(x.exits).toEqual([])
  x.block(false)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(x.refs.map(x.adapter.read)).toEqual([null, null, null, null])
  expect(x.state()).toMatchObject({ state: 'stopped-restored' })
})
