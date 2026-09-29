import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { settingsLockPath } from '../../sidecar/win/ledger.mjs'
import { clearWriteRightOwner } from '../../sidecar/win/write-right-owner.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
const PROXY = '127.0.0.1:18080'

afterEach(() => {
  clearWriteRightOwner(process.pid)
  roots.splice(0).forEach(removeTempDir)
})

async function settle(): Promise<void> {
  await flushMicrotasks()
  await flushMicrotasks()
}

function setup(mode: 'bridge' | 'connector' | 'connector-late-dead' | 'rotation' | 'rotation-release-close' | 'healthy' | 'start-handover' | 'start-reject-handover' | 'late-bridge-death' | 'late-bridge-death-stop-hangs' | 'late-bridge-death-clean-close' | 'late-bridge-death-release-close') {
  const dataDir = makeTempDir('stop-reconnect-hang-')
  roots.push(dataDir)
  const clock = new FakeClock()
  let proxy: unknown = null
  let blockRestore = false
  const writes: unknown[] = []
  let bridgeAlive = true
  let bridgeCount = 0
  let bridgeChecks = 0
  let dieOnCheck = Infinity
  let releaseBridgeClose = () => {}
  let releaseSecondStart = () => {}
  let failSecondStart: (error: Error) => void = () => {}
  let connectorCount = 0
  let connectorStarts = 0
  let bridgeCloses = 0
  let connectorStops = 0
  const stoppedGenerations: number[] = []
  const exits: number[] = []
  const stopsAtExit: number[] = []
  const entries = [1, 2].map((index) => ({ kind: 'vless-reality', node: { host: `entry-${index}.invalid`, port: 443 },
    credentialPath: join(dataDir, `entry-${index}.json`), localPort: 10808, verifyUrl: 'https://verify.invalid/ip' }))
  const intent = (sessionToken: string) => ({ desired: 'connected', sessionToken, bridgePort: 18080,
    connector: mode === 'rotation' || mode === 'rotation-release-close' ? entries[0] : { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' },
    ...(mode === 'rotation' || mode === 'rotation-release-close' ? { connectors: entries, authorization: { id: 'test', expiresAt: 9_999_999 } } : {}) })
  writeIntentFile(dataDir, intent('first'))
  const adapter = {
    managedItems: () => [{ ref: { service: 'WinINET', item: 'ProxyServer' }, value: PROXY }],
    identifyPortOwner: () => bridgeAlive ? { kind: 'laixin', pid: process.pid } : { kind: 'none' },
    read: () => proxy,
    write: (_ref: unknown, next: unknown) => {
      if (blockRestore && next === null) throw new Error('temporary WinINET write failure')
      writes.push(next)
      proxy = next
    }
  }
  const daemon = createDaemon({ dataDir, runId: 'old', clock, random: () => 0, parentAlive: () => true,
    onExit: (code: number) => { exits.push(code); stopsAtExit.push(connectorStops) },
    adapter,
    connectorFactory: () => {
      const generation = ++connectorCount
      return { kind: mode === 'rotation' || mode === 'rotation-release-close' ? 'vless-reality' : 'loopback-probe',
        start: async () => {
          connectorStarts += 1
          if (mode === 'start-handover' && generation === 2) {
            await new Promise<void>((resolve) => { releaseSecondStart = resolve })
          }
          if (mode === 'start-reject-handover' && generation === 2) {
            await new Promise<void>((_resolve, reject) => { failSecondStart = reject })
          }
        },
        stop: () => {
          connectorStops += 1
          stoppedGenerations.push(generation)
          if (mode === 'connector' && connectorCount === 1) {
            bridgeAlive = false
            return new Promise<void>(() => {})
          }
          if (mode === 'connector-late-dead' && connectorCount === 1) {
            clock.setTimeout(() => { bridgeAlive = false }, 500)
            return new Promise<void>(() => {})
          }
          if (mode === 'late-bridge-death-stop-hangs' && connectorCount === 2) {
            return new Promise<void>(() => {})
          }
          return Promise.resolve()
        }, localProxyPort: () => 1, xrayOutbound: () => ({}), onLost: () => {},
        verify: async () => ({ exitIp: '203.0.113.1' }) }
    },
    bridgeFactory: () => {
      const generation = ++bridgeCount
      bridgeAlive = true
      return { listen: async () => {}, close: () => {
        bridgeCloses += 1
        bridgeAlive = false
        if ((mode === 'late-bridge-death-release-close' || mode === 'rotation-release-close') && generation === 1) {
          return new Promise<void>((resolve) => { releaseBridgeClose = resolve })
        }
        return (mode === 'bridge' || mode === 'rotation' || mode === 'late-bridge-death' || mode === 'late-bridge-death-stop-hangs') && generation === 1
          ? new Promise<void>(() => {}) : Promise.resolve()
      }, isAlive: () => {
        if (generation === 1) {
          bridgeChecks += 1
          if (bridgeChecks === dieOnCheck) { bridgeAlive = false; dieOnCheck = Infinity }
        }
        return bridgeAlive
      }, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }
    }
  })
  const state = () => JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { state: string; code?: string; runId?: string }
  return { daemon, clock, dataDir, intent, adapter, proxy: () => proxy, writes, state, exits, stopsAtExit, stoppedGenerations,
    bridgeCloses: () => bridgeCloses, connectorStops: () => connectorStops,
    connectorCount: () => connectorCount, connectorStarts: () => connectorStarts,
    bridgeCount: () => bridgeCount, releaseBridgeClose: () => releaseBridgeClose(),
    releaseSecondStart: () => releaseSecondStart(), failSecondStart: (error: Error) => failSecondStart(error),
    killBridge: () => { bridgeAlive = false },
    dieAfterBridgeChecks: (checks: number) => { dieOnCheck = bridgeChecks + checks },
    blockRestore: (blocked: boolean) => { blockRestore = blocked } }
}

async function startSuccessor(x: ReturnType<typeof setup>): Promise<void> {
  writeIntentFile(x.dataDir, { ...x.intent('successor'), bridgePort: 18081 })
  const successor = createDaemon({ dataDir: x.dataDir, runId: 'new', clock: x.clock,
    parentAlive: () => true, onExit: () => {}, adapter: {
      ...x.adapter,
      managedItems: () => [{ ref: { service: 'WinINET', item: 'ProxyServer' }, value: '127.0.0.1:18081' }]
    },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {},
      verify: async () => ({ exitIp: '203.0.113.1' }) }) })
  await successor.run()
}

it('旧桥已关闭但第三方接管同一代理端口时保留第三方设置', async () => {
  const x = setup('healthy')
  await x.daemon.run()
  x.killBridge()
  x.adapter.identifyPortOwner = () => ({ kind: 'other', pid: process.pid + 1 })
  x.daemon.restoreSettings()
  expect(x.proxy()).toBe(PROXY)
  expect(x.writes).not.toContain(null)
})

it('新 connected 意图等旧桥关闭卡死时先还原死代理，超时后不伪称 connected', async () => {
  const x = setup('bridge')
  await x.daemon.run()
  expect(x.proxy()).toBe(PROXY)
  const next = x.intent('second')
  writeIntentFile(x.dataDir, next)
  void (x.daemon as unknown as { applyIntent(intent: unknown): Promise<void> }).applyIntent(next)
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.proxy()).toBeNull()
  expect(x.state().state).not.toBe('connected')
  x.clock.advance(30_000)
  await settle()
  expect(x.exits).toEqual([65])
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
  expect(x.proxy()).toBeNull()
})

it('普通连接失败等待旧连接器停止卡死时先还原死代理', async () => {
  const x = setup('connector')
  await x.daemon.run()
  expect(x.proxy()).toBe(PROXY)
  void (x.daemon as unknown as { handleConnectFailure(error: Error): Promise<void> }).handleConnectFailure(new Error('upstream failed'))
  await settle()
  expect(x.connectorStops()).toBe(1)
  expect(x.proxy()).toBeNull()
  x.clock.advance(30_000)
  await settle()
  expect(x.exits).toEqual([65])
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
})

it('双入口轮转等待旧桥关闭卡死时先还原死代理，并让重连任务有界结束', async () => {
  const x = setup('rotation')
  await x.daemon.run()
  expect(x.proxy()).toBe(PROXY)
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.proxy()).toBeNull()
  x.clock.advance(30_000)
  await settle()
  expect(x.exits).toEqual([65])
  expect(x.state().code).toBe('TUNNEL_STOP_INCOMPLETE')
  expect((x.daemon as unknown as { reconnectInFlight: boolean }).reconnectInFlight).toBe(false)
})

it('迟死旧桥与新连接器停止均挂起时，代理仍先还原且退出有界', async () => {
  const x = setup('late-bridge-death-stop-hangs')
  await x.daemon.run()
  x.dieAfterBridgeChecks(5)
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.connectorCount()).toBe(2)
  expect(x.bridgeCloses()).toBe(1)
  expect(x.proxy()).toBeNull()
  x.clock.advance(30_000)
  await settle()
  expect(x.stoppedGenerations).toEqual([1, 2])
  expect(x.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(x.exits).toEqual([])
  x.clock.advance(30_000)
  await settle()
  expect(x.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(x.exits).toEqual([65])
  expect(x.stopsAtExit).toEqual([2])
})

it('迟死旧桥能正常关闭时保留已启动的新连接器并继续接通', async () => {
  const x = setup('late-bridge-death-clean-close')
  await x.daemon.run()
  x.dieAfterBridgeChecks(5)
  await (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.connectorCount()).toBe(2)
  expect(x.stoppedGenerations).toEqual([1])
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe(PROXY)
  expect(x.exits).toEqual([])
})

it('迟死旧桥关闭等待中新 runId 已接通，旧任务醒来不得再创建桥覆盖共享配置', async () => {
  const x = setup('late-bridge-death-release-close')
  await x.daemon.run()
  x.dieAfterBridgeChecks(5)
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.bridgeCount()).toBe(1)
  expect(x.proxy()).toBeNull()

  await startSuccessor(x)
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(x.proxy()).toBe('127.0.0.1:18081')

  x.releaseBridgeClose()
  await settle()
  expect(x.bridgeCount()).toBe(1)
  expect(x.proxy()).toBe('127.0.0.1:18081')
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(x.exits).toEqual([0])
})

it('轮转旧桥关闭等待中新 runId 已接通，旧任务醒来不得再启动 SSH 连接器', async () => {
  const x = setup('rotation-release-close')
  await x.daemon.run()
  expect(x.connectorStarts()).toBe(1)
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.proxy()).toBeNull()

  await startSuccessor(x)
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(x.proxy()).toBe('127.0.0.1:18081')
  x.releaseBridgeClose()
  await settle()
  expect(x.connectorStarts()).toBe(1)
  expect(x.bridgeCount()).toBe(1)
  expect(x.proxy()).toBe('127.0.0.1:18081')
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(x.exits).toEqual([0])
})

it('新连接器启动等待中新 runId 接管，旧守护须先停本代连接器再退出', async () => {
  const x = setup('start-handover')
  await x.daemon.run()
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.connectorStarts()).toBe(2)
  expect(x.stoppedGenerations).toEqual([1])
  const ownerPath = join(x.dataDir, 'recovery-owner.json')
  const previousOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { generation: number }
  writeFileSync(ownerPath, JSON.stringify({ runId: 'new', generation: previousOwner.generation + 1 }))
  x.releaseSecondStart()
  await settle()
  expect(x.stoppedGenerations).toEqual([1, 2])
  expect(x.stopsAtExit).toEqual([2])
  expect(x.exits).toEqual([0])
})

it('新连接器启动报错时新 runId 已接管，旧守护退出前仍须停止刚启动的进程', async () => {
  const x = setup('start-reject-handover')
  await x.daemon.run()
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.connectorStarts()).toBe(2)
  const ownerPath = join(x.dataDir, 'recovery-owner.json')
  const previousOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { generation: number }
  writeFileSync(ownerPath, JSON.stringify({ runId: 'new', generation: previousOwner.generation + 1 }))
  x.failSecondStart(new Error('ready timeout'))
  await settle()
  expect(x.stoppedGenerations).toEqual([1, 2])
  expect(x.stopsAtExit).toEqual([2])
  expect(x.exits).toEqual([0])
})

it('旧建立任务醒来时连接器身份已交给新意图，不能关闭后继连接器', async () => {
  const x = setup('healthy')
  await x.daemon.run()
  const internal = x.daemon as unknown as { intent: unknown; reconnectEpoch: number; connector: unknown;
    ensureBridge(intent: unknown, epoch: number, connector: unknown): Promise<void> }
  const oldIntent = internal.intent
  const oldEpoch = internal.reconnectEpoch
  const oldConnector = internal.connector
  let successorStops = 0
  internal.intent = x.intent('successor')
  internal.reconnectEpoch += 1
  internal.connector = { stop: () => { successorStops += 1 } }
  await expect(internal.ensureBridge(oldIntent, oldEpoch, oldConnector)).rejects.toMatchObject({
    code: 'TUNNEL_CONNECTION_CANCELLED'
  })
  expect(successorStops).toBe(0)
  expect(x.bridgeCloses()).toBe(0)
  expect(x.proxy()).toBe(PROXY)
})

it('单入口旧桥已死且关闭卡死时不在 ensureBridge 永久挂住', async () => {
  const x = setup('bridge')
  await x.daemon.run()
  x.killBridge()
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.proxy()).toBeNull()
  x.clock.advance(30_000)
  await settle()
  expect(x.exits).toEqual([65])
  expect((x.daemon as unknown as { reconnectInFlight: boolean }).reconnectInFlight).toBe(false)
})

it('健康桥检查后临建立新连接才死亡，ensureBridge 旧桥关闭卡死仍须先还网并有界结束', async () => {
  const x = setup('late-bridge-death')
  await x.daemon.run()
  x.dieAfterBridgeChecks(5)
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.bridgeCloses()).toBe(1)
  expect(x.connectorCount()).toBe(2)
  expect(x.proxy()).toBeNull()
  x.clock.advance(30_000)
  await settle()
  expect(x.stoppedGenerations).toEqual([1, 2])
  expect(x.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(x.exits).toEqual([65])
  expect(x.stopsAtExit).toEqual([2])
  expect((x.daemon as unknown as { reconnectInFlight: boolean }).reconnectInFlight).toBe(false)
})

it('自动重连等待连接器停止时旧桥稍后死掉，及时还原并有界结束', async () => {
  const x = setup('connector-late-dead')
  await x.daemon.run()
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.proxy()).toBe(PROXY)
  x.clock.advance(500)
  await settle()
  expect(x.proxy()).toBeNull()
  x.clock.advance(29_500)
  await settle()
  expect(x.exits).toEqual([65])
  expect((x.daemon as unknown as { reconnectInFlight: boolean }).reconnectInFlight).toBe(false)
})

it('快速重连的旧连接器停止挂起后用户关停，N41 仍须报停止未完成', async () => {
  const x = setup('connector-late-dead')
  await x.daemon.run()
  void (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  await settle()
  expect(x.connectorStops()).toBe(1)
  x.daemon.requestShutdown()
  await settle()
  expect(x.proxy()).toBeNull()
  expect(x.state().state).not.toBe('stopped-restored')
  x.clock.advance(30_000)
  await settle()
  expect(x.state()).toMatchObject({ state: 'error', code: 'TUNNEL_STOP_INCOMPLETE' })
  expect(x.exits).toEqual([65])
})

it('系统代理写回暂败时旧守护留守补还，再有界重启', async () => {
  const x = setup('bridge')
  await x.daemon.run()
  x.blockRestore(true)
  const next = x.intent('write-fails')
  writeIntentFile(x.dataDir, next)
  void (x.daemon as unknown as { applyIntent(intent: unknown): Promise<void> }).applyIntent(next)
  await settle()
  expect(x.proxy()).toBe(PROXY)
  x.clock.advance(30_000)
  await settle()
  expect(x.exits).toEqual([])
  x.blockRestore(false)
  x.clock.advance(5_000)
  await settle()
  expect(x.proxy()).toBeNull()
  expect(x.exits).toEqual([65])
})

it('旧 connected 重连等待停止时收到新断开意图，旧超时不能抢写新意图的状态', async () => {
  const x = setup('bridge')
  await x.daemon.run()
  const next = x.intent('superseded-connect')
  writeIntentFile(x.dataDir, next)
  void (x.daemon as unknown as { applyIntent(intent: unknown): Promise<void> }).applyIntent(next)
  await settle()
  expect(x.bridgeCloses()).toBe(1)

  x.clock.advance(1_000)
  writeIntentFile(x.dataDir, { desired: 'user-disconnected', sessionToken: 'latest-disconnect' })
  ;(x.daemon as unknown as { tickIntent(): void }).tickIntent()
  await settle()
  expect(x.proxy()).toBeNull()
  expect(x.state().state).toBe('user-disconnected')

  x.clock.advance(29_500) // 旧 connected 的 30 秒看守已到，新断开的看守还没到。
  await settle()
  expect(x.exits).toEqual([])
  expect(x.state().state).toBe('user-disconnected')
})

it('授权停止时旧连接器挂起且桥已关，恢复写回暂败后新连接意图接手补还再接通', async () => {
  const x = setup('connector')
  await x.daemon.run()
  x.blockRestore(true)
  void (x.daemon as unknown as { stopForAuthorization(code: string): Promise<void> }).stopForAuthorization('TUNNEL_AUTHORIZATION_EXPIRED')
  await settle()
  expect(x.connectorStops()).toBe(1)
  expect(x.proxy()).toBe(PROXY)
  expect(x.state().state).not.toBe('connected')

  const next = x.intent('resume-after-old-stop')
  writeIntentFile(x.dataDir, next)
  ;(x.daemon as unknown as { tickIntent(): void }).tickIntent()
  await settle()
  expect(x.proxy()).toBe(PROXY)
  expect(x.state().state).not.toBe('connected')
  x.blockRestore(false)
  x.clock.advance(1_000)
  await settle()
  expect(x.proxy()).toBe(PROXY)
  expect(x.state().state).toBe('connected')
  expect(x.exits).toEqual([])
})

it('旧停止挂起后新 runId 接管成功，旧超时不能清掉新代理或覆盖新状态', async () => {
  const x = setup('bridge')
  await x.daemon.run()
  const next = x.intent('waiting-for-stop')
  writeIntentFile(x.dataDir, next)
  void (x.daemon as unknown as { applyIntent(intent: unknown): Promise<void> }).applyIntent(next)
  await settle()
  expect(x.bridgeCloses()).toBe(1)

  const successorIntent = { ...x.intent('successor'), bridgePort: 18081 }
  writeIntentFile(x.dataDir, successorIntent)
  const successor = createDaemon({ dataDir: x.dataDir, runId: 'new', clock: x.clock,
    parentAlive: () => true, onExit: () => {}, adapter: {
      ...x.adapter,
      managedItems: () => [{ ref: { service: 'WinINET', item: 'ProxyServer' }, value: '127.0.0.1:18081' }]
    },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {},
      verify: async () => ({ exitIp: '203.0.113.1' }) }) })
  await successor.run()
  await settle()
  expect(x.proxy()).toBe('127.0.0.1:18081')
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })

  x.clock.advance(30_000)
  await settle()
  expect(x.proxy()).toBe('127.0.0.1:18081')
  expect(x.state()).toMatchObject({ state: 'connected', runId: 'new' })
  expect(x.exits).toEqual([0])
})

it('首次连接无旧账时设置锁短暂忙，仍走两秒顺延而非关停恢复长梯子', async () => {
  const x = setup('bridge')
  const daemon = x.daemon as typeof x.daemon & { settingsBusy: boolean }
  const realRestore = daemon.restoreSettings.bind(daemon)
  let calls = 0
  daemon.restoreSettings = (options) => {
    calls += 1
    if (calls === 1) { daemon.settingsBusy = true; return undefined }
    daemon.settingsBusy = false
    return realRestore(options)
  }

  await x.daemon.run()
  expect(x.state()).toMatchObject({ state: 'connecting', code: 'TUNNEL_SETTINGS_BUSY' })
  expect(calls).toBe(1)
  x.clock.advance(2_000)
  await settle()
  expect(x.state().state).toBe('connected')
  expect(x.proxy()).toBe(PROXY)
})

it('旧代理账目待还且设置锁暂忙，每次锁等待有界并在释放后补还', async () => {
  const x = setup('healthy')
  await x.daemon.run()
  const internal = x.daemon as unknown as { intent: unknown; reconnectEpoch: number;
    stopAndRestoreForReconnect(stopping: Promise<void>, intent: unknown, epoch: number): Promise<boolean> }
  writeFileSync(settingsLockPath(x.dataDir), JSON.stringify({ token: 'other-task', pid: process.pid, at: Date.now() }))
  const started = performance.now()
  void internal.stopAndRestoreForReconnect(new Promise<void>(() => {}), internal.intent, internal.reconnectEpoch)
  const blockedMs = performance.now() - started
  expect(blockedMs).toBeLessThan(1_000) // 每次短锁等待应是 250ms；不能卡主事件循环 5 秒。
  expect(x.proxy()).toBe(PROXY)
  rmSync(settingsLockPath(x.dataDir))
  x.clock.advance(1_000)
  await settle()
  expect(x.proxy()).toBeNull()
  expect(x.exits).toEqual([])
}, 10_000)

it('单入口桥仍在监听的快速重连只更换连接器，不能撤掉系统代理再重复写入', async () => {
  const x = setup('healthy')
  await x.daemon.run()
  expect(x.writes).toEqual([PROXY])
  await (x.daemon as unknown as { attemptReconnect(): Promise<void> }).attemptReconnect()
  expect(x.state().state).toBe('connected')
  expect(x.bridgeCloses()).toBe(0)
  expect(x.writes).toEqual([PROXY])
})

it('普通失败且旧账已结清时设置锁暂忙，沿用原短路径推进错误态与重连', async () => {
  const x = setup('healthy')
  await x.daemon.run()
  const daemon = x.daemon as typeof x.daemon & { settingsBusy: boolean; handleConnectFailure(error: Error): Promise<void> }
  daemon.restoreSettings()
  expect(x.proxy()).toBeNull()
  const realRestore = daemon.restoreSettings.bind(daemon)
  let calls = 0
  daemon.restoreSettings = (options) => {
    calls += 1
    if (calls === 1) { daemon.settingsBusy = true; return undefined }
    daemon.settingsBusy = false
    return realRestore(options)
  }
  await daemon.handleConnectFailure(new Error('upstream failed'))
  expect(calls).toBe(1)
  expect(x.state().state).toBe('error')
  expect(x.proxy()).toBeNull()
})
