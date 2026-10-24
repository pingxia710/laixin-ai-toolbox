// 等锁自旋的「分段让出 + 默认上限」(收拢轮 M10 小改)的钉子:
// ①步进节奏:首秒 10ms 快抢,之后每秒翻倍、100ms 封顶——把机器让给持锁方(拿掉让出 = 退回平转 10ms,这里红);
// ②默认上限 5 秒:自旋冻结的是守护唯一主线程,主进程看流量文件 10 秒不更新就判不可用,20 秒上限等于每次争抢都能卡死十几秒;
// ③整段等待里步进真的分段(次数远少于平转);
// ④真实路径(不注入)照旧:等对方放手后 ~10ms 接住。
// 全部用注入时钟/睡眠,零真实等待;真实子进程只有 ④ 一把 1.5 秒的锁。
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SettingsBusyError, currentProcessStartedAt, readSettingsLock, settingsLockWaitStepMs, settingsLockPath, withSettingsLock } from '../../sidecar/win/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const ledgerUrl = pathToFileURL(join(__dirname, '../../sidecar/win/ledger.mjs')).href
const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('waitFor 超时'); await new Promise((resolve) => setTimeout(resolve, 10)) }
}

it('①步进节奏:首秒 10ms,之后每秒翻倍,100ms 封顶', () => {
  expect(settingsLockWaitStepMs(0)).toBe(10)
  expect(settingsLockWaitStepMs(999)).toBe(10)
  expect(settingsLockWaitStepMs(1_000)).toBe(20)
  expect(settingsLockWaitStepMs(1_999)).toBe(20)
  expect(settingsLockWaitStepMs(2_000)).toBe(40)
  expect(settingsLockWaitStepMs(3_000)).toBe(80)
  expect(settingsLockWaitStepMs(4_000)).toBe(100)
  expect(settingsLockWaitStepMs(60_000)).toBe(100)
})

// 预放一把「持有者活着」的锁(pid 用自己,startedAt 一致 → lockHolderAlive 为真),等锁方在假时钟下等满上限。
function contendedRoot(root: string) {
  writeFileSync(settingsLockPath(root), JSON.stringify({ token: 'other', pid: process.pid, owner: 'hold', at: Date.now(), startedAt: currentProcessStartedAt() }))
}

function waitWithFakeClock(root: string, options: Parameters<typeof withSettingsLock>[2]) {
  const T0 = 1_000_000
  let fake = T0
  const sleeps: number[] = []
  let outcome: 'acquired' | 'busy' = 'acquired'
  try {
    withSettingsLock(root, () => undefined, { ...options, now: () => fake, sleep: (ms) => { fake += ms; sleeps.push(ms) } })
  } catch (error) {
    if (!(error instanceof SettingsBusyError)) throw error
    outcome = 'busy'
  }
  return { outcome, sleeps, waitedFakeMs: fake - T0 }
}

it('②默认上限 5 秒(不传 timeoutMs):假时钟下等满 5 秒抛 SettingsBusyError,⛔ 退回 20 秒', () => {
  const root = makeTempDir('lock-wait-default-')
  try {
    contendedRoot(root)
    const { outcome, sleeps, waitedFakeMs } = waitWithFakeClock(root, { owner: 'test' })
    expect(outcome).toBe('busy')
    expect(waitedFakeMs).toBeGreaterThan(5_000)
    expect(waitedFakeMs).toBeLessThanOrEqual(5_100)
    expect(sleeps.length).toBeLessThanOrEqual(250) // 5 秒平转是 ~500 步,分段让出是 ~200 步
  } finally { removeTempDir(root) }
})

it('③整段等待步进真的分段:形状 10→20→40→80→100,总步数远少于平转(拿掉让出这条红)', () => {
  const root = makeTempDir('lock-wait-shape-')
  try {
    contendedRoot(root)
    const { outcome, sleeps } = waitWithFakeClock(root, { owner: 'test', timeoutMs: 5_000 })
    expect(outcome).toBe('busy')
    expect(sleeps[0]).toBe(10)
    expect(sleeps).toContain(20)
    expect(sleeps).toContain(40)
    expect(sleeps).toContain(80)
    expect(sleeps[sleeps.length - 1]).toBe(100)
    expect(Math.max(...sleeps)).toBe(100)
    expect(sleeps.length).toBeLessThanOrEqual(250)
    // 锁文件没被等锁方动过:破锁协议只对死持有者生效,活持有者的锁原样不动
    expect(readSettingsLock(root)?.holder?.token).toBe('other')
  } finally { removeTempDir(root) }
})

it('④真实路径(不注入)照旧:对方放手后能接住,不必等到超时', async () => {
  const root = makeTempDir('lock-wait-real-')
  const holderScript = `
    import { withSettingsLock } from ${JSON.stringify(ledgerUrl)}
    import { writeFileSync } from 'node:fs'
    withSettingsLock(${JSON.stringify(root)}, () => {
      writeFileSync(${JSON.stringify(join(root, 'held'))}, String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500)
    }, { owner: 'slow-restore' })
  `
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], { stdio: 'ignore' })
  try {
    await waitFor(() => existsSync(join(root, 'held')))
    const startedAt = Date.now()
    expect(withSettingsLock(root, () => 'ran', { owner: 'test' })).toBe('ran')
    expect(Date.now() - startedAt).toBeLessThan(4_000) // 上限 5 秒内等到放手;平转首段 10ms 快抢不变
  } finally { if (holder.exitCode === null) holder.kill('SIGKILL'); removeTempDir(root) }
})
