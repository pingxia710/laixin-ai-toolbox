// 守护单实例锁（常驻前置）：同一数据目录只准一个守护。
// 常驻之后系统会在崩溃后把守护拉起来，主进程也可能同时 spawn 一个——两个并存时后起的那个
// run() 第一件事就是按账本还原，会把客户此刻正在用的代理还掉。这把锁就是防这一幕。
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireInstanceLock, instanceLockPath, readInstanceLock, takeOverStaleInstanceLock } from '../../sidecar/win/instance-lock.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const lockUrl = pathToFileURL(join(__dirname, '../../sidecar/win/instance-lock.mjs')).href
const roots: string[] = []
const directory = () => { const root = makeTempDir('instance-lock-'); roots.push(root); return root }
afterEach(() => roots.splice(0).forEach(removeTempDir))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) { if (Date.now() > deadline) throw new Error('等待超时'); await sleep(20) }
}

// 子进程占住席位，直到被杀
function holderProcess(root: string) {
  const script = `
    import { acquireInstanceLock } from ${JSON.stringify(lockUrl)}
    import { writeFileSync } from 'node:fs'
    const outcome = acquireInstanceLock(${JSON.stringify(root)}, { runId: 'holder' })
    writeFileSync(${JSON.stringify(join(root, 'held'))}, JSON.stringify({ acquired: outcome.acquired, pid: process.pid }))
    if (outcome.acquired) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  `
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
}

describe('守护单实例锁', () => {
  it('第一个抢到席位；释放后下一个能抢到', () => {
    const root = directory()
    const first = acquireInstanceLock(root, { runId: 'a' })
    expect(first.acquired).toBe(true)
    expect(existsSync(instanceLockPath(root))).toBe(true)
    expect(readInstanceLock(root)?.holder).toMatchObject({ pid: process.pid, runId: 'a' })
    if (first.acquired) first.release()
    expect(existsSync(instanceLockPath(root))).toBe(false)
    const second = acquireInstanceLock(root, { runId: 'b' })
    expect(second.acquired).toBe(true)
    if (second.acquired) second.release()
  })

  it('席位有人（进程还活着）时抢不到，⛔ 踢掉对方', async () => {
    const root = directory()
    const holder = holderProcess(root)
    try {
      await waitFor(() => existsSync(join(root, 'held')))
      expect(JSON.parse(readFileSync(join(root, 'held'), 'utf8')).acquired).toBe(true)
      const before = readInstanceLock(root)
      const mine = acquireInstanceLock(root, { runId: 'second' })
      expect(mine.acquired).toBe(false)
      // 对方的席位一个字节都没动
      expect(readInstanceLock(root)?.holder).toEqual(before?.holder)
      expect(readInstanceLock(root)?.ino).toBe(before?.ino)
    } finally { holder.kill('SIGKILL') }
  })

  it('上一任被杀（崩溃/断电）后，下一任接手席位', async () => {
    const root = directory()
    const holder = holderProcess(root)
    try {
      await waitFor(() => existsSync(join(root, 'held')))
      holder.kill('SIGKILL')
      await waitFor(() => holder.exitCode !== null || holder.signalCode !== null)
      expect(existsSync(instanceLockPath(root))).toBe(true) // 遗留席位还在
      const mine = acquireInstanceLock(root, { runId: 'successor' })
      expect(mine.acquired).toBe(true)
      expect(readInstanceLock(root)?.holder).toMatchObject({ runId: 'successor' })
      if (mine.acquired) mine.release()
    } finally { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL') }
  })

  it('两个新实例同时清理遗留席位：后到者按旧观察清理，不能删掉先到者刚拿到的席位', () => {
    const root = directory()
    // 造一个持有者已死的遗留席位
    writeFileSync(instanceLockPath(root), JSON.stringify({ token: 'stale', pid: 2 ** 22 + 13, runId: 'dead', at: 0 }))
    const observedByLate = readInstanceLock(root)
    // 先到者正常接手
    const winner = acquireInstanceLock(root, { runId: 'winner' })
    expect(winner.acquired).toBe(true)
    const held = readInstanceLock(root)
    // 后到者拿着旧观察去清理：必须失败，且不能动赢家的席位
    expect(takeOverStaleInstanceLock(root, observedByLate!)).toBe(false)
    expect(readInstanceLock(root)?.holder).toEqual(held?.holder)
    expect(readInstanceLock(root)?.ino).toBe(held?.ino)
    expect(acquireInstanceLock(root, { runId: 'late' }).acquired).toBe(false)
    if (winner.acquired) winner.release()
  })

  it('释放只删自己的席位：席位已被别人接手时 ⛔ 误删', () => {
    const root = directory()
    const mine = acquireInstanceLock(root, { runId: 'mine' })
    expect(mine.acquired).toBe(true)
    // 模拟极端交错：席位被换成别人的
    writeFileSync(instanceLockPath(root), JSON.stringify({ token: 'other', pid: process.pid, runId: 'other', at: Date.now() }))
    if (mine.acquired) mine.release()
    expect(existsSync(instanceLockPath(root))).toBe(true)
    expect(readInstanceLock(root)?.holder).toMatchObject({ runId: 'other' })
  })
})
