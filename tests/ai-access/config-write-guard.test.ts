// 收敛包3·件6:模型 API 写 ~/.codex、~/.claude 配置的互斥锁与操作前语义备份。
// G 报告的工程加固:有备份+回读+回滚,但没有跨进程互斥;备份只有单文件、不带语义。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withConfigWriteLock, pruneSemanticBackups, listSemanticBackups } from '../../app/main/ai-access/config-write-guard'
import { createCodexModelApiConfig, type ManagedTextFile } from '../../app/main/ai-access/deepseek-config'
import { createManagedTextFile } from '../../app/main/ai-access/file'

function fakeIo(initial: Readonly<Record<string, string>> = {}) {
  const data = new Map(Object.entries(initial))
  const io: ManagedTextFile = {
    read: async (path) => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async (path) => { data.delete(path) },
    list: async (dir) => [...data.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    withConfigWriteLock: async (_lockPath, task) => task()
  }
  return { io, keys: () => [...data.keys()], contents: (path: string) => data.get(path) }
}

const connection = { baseUrl: 'http://127.0.0.1:19361/codex/deepseek/v1', apiKey: 'local-fixture-token-123456789', model: 'deepseek-chat' }

describe('CLI 配置写互斥与语义备份(收敛包3·件6)', () => {
  it('两个并发写入都成功且串行执行:一个等锁后重试成功,不互相覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-lock-'))
    try {
      const lockPath = join(root, 'laixin-config.lock')
      const order: string[] = []
      // 「谁先拿到锁」本身是不确定的:两次调用各自 await mkdir 再 wx 建锁文件,两个 mkdir 落在
      // libuv 线程池的不同线程上,完成顺序不保证等于调用顺序(实测 200 次里 53 次反过来)。
      // 本用例要验的是「第二个必须等第一个完全释放」,所以先确认第一个真的进了临界区再发第二个,
      // ⛔ 把抢 mkdir 的运气当成被测行为。
      let holding = (): void => undefined
      const held = new Promise<void>((resolve) => { holding = resolve })
      const first = withConfigWriteLock(lockPath, async () => {
        order.push('first-start')
        holding()
        await new Promise((resolve) => setTimeout(resolve, 120))
        order.push('first-end')
        return 'first'
      })
      await held
      const second = withConfigWriteLock(lockPath, async () => {
        order.push('second-start')
        order.push('second-end')
        return 'second'
      }, { delayMs: 10, timeoutMs: 2_000 })
      expect(await first).toBe('first')
      expect(await second).toBe('second')
      // 第二个必须等第一个完全释放后才开工:⛔ 交错写同一份配置
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('陈旧锁(pid 已退出)自动清理后重试成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-lock-stale-'))
    try {
      const lockPath = join(root, 'laixin-config.lock')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999_999, at: Date.now() })}\n`)
      const result = await withConfigWriteLock(lockPath, async () => 'done', { delayMs: 10, timeoutMs: 2_000 })
      expect(result).toBe('done')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('活锁超时:报 AI_ACCESS_CONFIG_LOCK_BUSY,不无限等待', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-lock-busy-'))
    try {
      const lockPath = join(root, 'laixin-config.lock')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`) // 自己活着 = 活锁
      await expect(withConfigWriteLock(lockPath, async () => 'never', { delayMs: 5, timeoutMs: 120 }))
        .rejects.toThrow('AI_ACCESS_CONFIG_LOCK_BUSY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('锁目录不可创建时 fail closed，不会在无锁状态执行配置写入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-lock-unavailable-'))
    try {
      const parentFile = join(root, 'not-a-directory')
      writeFileSync(parentFile, 'fixture')
      let called = false

      await expect(withConfigWriteLock(join(parentFile, 'laixin-config.lock'), async () => {
        called = true
        return 'unsafe'
      })).rejects.toThrow('AI_ACCESS_CONFIG_LOCK_UNAVAILABLE')

      expect(called).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('apply 前写语义备份 laixin-before-apply-<时间戳>,只保留最近 3 份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-backup-'))
    try {
      const config = createCodexModelApiConfig('deepseek', root, createManagedTextFile(), connection)
      for (let round = 0; round < 5; round += 1) {
        await config.apply(`sk-round-${round}-key-0123456789`)
        await new Promise((resolve) => setTimeout(resolve, 3)) // 时间戳错开
      }
      const codexDir = join(root, '.codex')
      const backups = readdirSync(codexDir).filter((name) => name.startsWith('laixin-before-apply-')).sort()
      expect(backups.length).toBe(3)
      // 名字带语义与时间戳
      expect(backups[0]).toMatch(/^laixin-before-apply-\d+-/)
      // 保留的是最近 3 份(时间戳单调递增)
      const stamps = backups.map((name) => Number(/^laixin-before-apply-(\d+)-/.exec(name)![1]))
      expect([...stamps].sort((a, b) => a - b)).toEqual(stamps)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restoreOfficial 前写 laixin-before-restore- 语义备份,同样只留 3 份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-backup-restore-'))
    try {
      const config = createCodexModelApiConfig('deepseek', root, createManagedTextFile(), connection)
      await config.apply('sk-first-key-0123456789012')
      for (let round = 0; round < 4; round += 1) {
        await config.apply('sk-again-key-012345678901')
        await config.restoreOfficial()
        await new Promise((resolve) => setTimeout(resolve, 3))
      }
      const codexDir = join(root, '.codex')
      const backups = readdirSync(codexDir).filter((name) => name.startsWith('laixin-before-')).sort()
      expect(backups.length).toBeLessThanOrEqual(6)
      expect(backups.some((name) => name.startsWith('laixin-before-restore-'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('写入期间持锁文件可见(pid+时间),完成后自动清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-lock-live-'))
    try {
      const io = fakeIo()
      const lockPath = join(root, '.codex', 'laixin-config.lock')
      let seenDuringWrite = false
      const tracingIo: ManagedTextFile = {
        read: async (path) => {
          try { readFileSync(lockPath, 'utf8'); seenDuringWrite = true } catch { /* 还没建 */ }
          return io.io.read(path)
        },
        write: io.io.write,
        remove: io.io.remove,
        list: io.io.list
      }
      await createCodexModelApiConfig('deepseek', root, tracingIo, connection).apply('sk-live-key-0123456789012')
      expect(seenDuringWrite).toBe(true)
      expect(readdirSync(join(root, '.codex')).some((name) => name.endsWith('.lock'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // 审计 R4(2026-09-12 上线检查):备份清理按整名排序,apply 永远排在 restore 前,先删最新。
  // 证据 evidence/repro-backup-and-trial.jsonl 第一行:三份旧 restore + 一份新 apply,新备份立即被删。
  it('修剪按名字内时间戳删最旧:三份旧 restore + 一份新 apply,删的是最旧 restore', async () => {
    const dir = '/root/.codex'
    const io = fakeIo({
      [`${dir}/laixin-before-restore-1000-1-settings.json`]: '{}',
      [`${dir}/laixin-before-restore-2000-1-settings.json`]: '{}',
      [`${dir}/laixin-before-restore-3000-1-settings.json`]: '{}',
      [`${dir}/laixin-before-apply-4000-1-settings.json`]: '{}'
    })
    await pruneSemanticBackups(io.io, dir, 3)
    const remaining = io.keys()
    // 删的是最旧的 restore(1000);最新的 apply(4000)必须留下,保证最近一次修改前的恢复材料完整
    expect(remaining.some((path) => path.includes('restore-1000-'))).toBe(false)
    expect(remaining.filter((path) => path.includes('laixin-before-')).length).toBe(3)
    expect(remaining.some((path) => path.includes('apply-4000-'))).toBe(true)
    // 展示顺序也按时间戳升序(最新在最后),不再按动作字母序
    expect(await listSemanticBackups(io.io, dir)).toEqual([
      'laixin-before-restore-2000-1-settings.json',
      'laixin-before-restore-3000-1-settings.json',
      'laixin-before-apply-4000-1-settings.json'
    ])
  })

  it('名字解析不出时间戳的备份不会被删,删除仍按可解析时间戳挑最旧', async () => {
    const dir = '/root/.codex'
    const io = fakeIo({
      [`${dir}/laixin-before-restore-oops-1-settings.json`]: '{}',
      [`${dir}/laixin-before-restore-1000-1-settings.json`]: '{}',
      [`${dir}/laixin-before-restore-3000-1-settings.json`]: '{}'
    })
    await pruneSemanticBackups(io.io, dir, 2)
    const remaining = io.keys()
    expect(remaining.some((path) => path.includes('restore-1000-'))).toBe(false)
    expect(remaining.some((path) => path.includes('restore-3000-'))).toBe(true)
    expect(remaining.some((path) => path.includes('restore-oops-'))).toBe(true)
  })
})
