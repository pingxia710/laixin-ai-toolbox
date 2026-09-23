// 第 3 条故障注入:断开/授权到期路径 restoreSettings() 失败一次就放弃——本机中继已关,
// 系统代理还指着那个死端口 = 整机断网,且 intent 已非 connected,之后没有任何自动恢复。
// shutdown() 为同一场景早有完整重试梯子(快速 1/2/5/10/20/30 秒 + 慢速 30 秒×60 轮),
// 断开与到期路径却一次失败直接 return。修复:两条路径复用同一套梯子与「暂时性失败」判据
// (设置锁被占或写失败 → 重试;kept-modified 是定论 → 不空等)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger, pendingSettingEntries } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

const directory = () => { const root = makeTempDir('disconnect-retry-'); roots.push(root); return root }
type Base = ReturnType<typeof createAdapter>
const readState = (root: string): { state: string; code?: string } =>
  JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
const proxyServer = (base: Base) => (base.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data
const proxyEnable = (base: Base) => (base.read({ service: 'WinINET', item: 'ProxyEnable' }) as { data?: string } | null)?.data

const connectedIntent = {
  desired: 'connected' as const, sessionToken: 'connect-1', bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
}
const connector = () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
  localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) })
const bridge = () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })

// 真定时器外壳:梯子的等待走 daemon 的 clock.setTimeout,由 vi 虚拟时钟推进
function fakeWallClock() {
  return {
    now: Date.now,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
  }
}

/** ledger.json 直写(测试种子):saveLedger 要求持锁,种子场景直接落盘。 */
function seedLedger(root: string, entries: unknown[]): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'ledger.json'), `${JSON.stringify(entries, null, 1)}\n`, { mode: 0o600 })
}

it('断开后恢复写失败:按梯子重试,故障解除后原设置实际还回、销账、状态如实走到 stopped-restored(基线:一次失败永久卡死)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreBlocked = false
  let restoreWriteAttempts = 0
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') restoreWriteAttempts += 1
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  await daemon.run()
  expect(proxyServer(base)).toBe('127.0.0.1:18080') // 正向证据:连接确实把代理写下去了,恢复才有责任可还

  restoreWriteAttempts = 0 // 计数只算恢复阶段(连接那一次写不计入)
  restoreBlocked = true
  writeIntentFile(root, { desired: 'user-disconnected' as const, sessionToken: 'stop-1' })
  await vi.advanceTimersByTimeAsync(500)
  // 第一轮恢复被注入故障挡下:状态如实上报未恢复,⛔ 谎称 stopped-restored
  expect(readState(root).state).toBe('error')
  expect(readState(root).code).toBe('TUNNEL_RESTORE_INCOMPLETE')

  restoreBlocked = false
  // 梯子第一格是 1 秒:不满 1 秒不许重试(节奏钉死),满 1 秒后重试成功
  await vi.advanceTimersByTimeAsync(999)
  expect(readState(root).state).toBe('error')
  await vi.advanceTimersByTimeAsync(200)
  expect(readState(root).state).toBe('stopped-restored')
  expect(restoreWriteAttempts).toBe(2)
  expect(proxyServer(base) ?? null).toBe(null)
  expect(pendingSettingEntries(root)).toEqual([])
})

it('kept-modified(第三方改过,责任已了结)不挡恢复收尾:首轮即走人,梯子不空等(护栏,基线即绿)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  // 第三方改过、所有权已释放的账目:适配器把它结成 preserved 终态——恢复流程不重试它,
  // 它也不能把断开收尾拖进任何等待(这正是「暂时性失败才重试」判据的反向一格)。
  seedLedger(root, [
    { id: 'w-seed-1', kind: 'setting', service: 'WinINET', item: 'ProxyServer',
      originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      sessionToken: 'other-session', time: 1, status: 'kept-modified', note: '外部软件改成了新值' }
  ])
  const adapter = { ...base }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  await daemon.run()
  writeIntentFile(root, { desired: 'user-disconnected' as const, sessionToken: 'stop-2' })
  await vi.advanceTimersByTimeAsync(500)
  expect(readState(root).state).toBe('stopped-restored')
  // 只推进一步也不翻烧饼:没有暂时性失败,梯子根本不该启动
  await vi.advanceTimersByTimeAsync(150_000)
  expect(readState(root).state).toBe('stopped-restored')
  expect(pendingSettingEntries(root)).toEqual([])
})

it('授权到期停止后恢复失败:同样按梯子重试,还完后写真实到期原因(基线:卡在恢复未完成,代理裸奔、连死因都不上报)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreBlocked = false
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  const intent = { ...connectedIntent, authorization: { id: 'auth-1', expiresAt: Date.now() + 5_000 } }
  writeIntentFile(root, intent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  await daemon.run()
  expect(proxyServer(base)).toBe('127.0.0.1:18080')

  restoreBlocked = true
  await vi.advanceTimersByTimeAsync(6_000) // 越过授权期限 → tickAuthorization 触发停止;首轮恢复被注入故障挡下
  expect(readState(root).state).toBe('error')
  // 裸奔窗口证据:被挡下的那条(ProxyServer)还原不回去,系统代理还指着已关闭的中继端口
  expect(proxyServer(base)).toBe('127.0.0.1:18080')
  restoreBlocked = false
  await vi.advanceTimersByTimeAsync(2_000) // 梯子 1 秒后重试成功
  const state = readState(root)
  expect(state.state).toBe('error')
  expect(state.code).toBe('TUNNEL_AUTHORIZATION_EXPIRED')
  expect(proxyServer(base) ?? null).toBe(null)
  expect(proxyEnable(base) ?? null).not.toBe('1')
  expect(pendingSettingEntries(root)).toEqual([])
})

it('断开恢复梯子等待中客户重新点连接:新连接写下的 ProxyServer ⛔ 被醒来后的恢复删掉(甲-2 返工,基线:删掉约 29 秒)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreBlocked = false
  const proxyOps: string[] = []
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') proxyOps.push(value === null ? 'delete' : 'write')
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge, intentPollMs: 100 })
  await daemon.run()
  expect(proxyServer(base)).toBe('127.0.0.1:18080') // 正向证据:连接确实写下了代理

  // 客户点断开:第一轮恢复被注入故障挡下,梯子进入 1 秒等待
  restoreBlocked = true
  writeIntentFile(root, { desired: 'user-disconnected' as const, sessionToken: 'stop-r1' })
  await vi.advanceTimersByTimeAsync(500)
  expect(readState(root).state).toBe('error')
  expect(proxyOps).toEqual(['write', 'delete']) // 连接写一次;断开首轮恢复的删除被挡下

  // 等待中客户改主意重新点连接:连接先还掉旧账(delete)再写下新代理(write)
  restoreBlocked = false
  writeIntentFile(root, { ...connectedIntent, sessionToken: 'connect-r2' })
  await vi.advanceTimersByTimeAsync(100)
  expect(readState(root).state).toBe('connected')
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  expect(proxyServer(base)).toBe('127.0.0.1:18080')

  await vi.advanceTimersByTimeAsync(499) // t=1099:梯子还在睡
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  await vi.advanceTimersByTimeAsync(2) // t=1101:梯子刚醒——意图已换人,⛔ 把新代理当旧账还一遍
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  expect(readState(root).state).toBe('connected')

  await vi.advanceTimersByTimeAsync(30_000) // 越过一个复验周期:没有任何补删/补写
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  expect(readState(root).state).toBe('connected')
  expect(proxyServer(base)).toBe('127.0.0.1:18080')
  // 新连接自己的账目仍然在生效(⛔ 被醒来的恢复结算掉);旧账已在重连时还清
  const ledger = loadLedger(root) as Array<{ sessionToken: string; item: string; status: string }>
  expect(ledger.find((entry) => entry.sessionToken === 'connect-r2' && entry.item === 'ProxyServer')?.status).toBe('applied')
  expect(ledger.find((entry) => entry.sessionToken === 'connect-1' && entry.item === 'ProxyServer')?.status).toBe('restored')
})

it('授权梯子等待中客户续费重连:新连接写下的 ProxyServer ⛔ 被醒来后的恢复删掉(甲-2 返工,同一梯子同修)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  let restoreBlocked = false
  const proxyOps: string[] = []
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') proxyOps.push(value === null ? 'delete' : 'write')
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  const intent = { ...connectedIntent, sessionToken: 'auth-r1', authorization: { id: 'auth-1', expiresAt: Date.now() + 5_000 } }
  writeIntentFile(root, intent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge, intentPollMs: 100 })
  await daemon.run()
  expect(proxyServer(base)).toBe('127.0.0.1:18080')

  // 授权到期停止;首轮恢复被注入故障挡下,梯子进入 1 秒等待
  restoreBlocked = true
  await vi.advanceTimersByTimeAsync(5_100)
  expect(readState(root).state).toBe('error')
  expect(proxyOps).toEqual(['write', 'delete'])

  // 等待中客户续费重连(新意图 = 新会话):连接先还掉旧账再写下新代理
  restoreBlocked = false
  writeIntentFile(root, { ...connectedIntent, sessionToken: 'auth-r2', authorization: { id: 'auth-2', expiresAt: Date.now() + 60_000 } })
  await vi.advanceTimersByTimeAsync(200)
  expect(readState(root).state).toBe('connected')
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])

  await vi.advanceTimersByTimeAsync(699) // 梯子还在睡(停止发生在 t≈5100,醒来在 t≈6100)
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  await vi.advanceTimersByTimeAsync(2) // 梯子刚醒——意图对象已换人,⛔ 把新代理当旧账还一遍
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  expect(readState(root).state).toBe('connected')

  await vi.advanceTimersByTimeAsync(30_000)
  expect(proxyOps).toEqual(['write', 'delete', 'delete', 'write'])
  expect(readState(root).state).toBe('connected')
  expect(proxyServer(base)).toBe('127.0.0.1:18080')
  // 新连接自己的账目仍然在生效(⛔ 被醒来的恢复结算掉);旧账已在重连时还清
  const ledger = loadLedger(root) as Array<{ sessionToken: string; item: string; status: string }>
  expect(ledger.find((entry) => entry.sessionToken === 'auth-r2' && entry.item === 'ProxyServer')?.status).toBe('applied')
  expect(ledger.find((entry) => entry.sessionToken === 'auth-r1' && entry.item === 'ProxyServer')?.status).toBe('restored')
})

it('梯子忙等分支:设置锁被占(settingsBusy)按 1s/2s 节奏重试,锁释放后最终恢复成功(单元级)', async () => {
  // 为什么是单元级:settings.lock 被占时 recordIntent 与 restoreSettings 同锁,外端到端注入会先撞
  // recordIntent 忙、被 applyIntent 的 crash 兜底劫持成 shutdown 路径——按结果断言区分不了梯子,
  // 基线上反而会「碰巧绿」(假绿风险)。忙等分支以单元级钉死节奏与判据,集成真相由上面两条 e2e 扛。
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const daemon = createDaemon({ dataDir: root, adapter: base, clock: fakeWallClock(), parentAlive: () => true,
    onExit: () => {}, connectorFactory: connector, bridgeFactory: bridge })
  const attempts: number[] = []
  daemon.restoreSettings = () => {
    attempts.push(attempts.length + 1)
    if (attempts.length < 3) {
      daemon.settingsBusy = true // 前两次:设置锁被另一恢复任务占用
      return undefined
    }
    daemon.settingsBusy = false // 第三次:锁释放,恢复成功
    return { restored: [], keptModified: [], failed: [] }
  }
  const pending = daemon.restoreWithRetryLadder('忙等注入')
  await vi.advanceTimersByTimeAsync(1_000) // 快速梯子第一格
  await vi.advanceTimersByTimeAsync(2_000) // 第二格,第三次尝试成功
  const recovered = await pending
  expect(attempts).toEqual([1, 2, 3])
  expect(recovered).toBeTruthy()
})
