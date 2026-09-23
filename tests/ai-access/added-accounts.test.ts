import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AddedOfficialAccounts } from '../../app/main/ai-access/added-accounts'

const keyA = 'a'.repeat(64)
const keyB = 'b'.repeat(64)

describe('已添加账号登记表', () => {
  it('登记后可读，重登覆盖旧指纹，清除后回到未添加', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      expect(await store.key('codex')).toBeNull()
      await store.mark('codex', keyA)
      expect(await store.key('codex')).toBe(keyA)
      await store.mark('codex', keyB)
      expect(await store.key('codex')).toBe(keyB)
      await store.clear('codex')
      expect(await store.key('codex')).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('两种壳各自登记互不影响；坏文件就地重建', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-shells-'))
    try {
      const file = join(directory, 'official-accounts.json')
      const store = new AddedOfficialAccounts(file)
      await store.mark('codex', keyA)
      await store.mark('claude', keyB)
      expect(await store.key('codex')).toBe(keyA)
      expect(await store.key('claude')).toBe(keyB)
      await writeFile(file, '{broken json', 'utf8')
      expect(await store.key('codex')).toBeNull()
      await store.mark('codex', keyA)
      expect(await store.key('codex')).toBe(keyA)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('拒绝登记不像账号指纹的值', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-invalid-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      await expect(store.mark('codex', 'tr***@gmail.com')).rejects.toMatchObject({ message: 'OFFICIAL_ACCOUNT_KEY_INVALID' })
      expect(await store.key('codex')).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  // Phase 1 ⑤(登录竞态丢登记):两种壳的登录钩子并发落账时,基线的读改写交错——两边都从
  // 同一份空账本起笔,后 rename 的把先 rename 的键整个盖掉。改后:读改写进串行闸,谁都别想裸奔。
  it('并发登记互不丢账:codex 与 claude 同时 mark,两个键都必须在', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-race-'))
    try {
      const store = new AddedOfficialAccounts(join(directory, 'official-accounts.json'))
      await Promise.all([store.mark('codex', keyA), store.mark('claude', keyB)])
      expect(await store.key('codex')).toBe(keyA)
      expect(await store.key('claude')).toBe(keyB)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  // store.ts 规范:随机 tmp+wx 独占创建+0600;落盘后无 tmp 垃圾,钥匙串级权限不放宽。
  it('落盘 0600 且不留 tmp(基线 0644+固定 pid tmp)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-mode-'))
    try {
      const file = join(directory, 'official-accounts.json')
      const store = new AddedOfficialAccounts(file)
      await store.mark('codex', keyA)
      if (process.platform !== 'win32') {
        expect(await stat(file).then((s) => s.mode & 0o777)).toBe(0o600)
      }
      const leftovers = (await readdir(directory)).filter((name) => name.includes('.tmp'))
      expect(leftovers).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('写失败(tmp rename 不走)清理 tmp 并如实抛错,⛔ 留半截文件在盘上', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'added-accounts-fail-'))
    try {
      // 目标路径是个目录:rename 必失败,逼出清理路径
      const file = join(directory, 'official-accounts.json')
      await mkdir(file)
      const store = new AddedOfficialAccounts(file)
      await expect(store.mark('codex', keyA)).rejects.toThrow()
      const leftovers = (await readdir(directory)).filter((name) => name.includes('.tmp'))
      expect(leftovers).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
