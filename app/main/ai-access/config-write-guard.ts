// CLI 配置写入互斥与操作前语义备份(收敛包3·件6)。
// 锁思路复用包 1 的 tools/operation-lock.ts:锁内容写 pid+时间,pid 已退出或超时视为陈旧。
// 客户同时开着 CC Switch/Cockpit 之类工具时第三方不会守我们的锁,但至少 ours 自己的
// 并发写(多入口同时改同一份配置)串行化;语义备份保证任何时候都能手工找回上一版。
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const LOCK_STALE_MS = 60_000
const UNREADABLE_LOCK_GRACE_MS = 5_000
const WAIT_INTERVAL_MS = 50

export const CONFIG_LOCK_TIMEOUT_MS = 5_000
export const SEMANTIC_BACKUP_KEEP = 3

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function lockIsLive(lockPath: string, now: number): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf8')
  } catch {
    return false // 锁已消失,可以直接抢
  }
  let stamp: { pid?: unknown; at?: unknown }
  try {
    stamp = JSON.parse(raw) as { pid?: unknown; at?: unknown }
  } catch {
    try { return now - (await stat(lockPath)).mtimeMs <= UNREADABLE_LOCK_GRACE_MS } catch { return false }
  }
  if (typeof stamp?.pid !== 'number' || !Number.isSafeInteger(stamp.pid) ||
      typeof stamp?.at !== 'number' || !Number.isSafeInteger(stamp.at)) {
    try { return now - (await stat(lockPath)).mtimeMs <= UNREADABLE_LOCK_GRACE_MS } catch { return false }
  }
  return processAlive(stamp.pid) && now - stamp.at <= LOCK_STALE_MS
}

export interface ConfigWriteLockOptions {
  now?: () => number
  timeoutMs?: number
  delayMs?: number
}

/** 写入期间持有 lockPath;他人持锁则等待重试,陈旧锁自动清理。锁不可用时阻断写入。 */
export async function withConfigWriteLock<T>(lockPath: string, task: () => Promise<T>, options: ConfigWriteLockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? CONFIG_LOCK_TIMEOUT_MS
  const delayMs = options.delayMs ?? WAIT_INTERVAL_MS
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      await mkdir(dirname(lockPath), { recursive: true })
    } catch (error) {
      throw new Error('AI_ACCESS_CONFIG_LOCK_UNAVAILABLE', { cause: error })
    }
    try {
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, at: now() })}\n`, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw new Error('AI_ACCESS_CONFIG_LOCK_UNAVAILABLE', { cause: error })
      }
      if (!(await lockIsLive(lockPath, now()))) {
        try { await rm(lockPath, { force: true }) } catch (removeError) {
          throw new Error('AI_ACCESS_CONFIG_LOCK_UNAVAILABLE', { cause: removeError })
        }
        continue
      }
      if (now() >= deadline) throw new Error('AI_ACCESS_CONFIG_LOCK_BUSY', { cause: error })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  try {
    return await task()
  } finally {
    try { await rm(lockPath, { force: true }) } catch { /* 释放失败靠陈旧判定兜底 */ }
  }
}

/** 语义备份名:laixin-before-<动作>-<时间戳>-<序号>-<原文件名>(收敛包3·件6)。 */
export function semanticBackupName(action: string, at: number, index: number, originalName: string): string {
  return `laixin-before-${action}-${at}-${index + 1}-${originalName}`
}

/** 从备份名解析创建时间戳;名字不规范(旧格式/损坏)返回 null,这类备份不参与删旧(审计 R4)。 */
export function semanticBackupTimestamp(name: string): number | null {
  const match = /^laixin-before-[a-z0-9]+-(\d+)-\d+-/.exec(name)
  if (!match) return null
  const at = Number(match[1])
  return Number.isSafeInteger(at) ? at : null
}

/** 时间戳升序排备份;解析不出的排最后,⛔ 被整名排序把最新的 apply 排到最旧 restore 前面删掉。 */
function byBackupTimestamp(a: string, b: string): number {
  const left = semanticBackupTimestamp(a)
  const right = semanticBackupTimestamp(b)
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER)
}

export interface BackupSource {
  readonly path: string
  readonly before: string | undefined
}

interface WritableFile {
  write(path: string, contents: string): Promise<void>
  remove(path: string): Promise<void>
  list?(dir: string): Promise<string[]>
}

/** File operations needed by a checked multi-file configuration transaction. */
export interface ConfigTransactionFile extends WritableFile {
  read(path: string): Promise<string | undefined>
}

export interface ConfigTransactionChange {
  readonly path: string
  readonly before: string | undefined
  readonly after: string | undefined
  /** Parse/semantic assertion run before write and again after readback. */
  readonly validate?: (contents: string | undefined) => void
}

export interface ConfigTransactionOptions {
  readonly backupAction?: string
}

/** 事务改动落盘前,把每个将被改动的现存文件快照进语义备份;随后把目录修剪到最近 N 份。 */
export async function captureSemanticBackups(file: WritableFile, changes: readonly BackupSource[], action: string, at = Date.now()): Promise<void> {
  const touchedDirs = new Set<string>()
  let index = 0
  for (const change of changes) {
    if (change.before === undefined) continue
    index += 1
    const dir = dirname(change.path)
    touchedDirs.add(dir)
    await file.write(join(dir, semanticBackupName(action, at, index - 1, basename(change.path))), change.before)
  }
  for (const dir of touchedDirs) {
    await pruneSemanticBackups(file, dir)
  }
}

/** 只保留最近 SEMANTIC_BACKUP_KEEP 份 laixin-before-* 备份(按名字内时间戳升序,删最旧)。 */
export async function pruneSemanticBackups(file: WritableFile, dir: string, keep = SEMANTIC_BACKUP_KEEP): Promise<void> {
  if (file.list === undefined) return
  const names = (await file.list(dir)).filter((name) => name.startsWith('laixin-before-')).sort(byBackupTimestamp)
  const excess = names.length - keep
  if (excess <= 0) return
  for (const name of names.slice(0, excess)) {
    if (semanticBackupTimestamp(name) === null) continue // 解析不出时间戳:不删,保守保留
    try { await file.remove(join(dir, name)) } catch { /* 删不掉留着也不影响写入 */ }
  }
}

/** 供展示:列出目录里的语义备份(按时间戳升序)。 */
export async function listSemanticBackups(file: WritableFile, dir: string): Promise<string[]> {
  if (file.list === undefined) return []
  return (await file.list(dir)).filter((name) => name.startsWith('laixin-before-')).sort(byBackupTimestamp)
}

/**
 * Validates every candidate before any backup or target file changes, then validates readback
 * before committing the transaction. A parser rejection therefore cannot leave a newly-created
 * backup, model catalog, or partially rewritten configuration behind.
 */
export async function replaceConfigurationTransaction(
  file: ConfigTransactionFile,
  changes: readonly ConfigTransactionChange[],
  options: ConfigTransactionOptions = {}
): Promise<void> {
  for (const change of changes) change.validate?.(change.after)
  if (options.backupAction !== undefined) {
    await captureSemanticBackups(file, changes, options.backupAction)
  }
  try {
    for (const change of changes) await replaceTransactionText(file, change.path, change.after)
    for (const change of changes) {
      const readback = await file.read(change.path)
      if (readback !== change.after) throw new Error('AI_ACCESS_CONFIG_READBACK_FAILED')
      change.validate?.(readback)
    }
  } catch {
    try {
      for (const change of [...changes].reverse()) await replaceTransactionText(file, change.path, change.before)
    } catch {
      throw new Error('AI_ACCESS_CONFIG_ROLLBACK_FAILED')
    }
    throw new Error('AI_ACCESS_CONFIG_TRANSACTION_FAILED')
  }
}

async function replaceTransactionText(file: ConfigTransactionFile, path: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) await file.remove(path)
  else await file.write(path, contents)
}
