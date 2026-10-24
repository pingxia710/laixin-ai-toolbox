import { afterEach, expect, it } from 'vitest'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, fakeAdapterEnv, flushMicrotasks, makeTempDir, readFakeStore, readJsonFile, removeTempDir, waitFor, writeIntentFile } from './helpers'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function setup(lifetime: number, slowVerify = false, slowStart = false) {
  const dataDir = makeTempDir('laixin-expiry-')
  cleanup.push(() => removeTempDir(dataDir))
  const storePath = `${dataDir}/fake-system.json`
  const clock = new FakeClock()
  const counters = { starts: 0, stops: 0, closes: 0 }
  let lost: ((error: Error) => void) | undefined
  let finishVerify: (() => void) | undefined
  let finishStart: (() => void) | undefined
  const expiresAt = clock.now() + lifetime
  writeIntentFile(dataDir, { desired: 'connected', bridgePort: 18080,
    authorization: { id: 'fixture-authorization', expiresAt },
    connector: { kind: 'ssh-socks', node: { host: 'node.example.invalid', port: 22, sshUser: 'fixture' }, keyPath: '/not-used', knownHostsPath: '/not-used', localPort: 18081, verifyUrl: 'https://example.invalid' }
  })
  const connector = { start: async () => { counters.starts++; if (slowStart) await new Promise<void>((resolve) => { finishStart = resolve }) }, stop: async () => { counters.stops++ },
    localProxyPort: () => 18081, onLost: (call: (error: Error) => void) => { lost = call },
    verify: async () => { if (slowVerify) await new Promise<void>((resolve) => { finishVerify = resolve }); return { exitIp: '203.0.113.5' } }
  } as Connector
  const daemon = createDaemon({ dataDir, clock, adapter: createAdapter(fakeAdapterEnv(storePath)),
    connectorFactory: () => connector,
    bridgeFactory: () => ({ listen: () => undefined, close: () => { counters.closes++ } }),
    parentAlive: () => true, onExit: () => undefined, intentPollMs: 50, verifyIntervalMs: 5000
  })
  const state = () => readJsonFile<{ state: string; code: string }>(`${dataDir}/state.json`)
  return { daemon, clock, counters, dataDir, storePath, state, expiresAt,
    lose: () => lost?.(new Error('fixture lost')), complete: () => finishVerify?.(), completeStart: () => finishStart?.() }
}

it('已连接授权到期后停连接和桥，恢复原设置且不再自动重连', async () => {
  const x = setup(200)
  await x.daemon.run()
  expect(x.state().state).toBe('connected')
  x.clock.advance(200)
  await waitFor(() => x.state().code === 'TUNNEL_AUTHORIZATION_EXPIRED')
  expect(readFakeStore(x.storePath)).toEqual({})
  expect(x.counters.stops).toBeGreaterThan(0)
  expect(x.counters.closes).toBe(1)
  x.lose()
  x.clock.advance(65000)
  await flushMicrotasks()
  expect(x.counters.starts).toBe(1)
  expect(x.state().code).toBe('TUNNEL_AUTHORIZATION_EXPIRED')
})

it('到期配置重启守护也不会开始连接', async () => {
  const x = setup(-1)
  await x.daemon.run()
  expect(x.state().code).toBe('TUNNEL_AUTHORIZATION_EXPIRED')
  expect(x.counters.starts).toBe(0)
})

it('重连等待期间到期，不再发起下一次重连', async () => {
  const x = setup(1000)
  await x.daemon.run()
  x.lose()
  x.clock.advance(1000)
  await waitFor(() => x.state().code === 'TUNNEL_AUTHORIZATION_EXPIRED')
  x.clock.advance(64000)
  await flushMicrotasks()
  expect(x.counters.starts).toBe(1)
  expect(readFakeStore(x.storePath)).toEqual({})
})

it('连接验证跨过到期时间，迟到成功不能写回已连接', async () => {
  const x = setup(200, true)
  const starting = x.daemon.run()
  await flushMicrotasks()
  x.clock.advance(250)
  await flushMicrotasks()
  x.complete()
  await starting
  await waitFor(() => x.state().code === 'TUNNEL_AUTHORIZATION_EXPIRED')
  expect(readFakeStore(x.storePath)).toEqual({})
})

it('真实连接器缺少有效期限时拒绝启动', async () => {
  const x = setup(1000)
  const intent = readJsonFile<Record<string, unknown>>(`${x.dataDir}/intent.json`)
  delete intent.authorization
  writeIntentFile(x.dataDir, intent)
  await x.daemon.run()
  expect(x.state().code).toBe('TUNNEL_AUTHORIZATION_INVALID')
  expect(x.counters.starts).toBe(0)
})

it('启动中到期，迟到建立的连接也会被关闭，不能开启本地桥', async () => {
  const x = setup(200, false, true)
  const starting = x.daemon.run()
  await flushMicrotasks()
  x.clock.advance(250)
  await flushMicrotasks()
  x.completeStart()
  await starting
  expect(x.state().code).toBe('TUNNEL_AUTHORIZATION_EXPIRED')
  expect(x.counters.stops).toBeGreaterThanOrEqual(2)
  expect(x.counters.closes).toBe(0)
  expect(readFakeStore(x.storePath)).toEqual({})
})
