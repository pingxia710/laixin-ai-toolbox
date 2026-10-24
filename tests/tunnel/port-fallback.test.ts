// 场景清单 09-13 · 入口端口被占(18080 是开发者机器上 Tomcat/Jenkins/别的代理常占的口):
// 守护按候选表换下一个能监听的端口,系统代理跟着指向新端口,状态里写明实际端口;全部被占才报「端口占用」。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { ConnectorError, CONTROL_CODES } from '../../sidecar/win/connectors.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

describe('入口端口候选', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-port-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  function run(busy: readonly number[], candidates?: readonly number[], randomPort = 23456) {
    const store = `${dataDir}/registry.json`
    const listened: number[] = []
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'port', bridgePort: 18080,
      ...(candidates ? { bridgePortCandidates: candidates } : {}),
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.5' } })
    const daemon = createDaemon({ dataDir, clock, adapter: createAdapter({ FAKE_WININET_STORE: store }), random: () => 0,
      parentAlive: () => true, onExit: () => undefined,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.5' }) }),
      bridgeFactory: ({ listenPort }: { listenPort: number | undefined }) => ({
        listen: async () => { listened.push(listenPort!); if (busy.includes(listenPort!)) throw new ConnectorError(CONTROL_CODES.portBusy) },
        port: () => (listenPort === 0 ? randomPort : listenPort!),
        close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const view = () => JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8')) as { state: string; code: string; bridgePort?: number }
    const registry = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}) as Record<string, { data: string }>
    return { daemon, listened, view, registry }
  }

  it('18080 被占 → 用 18180;系统代理指向 18180;状态里写明实际端口', async () => {
    const h = run([18080], [18080, 18180, 18280])
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.view().bridgePort).toBe(18180)
    expect(h.listened).toEqual([18080, 18180])
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18180')
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.registry()).toEqual({})
  })

  it('固定候选全部被占 → 兜底 0 = 系统任选空闲口,系统代理指向实际口(硬标准:点了连接就要连上)', async () => {
    const h = run([18080, 18180, 18280], [18080, 18180, 18280, 0])
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.view().bridgePort).toBe(23456)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:23456')
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.registry()).toEqual({})
  })

  it('候选表里没有兜底 0 且全部被占 → 才报「端口占用」,不写系统代理', async () => {
    const h = run([18080, 18180, 18280], [18080, 18180, 18280])
    await h.daemon.run()
    expect(h.view().state).toBe('error')
    expect(h.view().code).toBe(CONTROL_CODES.portBusy)
    expect(h.registry()).toEqual({})
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('没有候选表(老意图)仍按 bridgePort 单口工作', async () => {
    const h = run([])
    await h.daemon.run()
    expect(h.view().state).toBe('connected')
    expect(h.view().bridgePort).toBe(18080)
    expect(h.registry().ProxyServer?.data).toBe('127.0.0.1:18080')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })
})
