// 甲-2 故障注入:守护启动恢复(run() 开头)遇暂时性写失败——基线是裸调一次 restoreSettings(),
// 失败即置 recoveryBlocked 等客户显式点「重试恢复原设置」,无人值守窗口(重启后守护被系统拉起、
// 客户根本没开界面)就永远断网。修复:启动恢复复用断开/授权到期/退出同款的恢复重试梯子。
// 判据:暂时性失败(写失败 restore-failed / 锁被占 settingsBusy)按梯子重试;kept-modified 是定论不空等。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger } from '../../sidecar/win/ledger.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

type LedgerEntry = { id: string; status: string }
const entryStatus = (root: string, id: string): string | undefined =>
  (loadLedger(root) as LedgerEntry[]).find((entry) => entry.id === id)?.status

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

const directory = () => { const root = makeTempDir('boot-restore-retry-'); roots.push(root); return root }
const readState = (root: string): { state: string; code?: string } =>
  JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))

const connectedIntent = {
  desired: 'connected' as const, sessionToken: 'boot-connect-1', bridgePort: 18080,
  connector: { kind: 'loopback-probe' as const, host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' }
}
const connector = () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
  localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) })
const bridge = () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} })

function fakeWallClock() {
  return {
    now: Date.now,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
  }
}

/** 种子一笔「上次写下去还没还回」的设置账目 + 系统里现值就是我们写的值(重启前的中断现场)。 */
function seedInterrupted(root: string): void {
  writeFileSync(join(root, 'ledger.json'), `${JSON.stringify([
    { id: 'w-boot-1', kind: 'setting', service: 'WinINET', item: 'ProxyServer',
      originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' },
      sessionToken: 'previous-session', time: 1, status: 'applied', note: '' }
  ], null, 1)}\n`, { mode: 0o600 })
}

it('启动恢复遇暂时性写失败:按梯子自动重试,恢复成功后照常接续连接;梯子落定前 ⛔ 连接(甲-2,基线:一次失败永久卡死)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  seedInterrupted(root)
  // 系统里现值确实是上次写下去的值(客户重启后代理指着死端口)
  base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
  let restoreBlocked = true // 恢复第一格必被注入故障挡下(杀软锁注册表的形状)
  const proxyOps: string[] = [] // ProxyServer 的每次写动作:恢复是删(originalValue null),连接是写
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') proxyOps.push(value === null ? 'delete' : 'write')
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  const running = daemon.run()
  await vi.advanceTimersByTimeAsync(0)
  // 梯子第一格落定前:如实报恢复未完成,且 ⛔ 抢着连接(系统代理还是上次的死值,还没还)
  expect(readState(root).state).toBe('error')
  expect(readState(root).code).toBe('TUNNEL_RESTORE_INCOMPLETE')
  expect(proxyOps).toEqual(['delete']) // 首轮恢复的删除被故障挡下

  restoreBlocked = false
  // 梯子第一格是 1 秒:不满不许重试(节奏钉死),满 1 秒重试成功、随后接续连接
  await vi.advanceTimersByTimeAsync(999)
  expect(proxyOps).toEqual(['delete'])
  await vi.advanceTimersByTimeAsync(200)
  await running
  expect(proxyOps).toEqual(['delete', 'delete', 'write']) // 重试还回 → 连接重新写下(行为证据,⛔ 返回值)
  expect(readState(root).state).toBe('connected')
  expect(entryStatus(root, 'w-boot-1')).toBe('restored') // 种子账目真还掉了(连接自己新记的账目仍在生效,不在此断言)
})

it('启动梯子等待中客户点了连接:连接写下的 ProxyServer ⛔ 被梯子醒来当旧账再删一遍(甲-2 返工,基线:删掉约 29 秒)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  seedInterrupted(root)
  // 系统里现值确实是上次写下去的值(重启后的中断现场)
  base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
  let restoreBlocked = true // 恢复第一格必被注入故障挡下
  const proxyOps: Array<{ op: string; at: number }> = [] // ProxyServer 每次写动作(delete=恢复/write=连接)+ 虚拟时刻
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') proxyOps.push({ op: value === null ? 'delete' : 'write', at: Date.now() })
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  // 开机时客户还没点连接(意图 user-disconnected);梯子第一格等待中客户点连接,intentPollMs=100 接住
  writeIntentFile(root, { desired: 'user-disconnected' as const, sessionToken: 'boot-idle-1' })
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge, intentPollMs: 100 })
  const running = daemon.run()
  await vi.advanceTimersByTimeAsync(0)
  // 第一格被故障挡下:如实报恢复未完成,梯子进 1 秒等待
  expect(readState(root).state).toBe('error')
  expect(readState(root).code).toBe('TUNNEL_RESTORE_INCOMPLETE')
  expect(proxyOps.map(({ op }) => op)).toEqual(['delete'])

  restoreBlocked = false
  writeIntentFile(root, connectedIntent) // 第 100ms 客户点连接
  await vi.advanceTimersByTimeAsync(150)
  // 连接先还原旧账再写下新代理;客户要的连接已经在了
  expect(readState(root).state).toBe('connected')
  expect(proxyOps.map(({ op }) => op)).toEqual(['delete', 'delete', 'write'])

  await vi.advanceTimersByTimeAsync(849) // t=999:梯子还在睡,什么都没动
  expect(proxyOps.map(({ op }) => op)).toEqual(['delete', 'delete', 'write'])
  await vi.advanceTimersByTimeAsync(2) // t=1001:梯子刚醒——意图已换人,⛔ 再执行 restore
  expect(proxyOps.map(({ op }) => op)).toEqual(['delete', 'delete', 'write'])

  await vi.advanceTimersByTimeAsync(30_000) // t=31001:越过一个复验周期,确认没有任何补删/补写
  await running
  // 验收线:连上之后到用例结束,ProxyServer 没有任何 delete;state 全程保持 connected
  expect(proxyOps.map(({ op }) => op)).toEqual(['delete', 'delete', 'write'])
  expect(readState(root).state).toBe('connected')
  expect(entryStatus(root, 'w-boot-1')).toBe('restored') // 旧账在连接时已还清
  // 新连接自己的账目必须仍然在生效(⛔ 被梯子结算掉)
  const ledger = loadLedger(root) as Array<{ sessionToken: string; item: string; status: string }>
  expect(ledger.find((entry) => entry.sessionToken === 'boot-connect-1' && entry.item === 'ProxyServer')?.status).toBe('applied')
})

it('启动梯子慢速段等待中客户点了连接:连接写下的 ProxyServer ⛔ 被醒来当旧账删掉(甲-2 返工补格,摘掉慢速段复查必红)', async () => {
  // 慢速段才有真实时间窗:故障压满整个快速梯子(1/2/5/10/20/30 秒共 6 格)后进入 30 秒一轮的慢速段,
  // 客户在慢速段的等待里点连接——验收线:连上之后 ProxyServer 零 delete、state 保持 connected。
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  seedInterrupted(root)
  base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
  let restoreBlocked = true
  const proxyOps: Array<{ op: string; at: number }> = []
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (ref.item === 'ProxyServer') proxyOps.push({ op: value === null ? 'delete' : 'write', at: Date.now() })
    if (restoreBlocked && ref.item === 'ProxyServer') throw Error('temporary registry lock')
    base.write(ref, value)
  } }
  writeIntentFile(root, { desired: 'user-disconnected' as const, sessionToken: 'boot-idle-slow' })
  const daemon = createDaemon({ dataDir: root, adapter, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge, intentPollMs: 20 })
  const running = daemon.run()
  // 快速梯子 6 格全部被故障压下(每格醒来一次删除尝试):t=0/1/3/8/18/38/68 秒共 7 次尝试
  for (const delay of [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]) {
    await vi.advanceTimersByTimeAsync(delay)
    expect(readState(root).code).toBe('TUNNEL_RESTORE_INCOMPLETE')
  }
  expect(proxyOps.filter(({ op }) => op === 'delete').length).toBe(7)
  // 慢速段第 1 轮(t=98 秒醒来):故障仍在,尝试仍败——客户点连接发生在这之后的等待里
  await vi.advanceTimersByTimeAsync(30_000)
  expect(proxyOps.filter(({ op }) => op === 'delete').length).toBe(8)

  restoreBlocked = false
  writeIntentFile(root, connectedIntent) // 慢速段等待中客户点连接(轮询 20ms 接住)
  await vi.advanceTimersByTimeAsync(100)
  expect(readState(root).state).toBe('connected')
  expect(proxyOps.map(({ op }) => op)).toEqual([...Array(9).fill('delete'), 'write']) // 连接先还旧账再写下新代理

  await vi.advanceTimersByTimeAsync(30_000) // t≈128 秒:慢速段第 2 轮醒来——意图已换人,⛔ 再执行恢复
  expect(proxyOps.map(({ op }) => op)).toEqual([...Array(9).fill('delete'), 'write'])
  expect(readState(root).state).toBe('connected')

  await vi.advanceTimersByTimeAsync(30_000) // 越过一个复验周期:没有任何补删/补写
  await running
  expect(proxyOps.map(({ op }) => op)).toEqual([...Array(9).fill('delete'), 'write'])
  expect(readState(root).state).toBe('connected')
  expect(entryStatus(root, 'w-boot-1')).toBe('restored')
  const ledger = loadLedger(root) as Array<{ sessionToken: string; item: string; status: string }>
  expect(ledger.find((entry) => entry.sessionToken === 'boot-connect-1' && entry.item === 'ProxyServer')?.status).toBe('applied')
})

it('启动恢复:kept-modified(第三方改过)是定论,梯子不空转、直接按意图接续(护栏)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  writeFileSync(join(root, 'ledger.json'), `${JSON.stringify([
    { id: 'w-boot-2', kind: 'setting', service: 'WinINET', item: 'ProxyServer',
      originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' },
      sessionToken: 'other-session', time: 1, status: 'kept-modified', note: '外部软件改成了新值' }
  ], null, 1)}\n`, { mode: 0o600 })
  base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:7890' })
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter: base, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  // 一格梯子时间都不推就要求落定:没有暂时性失败,梯子根本不该启动
  await daemon.run()
  await vi.advanceTimersByTimeAsync(0) // 让梯子的落定回调把接续连接跑完(后台梯子,⛔ 堵住 run 返回)
  expect(readState(root).state).toBe('connected')
  expect(entryStatus(root, 'w-boot-2')).toBe('preserved')
})

it('启动恢复遇锁被占(settingsBusy):按梯子节奏重试,锁释放后恢复并接续(单元级注入,甲-2)', async () => {
  vi.useFakeTimers()
  const root = directory()
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  seedInterrupted(root)
  base.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: '127.0.0.1:18080' })
  writeIntentFile(root, connectedIntent)
  const daemon = createDaemon({ dataDir: root, adapter: base, clock: fakeWallClock(), parentAlive: () => true, onExit: () => {},
    connectorFactory: connector, bridgeFactory: bridge })
  // settings.lock 被另一进程占着的形状:restoreSettings 前两轮 settingsBusy,第三轮锁释放
  const realRestore = daemon.restoreSettings.bind(daemon)
  let calls = 0
  daemon.restoreSettings = (...args: unknown[]) => {
    calls += 1
    if (calls < 3) { daemon.settingsBusy = true; return undefined }
    daemon.settingsBusy = false
    return realRestore(...(args as []))
  }
  const running = daemon.run()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(1) // 首轮即被占
  await vi.advanceTimersByTimeAsync(1_000) // 梯子第一格
  expect(calls).toBe(2)
  await vi.advanceTimersByTimeAsync(2_000) // 第二格,第三轮锁释放
  await running
  expect(calls).toBe(4) // 梯子 3 次(占、占、成了) + 恢复完成后 connect() 自带的恢复复查 1 次
  expect(readState(root).state).toBe('connected')
  expect(entryStatus(root, 'w-boot-1')).toBe('restored')
})
