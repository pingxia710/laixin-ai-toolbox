import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENTRY_STATUS, LEDGER_ENTRY_LIMIT, appendIntentEntry, appendSettingEntry, generateSessionToken,
  lastIntent, lastIntentCached, ledgerDiskReads, ledgerFailure, ledgerFailureCached, loadLedger, loadLedgerCached, saveLedger
} from '../../sidecar/mac/ledger.mjs'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { unrestoredEntriesCached } from '../../sidecar/mac/restore.mjs'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const intentEntry = (time: number) => ({ id: `i-fixture-${time}`, kind: 'intent' as const, intent: 'connected' as const, time })

const appliedSetting = (index: number, sessionToken: string) => ({
  id: `w-${sessionToken}-${index}`,
  kind: 'setting' as const,
  service: 'networksetup',
  item: `webproxy-eth${index}`,
  originalValue: { enabled: false },
  writtenValue: { enabled: true, port: 18080 },
  sessionToken,
  time: index,
  status: ENTRY_STATUS.applied,
  note: ''
})

describe('账本条目上限与归档', () => {
  it('写入 5000 条后账本文件不超过条目上限,被归档条目完整保留在归档文件里', async () => {
    const dataDir = await tempDir('laixin-ledger-cap-')
    const entries: unknown[] = []
    for (let index = 0; index < 5000; index += 1) entries.push(intentEntry(index + 1))
    saveLedger(dataDir, entries as never)

    const stored = loadLedger(dataDir)
    expect(stored.length).toBeLessThanOrEqual(LEDGER_ENTRY_LIMIT)
    // 最新的意图必须还在:启动恢复按最后一条意图判断用户意愿。
    expect(lastIntent(dataDir)).toBe('connected')
    const archive = JSON.parse(`[${(await readFile(join(dataDir, 'ledger-archive.jsonl'), 'utf8')).trim().split('\n').join(',')}]`) as unknown[]
    expect(archive.length).toBe(5000 - stored.length)
    expect(archive.length).toBeGreaterThanOrEqual(4000)
  })

  it('未恢复的设置账目永不归档:已恢复的旧账目先让位', async () => {
    const dataDir = await tempDir('laixin-ledger-pending-')
    const sessionToken = generateSessionToken()
    const restored: unknown[] = []
    for (let index = 0; index < 600; index += 1) {
      const entry = appliedSetting(index + 1, sessionToken)
      restored.push({ ...entry, status: ENTRY_STATUS.restored })
    }
    restored.push(appliedSetting(999, sessionToken)) // 未恢复,必须保留
    saveLedger(dataDir, restored as never)

    const stored = loadLedger(dataDir)
    expect(stored.some((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.applied)).toBe(true)
    expect(stored.filter((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.applied).length).toBe(1)

    // 增量路径:逐条追加已恢复设置,同样只保留最近 LIMIT 条且不动未恢复账目。
    const incremental = await tempDir('laixin-ledger-incremental-')
    const kept = appendSettingEntry(incremental, { service: 'networksetup', item: 'webproxy-eth0', originalValue: null, writtenValue: { port: 18080 }, sessionToken, time: 1 })
    for (let index = 0; index < 700; index += 1) appendIntentEntry(incremental, { intent: 'connected', time: index + 1 })
    // 未恢复的 applied 账目绕不过去,但后面的 intent 照常收缩:账本回到上限内,applied 仍在账。
    expect(loadLedger(incremental).length).toBeLessThanOrEqual(LEDGER_ENTRY_LIMIT)
    expect(loadLedger(incremental).some((entry) => entry.id === kept.id)).toBe(true)
  })
})

describe('状态轮询账本记忆化', () => {
  it('文件未变时连续读取只解析一次;写入后缓存立刻看到新内容', async () => {
    const { writeFile } = await import('node:fs/promises')
    const dataDir = await tempDir('laixin-ledger-cache-')
    // 冷路径:不经 saveLedger 直写文件,首次读取恰解析一次,随后命中缓存。
    await writeFile(join(dataDir, 'ledger.json'), JSON.stringify([{ id: 'i-1', kind: 'intent', intent: 'connected', time: 1 }]), 'utf8')
    const readsAfterFirst = ledgerDiskReads()
    for (let index = 0; index < 10; index += 1) {
      expect(loadLedgerCached(dataDir).length).toBe(1)
      expect(lastIntentCached(dataDir)).toBe('connected')
      expect(ledgerFailureCached(dataDir)).toBeUndefined()
      expect(unrestoredEntriesCached(dataDir)).toEqual([])
    }
    expect(ledgerDiskReads() - readsAfterFirst).toBe(1)

    // 写路径入账后缓存立刻看到新内容,无需再读盘;外部直改文件后下一次读恰解析一次。
    appendIntentEntry(dataDir, { intent: 'user-disconnected', time: 2 })
    expect(ledgerDiskReads() - readsAfterFirst).toBe(1)
    expect(lastIntentCached(dataDir)).toBe('user-disconnected')
    await writeFile(join(dataDir, 'ledger.json'), JSON.stringify([{ id: 'i-1', kind: 'intent', intent: 'shutdown', time: 1 }]), 'utf8')
    expect(lastIntentCached(dataDir)).toBe('shutdown')
    expect(ledgerDiskReads() - readsAfterFirst).toBe(2)
  })

  it('连续 10 次 tunnel.status 且账本未变时,账本解析只发生 1 次', async () => {
    const { writeFile } = await import('node:fs/promises')
    const dataDir = await tempDir('laixin-ledger-status-')
    await writeFile(join(dataDir, 'ledger.json'), JSON.stringify([{ id: 'i-1', kind: 'intent', intent: 'connected', time: Date.now() }]), 'utf8')
    const readsBefore = ledgerDiskReads()
    for (let index = 0; index < 10; index += 1) {
      const status = computeStatus({ dataDir, daemonState: undefined, daemonUnexpectedExitAt: undefined, componentMissing: [], sshBinary: '' })
      expect(status.state).toBeTypeOf('string')
    }
    expect(ledgerDiskReads() - readsBefore).toBe(1)
  })

  it('账本损坏时缓存路径仍如实报错,不冒充空账本', async () => {
    const dataDir = await tempDir('laixin-ledger-corrupt-')
    appendIntentEntry(dataDir, { intent: 'connected', time: 1 })
    loadLedgerCached(dataDir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dataDir, 'ledger.json'), '{broken json', 'utf8')
    expect(ledgerFailureCached(dataDir)?.code).toBe('LEDGER_CORRUPT')
    expect(ledgerFailure(dataDir)?.code).toBe('LEDGER_CORRUPT')
  })
})

describe('归档文件卫生', () => {
  it('归档只增不删且账本本身保持原子重写', async () => {
    const dataDir = await tempDir('laixin-ledger-archive-')
    const entries: unknown[] = []
    for (let index = 0; index < 520; index += 1) entries.push(intentEntry(index + 1))
    saveLedger(dataDir, entries as never)
    const files = await readdir(dataDir)
    expect(files).toContain('ledger.json')
    expect(files).toContain('ledger-archive.jsonl')
    expect(files.filter((name) => name.startsWith('ledger.json.tmp'))).toEqual([])
    // 归档里没有未恢复设置账目被误删的情形:全部是 intent
    const archive = await readFile(join(dataDir, 'ledger-archive.jsonl'), 'utf8')
    expect(archive).not.toContain('"kind":"setting"')
    expect((await stat(join(dataDir, 'ledger.json'))).size).toBeGreaterThan(0)
  })
})
