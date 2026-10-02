import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, fakeAdapterEnv, makeTempDir, readFakeStore, readJsonFile, removeTempDir, waitFor, writeIntentFile } from './helpers'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function fixture(apiOnly = false, parentPollMs = 50, exitIp = '203.0.113.1') {
  const dataDir = makeTempDir('api-network-')
  cleanup.push(() => removeTempDir(dataDir))
  const clock = new FakeClock()
  const storePath = `${dataDir}/system.json`
  const starts = vi.fn(async () => undefined), stops = vi.fn(async () => undefined), restrict = vi.fn()
  const probe = vi.fn(async () => ({ proxyUrl: 'http://127.0.0.1:18080', targets: ['api.deepseek.com:443'] }))
  const binding = { port: 43210, bootId: 'a'.repeat(32), pid: 321, identitySecret: 'b'.repeat(64), bridgePort: 18080 }
  const base = { desired: 'connected', updatedAt: 1, sessionToken: 'fixture-session', bridgePort: 18080,
    authorization: { id: 'fixture-authorization', expiresAt: clock.now() + 120_000 },
    connector: { kind: 'loopback-probe', upstream: { host: '127.0.0.1', port: 19000 } } }
  writeIntentFile(dataDir, { ...base, ...(apiOnly ? { apiOnly: binding } : {}) })
  let parentAlive = true
  const exit = vi.fn()
  const logs: string[] = []
  const daemon = createDaemon({ dataDir, clock, adapter: createAdapter(fakeAdapterEnv(storePath)),
    connectorFactory: () => ({ kind: 'loopback-probe', start: starts, stop: stops, localProxyPort: () => 19000,
      onLost: () => undefined, verify: async () => ({ exitIp }) }) as Connector,
    bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, restrict,
      traffic: () => ({ uploadBytes: 123, downloadBytes: 456, observedAt: clock.now() }) }),
    probeApiNetwork: probe, parentAlive: () => parentAlive, onExit: exit, log: line => logs.push(line), intentPollMs: 50, parentPollMs })
  const state = () => readJsonFile<{ state: string; apiOnly?: boolean; pathVerified?: boolean; code?: string }>(`${dataDir}/state.json`)
  return { daemon, clock, dataDir, storePath, starts, stops, restrict, probe, exit, state, logs,
    detach: () => { writeIntentFile(dataDir, { ...base, apiOnly: binding, updatedAt: 2 }); clock.advance(50) },
    writeHandoff: () => { writeIntentFile(dataDir, { ...base, apiOnly: binding, updatedAt: 2 }) },
    parentExit: () => { parentAlive = false; clock.advance(50) },
    parentExitFirst: () => { parentAlive = false; clock.advance(1) },
    reopen: () => { parentAlive = true; writeIntentFile(dataDir, { ...base, updatedAt: 3 }); clock.advance(50) },
    disconnect: () => { writeIntentFile(dataDir, { desired: 'user-disconnected', updatedAt: 4 }); clock.advance(50) } }
}

describe('退出后仅 API 需要的通道延续', () => {
  it('父进程先于意图轮询消失时仍读取已落盘的交接', async () => {
    const f = fixture(false, 1)
    await f.daemon.run()
    f.writeHandoff(); f.parentExitFirst()
    await waitFor(() => f.state().apiOnly === true)
    expect(f.exit).not.toHaveBeenCalled()
    expect(f.stops).not.toHaveBeenCalled()
    f.disconnect()
    await waitFor(() => f.state().state === 'stopped-restored')
  })

  it('后台重新建立连接时仅恢复 API 目标，不重新接管系统设置', async () => {
    const f = fixture(true)
    await f.daemon.run()
    expect(f.state()).toMatchObject({ state: 'connected', apiOnly: true })
    expect(readFakeStore(f.storePath)).toEqual({})
    expect(f.restrict).toHaveBeenCalledWith(['api.deepseek.com:443'])
    f.disconnect()
    await waitFor(() => f.state().state === 'stopped-restored')
  })

  it('交接核验晚到不能覆盖用户较新的断开意图', async () => {
    const f = fixture()
    await f.daemon.run()
    let release!: (value: { proxyUrl: string; targets: string[] }) => void
    f.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    f.detach()
    await waitFor(() => release !== undefined)
    f.disconnect()
    release({ proxyUrl: 'http://127.0.0.1:18080', targets: ['api.deepseek.com:443'] })
    await waitFor(() => f.state().state === 'stopped-restored')
    expect(f.state().apiOnly).toBe(false)
    expect(f.starts).toHaveBeenCalledTimes(1)
    expect(readFakeStore(f.storePath)).toEqual({})
  })

  it('交接与重开保持原连接和无出口 IP 时的连通证明，流量继续记账', async () => {
    const f = fixture(false, 50, '')
    await f.daemon.run()
    expect(readFakeStore(f.storePath)).not.toEqual({})
    f.detach()
    await waitFor(() => f.state().apiOnly === true)
    expect(readFakeStore(f.storePath)).toEqual({})
    expect(f.starts).toHaveBeenCalledTimes(1)
    expect(f.stops).not.toHaveBeenCalled()
    expect(f.restrict).toHaveBeenCalledWith(['api.deepseek.com:443'])
    f.parentExit()
    await waitFor(() => f.probe.mock.calls.length > 0)
    expect(f.exit).not.toHaveBeenCalled()
    f.clock.advance(2_000)
    await waitFor(() => readJsonFile<{ downloadBytes: number }>(`${f.dataDir}/traffic.json`).downloadBytes >= 456)
    f.reopen()
    await waitFor(() => f.state().apiOnly === false && f.state().state === 'connected')
      .catch(() => { throw new Error(JSON.stringify({ state: f.state(), logs: f.logs })) })
    expect(f.state().pathVerified).toBe(true)
    expect(readFakeStore(f.storePath)).not.toEqual({})
    expect(f.starts).toHaveBeenCalledTimes(1)
    expect(f.stops).not.toHaveBeenCalled()
    f.disconnect()
    await waitFor(() => f.state().state === 'stopped-restored')
  })

  it('路由身份失效时关闭延续，不能因父进程退出而留下无限通道', async () => {
    const f = fixture()
    await f.daemon.run(); f.detach()
    await waitFor(() => f.state().apiOnly === true)
    f.probe.mockRejectedValue(new Error('fixture invalid proof'))
    f.parentExit(); f.clock.advance(6_000)
    await waitFor(() => f.exit.mock.calls.length > 0)
    expect(f.stops).toHaveBeenCalled()
    expect(readFakeStore(f.storePath)).toEqual({})
  })

  it('后台 API 不延长授权，显式断开同样停止通道', async () => {
    const f = fixture()
    await f.daemon.run(); f.detach()
    await waitFor(() => f.state().apiOnly === true)
    f.clock.advance(120_000)
    await waitFor(() => f.state().code === 'TUNNEL_AUTHORIZATION_EXPIRED')
    expect(f.stops).toHaveBeenCalled()
    expect(readFakeStore(f.storePath)).toEqual({})
  })
})
