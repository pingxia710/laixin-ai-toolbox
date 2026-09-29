// N-55 生产链路故障注入：必须经真实 DaemonCore 和组合适配器形成证据，不能只给控制器塞 kind。
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { composeManagedAdapters } from '../../sidecar/win/managed-adapter.mjs'
import { composeManagedAdapters as composeMacManagedAdapters } from '../../sidecar/mac/managed-adapter.mjs'
import type { ManagedNetworkAdapter } from '../../sidecar/win/managed-adapter.mjs'
import { createTerminalEnvironmentAdapter } from '../../sidecar/win/terminal-environment.mjs'
import { createTerminalEnvironmentAdapter as createMacTerminalEnvironmentAdapter } from '../../sidecar/mac/terminal-environment.mjs'
import { ConnectorError, CONTROL_CODES } from '../../sidecar/win/connectors.mjs'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTempDir) })

function root() {
  const value = makeTempDir('n55-production-chain-')
  roots.push(value)
  return value
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    desired: 'connected', sessionToken: 'n55-production', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' },
    ...overrides
  }
}

function connectorFactory() {
  return () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined,
    localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' }) })
}

function daemonState(dataDir: string) {
  return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
    state: string
    code: string
    availability?: { active?: boolean; status?: string; code?: string }
  }
}

function customerState(dataDir: string, state: ReturnType<typeof daemonState>) {
  return computeStatus({ dataDir, daemonState: state, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '' })
}

function composed(network: ManagedNetworkAdapter, identifyPortOwner?: (port: number | undefined) => { kind: string; pid?: number }) {
  return composeManagedAdapters(network, createTerminalEnvironmentAdapter({ enabled: false }), undefined, identifyPortOwner)
}

describe('N-55 Daemon 与适配器生产链路证据', () => {
  it('虚拟 TUN 路径受企业策略锁定：路径证据形成受限结论并抵达客户状态', async () => {
    const dataDir = root()
    writeIntentFile(dataDir, intent())
    const base = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    const network = {
      ...base,
      currentPathIdentity: () => ({ id: 'tun:utun4', kind: 'virtual-tun' }),
      preflight: () => { throw new ConnectorError(CONTROL_CODES.managedPolicy, '组织策略锁定虚拟路径') }
    }
    const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter: composed(network), parentAlive: () => true, onExit: () => undefined,
      connectorFactory: connectorFactory(), bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    }) as unknown as { run(): Promise<void>; availability: { state: { lastAction?: { path?: { id?: string } } } } }

    await daemon.run()
    const state = daemonState(dataDir)
    expect(daemon.availability.state.lastAction).toMatchObject({ path: { id: expect.stringContaining('virtual-tun:tun:utun4') } })
    expect(state).toMatchObject({ state: 'error', availability: { active: true, status: 'limited', code: 'TUNNEL_AVAILABILITY_POLICY_LOCKED' } })
    expect(customerState(dataDir, state)).toMatchObject({ state: '异常', availabilityStatus: 'limited' })
    expect(customerState(dataDir, state).message).toContain('组织策略')
  })

  it('外部 PID 占入口端口：组合适配器身份读数形成外部进程限制，守护不结束 PID', async () => {
    const dataDir = root()
    writeIntentFile(dataDir, intent({ bridgePortCandidates: [18080] }))
    const network = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter: composed(network, () => ({ kind: 'other', pid: 4242 })), parentAlive: () => true, onExit: () => undefined,
      connectorFactory: connectorFactory(),
      bridgeFactory: () => ({ listen: async () => { throw new ConnectorError(CONTROL_CODES.portBusy, 'injected external pid') }, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    }) as unknown as { run(): Promise<void>; availability: { state: { lastAction?: { conflict?: { kind?: string } } } } }

    await daemon.run()
    const state = daemonState(dataDir)
    expect(daemon.availability.state.lastAction).toMatchObject({ conflict: { kind: 'external-process' } })
    expect(state).toMatchObject({ state: 'error', code: CONTROL_CODES.portBusy,
      availability: { active: true, status: 'limited', code: 'TUNNEL_AVAILABILITY_PROCESS_OWNERSHIP_UNPROVEN' } })
    expect(customerState(dataDir, state).message).toContain('没有结束它')
  })

  it('另一份来信占入口端口：组合适配器确认来信身份后形成双实例限制，而非换端口争抢', async () => {
    const dataDir = root()
    writeIntentFile(dataDir, intent({ bridgePortCandidates: [18080, 18180] }))
    const network = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    const listened: number[] = []
    const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter: composed(network, () => ({ kind: 'laixin', pid: 4243 })), parentAlive: () => true, onExit: () => undefined,
      connectorFactory: connectorFactory(),
      bridgeFactory: ({ listenPort }: { listenPort: number | undefined }) => ({ listen: async () => {
        listened.push(listenPort ?? -1)
        throw new ConnectorError(CONTROL_CODES.portBusy, 'injected second laixin')
      }, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    }) as unknown as { run(): Promise<void>; availability: { state: { lastAction?: { conflict?: { kind?: string } } } } }

    await daemon.run()
    const state = daemonState(dataDir)
    expect(listened).toEqual([18080])
    expect(daemon.availability.state.lastAction).toMatchObject({ conflict: { kind: 'laixin-instance' } })
    expect(state).toMatchObject({ state: 'error', code: 'TUNNEL_PEER_LAIXIN_RUNNING',
      availability: { active: true, status: 'limited', code: 'TUNNEL_AVAILABILITY_PEER_LAIXIN_RUNNING' } })
    expect(customerState(dataDir, state).message).toContain('另一份来信')
  })

  it('macOS 组合适配器把本机 lsof/ps 已证实的来信身份交给同一守护裁决，不换候选端口继续争抢', async () => {
    const dataDir = root()
    writeIntentFile(dataDir, intent({ bridgePortCandidates: [18080, 18180] }))
    const network = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    const adapter = composeMacManagedAdapters(network, createMacTerminalEnvironmentAdapter({ enabled: false }), undefined, () => ({ kind: 'laixin', pid: 4244 }))
    const listened: number[] = []
    const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter, parentAlive: () => true, onExit: () => undefined,
      connectorFactory: connectorFactory(),
      bridgeFactory: ({ listenPort }: { listenPort: number | undefined }) => ({ listen: async () => {
        listened.push(listenPort ?? -1)
        throw new ConnectorError(CONTROL_CODES.portBusy, 'injected mac peer')
      }, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })

    await daemon.run()
    expect(listened).toEqual([18080])
    expect(daemonState(dataDir)).toMatchObject({ state: 'error', code: 'TUNNEL_PEER_LAIXIN_RUNNING',
      availability: { active: true, status: 'limited', code: 'TUNNEL_AVAILABILITY_PEER_LAIXIN_RUNNING' } })
  })

  it('守护已记录的历史入口端口被系统代理指向时识别为自身残留，不把它猜成第三方代理复用', async () => {
    const dataDir = root()
    writeIntentFile(dataDir, intent({ bridgePortCandidates: [18080, 18180] }))
    const network = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    network.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' })
    network.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18180' })
    let proxyProbeCalls = 0
    const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter: composed(network), parentAlive: () => true, onExit: () => undefined,
      connectorFactory: connectorFactory(), bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined }),
      probeProxy: async () => { proxyProbeCalls += 1 }
    })

    await daemon.run()
    const state = daemonState(dataDir)
    expect(proxyProbeCalls).toBe(0)
    expect(state).toMatchObject({ state: 'connected' })
    expect(state.code).not.toBe('TUNNEL_REUSED_EXISTING')
  })

  it('Windows/macOS 组合器不把缺失路径能力包装成空读取：跳过直连复用并以快照租约接管', async () => {
    for (const platform of ['win', 'mac'] as const) {
      const dataDir = root()
      writeIntentFile(dataDir, intent({ reuseDirect: true }))
      const base = createAdapter({ FAKE_WININET_STORE: join(dataDir, `${platform}-registry.json`) })
      let writes = 0
      let directProbes = 0
      let connectorStarts = 0
      const network = {
        ...base,
        currentPathIdentity: undefined,
        write: (...args: Parameters<typeof base.write>) => { writes += 1; return base.write(...args) }
      }
      const adapter = platform === 'win'
        ? composed(network)
        : composeMacManagedAdapters(network, createMacTerminalEnvironmentAdapter({ enabled: false }), undefined)
      expect(adapter.currentPathIdentity).toBeUndefined()
      const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter, parentAlive: () => true, onExit: () => undefined,
        connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { connectorStarts += 1 }, stop: async () => undefined,
          localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' }) }),
        bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined }),
        probeDirect: async () => { directProbes += 1 }
      }) as unknown as { run(): Promise<void>; availability: { state: { lastAction?: { action?: string; writes?: number; lease?: { id?: string } } } } }

      await daemon.run()
      expect(directProbes).toBe(0)
      expect(connectorStarts).toBe(1)
      expect(writes).toBeGreaterThan(0)
      expect(daemon.availability.state.lastAction).toMatchObject({ action: 'takeover', writes: expect.any(Number), lease: { id: expect.any(String) } })
      expect(daemonState(dataDir)).toMatchObject({ state: 'connected' })
    }
  })

  it('Windows/macOS 组合器在缺少路由身份时仍以可二次读取的 HTTP 代理端点复用，零写入零本地建链', async () => {
    for (const platform of ['win', 'mac'] as const) {
      const dataDir = root()
      writeIntentFile(dataDir, intent())
      const base = createAdapter({ FAKE_WININET_STORE: join(dataDir, `${platform}-proxy-registry.json`) })
      base.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' })
      base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:7890' })
      base.write({ service: 'WinINET', item: 'DefaultConnectionSettings' }, { type: 'REG_BINARY', data: '460000000000000001000000' })
      let writes = 0
      let proxyProbes = 0
      let connectorStarts = 0
      const network = {
        ...base,
        currentPathIdentity: undefined,
        write: (...args: Parameters<typeof base.write>) => { writes += 1; return base.write(...args) }
      }
      const adapter = platform === 'win'
        ? composed(network)
        : composeMacManagedAdapters(network, createMacTerminalEnvironmentAdapter({ enabled: false }), undefined)
      const daemon = createDaemon({ dataDir, clock: new FakeClock(), adapter, parentAlive: () => true, onExit: () => undefined,
        connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { connectorStarts += 1 }, stop: async () => undefined,
          localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.9' }) }),
        bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined }),
        probeProxy: async () => { proxyProbes += 1 }
      })

      await daemon.run()
      expect(proxyProbes).toBe(1)
      expect(connectorStarts).toBe(0)
      expect(writes).toBe(0)
      expect(daemonState(dataDir)).toMatchObject({ state: 'connected', code: 'TUNNEL_REUSED_EXISTING' })
    }
  })
})
