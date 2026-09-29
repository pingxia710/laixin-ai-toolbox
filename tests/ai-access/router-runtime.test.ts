import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireAiRouterSeat } from '../../app/main/ai-access/router-runtime'

const roots: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('AI router 席位', () => {
  it('刚取得、尚未写 runtime 的启动席位在有界启动窗口内仍保持独占', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-router-seat-starting-'))
    roots.push(root)
    const first = await acquireAiRouterSeat(root)

    await expect(acquireAiRouterSeat(root)).rejects.toThrow('AI_ROUTER_SEAT_HELD')

    await first.release()
  })

  it('活着的无关 PID 留在旧 seat 中时，没有有效 router 证明也必须回收', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-router-seat-'))
    roots.push(root)
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(unrelated)
    expect(unrelated.pid).toBeTypeOf('number')
    await writeFile(join(root, 'ai-router.seat'), JSON.stringify({ pid: unrelated.pid, bootId: 'a'.repeat(32) }), { mode: 0o600 })

    const seat = await acquireAiRouterSeat(root)

    expect(seat.bootId).not.toBe('a'.repeat(32))
    await seat.release()
  })

  it('旧 owner 的异步证明期间不得回收原子替换后的有效启动席位', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-router-seat-snapshot-'))
    roots.push(root)
    const path = join(root, 'ai-router.seat')
    const oldBootId = 'a'.repeat(32)
    const newBootId = 'b'.repeat(32)
    const oldSeat = JSON.stringify({ pid: process.pid, bootId: oldBootId, startedAt: Date.now() - 9_000 })
    const newSeat = JSON.stringify({ pid: process.pid, bootId: newBootId, startedAt: Date.now() })
    await writeFile(path, oldSeat, { mode: 0o600 })

    let enteredProof!: () => void
    let releaseProof!: () => void
    const provingOldOwner = new Promise<void>(resolve => { enteredProof = resolve })
    const proofBarrier = new Promise<void>(resolve => { releaseProof = resolve })
    const reclaiming = acquireAiRouterSeat(root, async owner => {
      if (owner.bootId === oldBootId) {
        enteredProof()
        await proofBarrier
      }
      return false
    })

    await provingOldOwner
    const replacement = join(root, 'ai-router.seat.replacement')
    await writeFile(replacement, newSeat, { mode: 0o600 })
    await rename(replacement, path)
    releaseProof()

    await expect(reclaiming).rejects.toThrow('AI_ROUTER_SEAT_HELD')
    expect(await readFile(path, 'utf8')).toBe(newSeat)
    expect((await readdir(root)).filter(entry => entry.startsWith('ai-router.seat.stale-'))).toHaveLength(0)
  })
})
