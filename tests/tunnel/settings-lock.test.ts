// 跨进程设置锁(GPT-6 复核 be04e6a):恢复、应用设置、账本读改写、状态交接不能跨进程重叠。
// ①同进程可重入;②另一进程持锁时本进程等待、超时抛 SettingsBusyError(瞬时,⛔ 致命);
// ③持锁进程异常退出 → 遗留锁被破掉,恢复责任不因等待永久丢失;④两个进程交错写账本,条目一条不丢。
import { afterEach, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SettingsBusyError, SettingsLockLostError, appendSettingEntry, holdsSettingsLock, loadLedger, readSettingsLock, settingsLockPath, takeOverStaleLock, withSettingsLock } from '../../sidecar/win/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const ledgerUrl = pathToFileURL(join(__dirname, '../../sidecar/win/ledger.mjs')).href
const roots: string[] = []
const directory = () => { const root = makeTempDir('settings-lock-'); roots.push(root); return root }
afterEach(() => roots.splice(0).forEach(removeTempDir))

// 子进程拿住锁 holdMs 毫秒(拿到后写 held 标记文件)
function holderProcess(root: string, holdMs: number) {
  const script = `
    import { withSettingsLock } from ${JSON.stringify(ledgerUrl)}
    import { writeFileSync } from 'node:fs'
    withSettingsLock(${JSON.stringify(root)}, () => {
      writeFileSync(${JSON.stringify(join(root, 'held'))}, String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(holdMs)})
    })
  `
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
}
const waitFor = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('waitFor 超时'); await new Promise((resolve) => setTimeout(resolve, 10)) }
}

it('①同进程可重入:嵌套调用不自锁,最外层退出才释放锁文件', () => {
  const root = directory()
  const seen: boolean[] = []
  withSettingsLock(root, () => {
    seen.push(holdsSettingsLock(root))
    withSettingsLock(root, () => { seen.push(holdsSettingsLock(root)); seen.push(existsSync(settingsLockPath(root))) })
    seen.push(holdsSettingsLock(root))
  })
  expect(seen).toEqual([true, true, true, true])
  expect(holdsSettingsLock(root)).toBe(false)
  expect(existsSync(settingsLockPath(root))).toBe(false)
})

it('②另一进程持锁:本进程等待;等不到抛 SettingsBusyError(瞬时错误码)', async () => {
  const root = directory()
  const holder = holderProcess(root, 1_500)
  try {
    await waitFor(() => existsSync(join(root, 'held')))
    const startedAt = Date.now()
    expect(() => withSettingsLock(root, () => 'ran', { timeoutMs: 300 })).toThrowError(SettingsBusyError)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
    // 等对方放手后能拿到
    await waitFor(() => holder.exitCode !== null, 5_000)
    expect(withSettingsLock(root, () => 'ran', { timeoutMs: 300 })).toBe('ran')
  } finally { if (holder.exitCode === null) holder.kill('SIGKILL') }
})

it('③持锁进程异常退出:遗留锁被破掉,后来者不必等到超时', async () => {
  const root = directory()
  const holder = holderProcess(root, 60_000)
  try {
    await waitFor(() => existsSync(join(root, 'held')))
    holder.kill('SIGKILL')
    await waitFor(() => holder.exitCode !== null || holder.signalCode !== null)
    expect(existsSync(settingsLockPath(root))).toBe(true)
    const startedAt = Date.now()
    expect(withSettingsLock(root, () => 'ran', { timeoutMs: 5_000 })).toBe('ran')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(existsSync(settingsLockPath(root))).toBe(false)
  } finally { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL') }
})

it('④两个进程交错追加账目:每条都在,没有被对方的旧快照覆盖', () => {
  const root = directory()
  // 预先放一个持有者 pid 已死的遗留锁,顺带证明破锁后一切照常
  writeFileSync(settingsLockPath(root), JSON.stringify({ token: 'stale', pid: 2 ** 22 + 7, owner: 'dead', at: 0 }))
  const script = (token: string) => `
    import { appendSettingEntry } from ${JSON.stringify(ledgerUrl)}
    for (let index = 0; index < 20; index += 1) {
      appendSettingEntry(${JSON.stringify(root)}, { service: 'S', item: ${JSON.stringify(token)} + index, originalValue: null, writtenValue: 1, sessionToken: ${JSON.stringify(token)}, time: index })
    }
  `
  const a = spawn(process.execPath, ['--input-type=module', '-e', script('a')], { stdio: 'ignore' })
  const b = spawnSync(process.execPath, ['--input-type=module', '-e', script('b')], { stdio: 'ignore' })
  expect(b.status).toBe(0)
  return waitFor(() => a.exitCode !== null, 10_000).then(() => {
    expect(a.exitCode).toBe(0)
    appendSettingEntry(root, { service: 'S', item: 'main', originalValue: null, writtenValue: 1, sessionToken: 'main', time: 0 })
    const items = loadLedger(root).filter((entry) => entry.kind === 'setting').map((entry) => (entry as { item: string }).item)
    expect(items.length).toBe(41)
    expect(new Set(items).size).toBe(41)
    expect(readFileSync(join(root, 'ledger.json'), 'utf8')).toContain('"main"')
  })
})

// GPT-6 复核 c53c636 #1:两个清理者都看到同一把死锁,B 先破锁拿到新锁并开始干活,A 拿着**旧观察**再去清理——
// 必须发现挪走的不是那把死锁,把 B 的锁原样还回去;B 的锁(令牌 + inode)完好,A 只能等 B 放手。
it('⑤两个清理者同时破遗留锁:后到者按旧观察清理,不能删掉先到者刚拿到的新锁', async () => {
  const root = directory()
  writeFileSync(settingsLockPath(root), JSON.stringify({ token: 'stale', pid: 2 ** 22 + 9, owner: 'dead', at: 0 }))
  const observedByA = readSettingsLock(root)
  expect(observedByA?.holder).toMatchObject({ token: 'stale' })
  const holderB = holderProcess(root, 2_500) // B 正常走一遍:破掉死锁、拿到自己的锁、持有 2.5 秒
  try {
    await waitFor(() => existsSync(join(root, 'held')))
    const lockOfB = readSettingsLock(root)
    expect(lockOfB?.holder?.token).not.toBe('stale')
    // A 用旧观察去清理
    expect(takeOverStaleLock(root, observedByA)).toBe(false)
    // B 的锁还在原路径,令牌与 inode 都没变
    const afterA = readSettingsLock(root)
    expect(afterA?.holder?.token).toBe(lockOfB?.holder?.token)
    expect(afterA?.ino).toBe(lockOfB?.ino)
    // A 走正常获取:只能等 B 放手,⛔ 同时进入
    const startedAt = Date.now()
    expect(withSettingsLock(root, () => 'ran', { timeoutMs: 6_000 })).toBe('ran')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000)
  } finally { if (holderB.exitCode === null) holderB.kill('SIGKILL') }
})

it('⑥持锁方自检:锁文件被人换掉后,提交账本抛 SettingsLockLostError(按瞬时错误处理),⛔ 把旧快照写回去', () => {
  const root = directory()
  appendSettingEntry(root, { service: 'S', item: 'before', originalValue: null, writtenValue: 1, sessionToken: 'x', time: 0 })
  expect(() => withSettingsLock(root, () => {
    // 模拟极端交错:别的进程把我们的锁文件换成了它的
    writeFileSync(settingsLockPath(root), JSON.stringify({ token: 'thief', pid: 2 ** 22 + 11, owner: 'other', at: Date.now() }))
    appendSettingEntry(root, { service: 'S', item: 'after', originalValue: null, writtenValue: 1, sessionToken: 'x', time: 1 })
  })).toThrowError(SettingsLockLostError)
  const items = loadLedger(root).filter((entry) => entry.kind === 'setting').map((entry) => (entry as { item: string }).item)
  expect(items).toEqual(['before'])
  // 抛出的也是 SettingsBusyError 的一种,调用方按稍后再试处理
  try { withSettingsLock(root, () => { throw new SettingsLockLostError() }) } catch (error) { expect(error).toBeInstanceOf(SettingsBusyError) }
})

