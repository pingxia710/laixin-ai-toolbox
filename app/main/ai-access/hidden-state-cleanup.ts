// 隐形状态的清理与恢复。
// 三条硬规矩：**⛔ 删客户的行**（只在前面加注释）、改前整份备份、每一步都留下可恢复的凭据。
// 残留的系统代理只报告不处理（归网络模块），所以这里没有它的清理函数。
import { chmod, lstat, mkdir, readFile as readFileImpl, realpath, rename, rm, writeFile as writeFileImpl } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { HiddenStateFinding } from './hidden-state'
import { CLAUDE_ONBOARDING_KEY, parseShellAssignments } from './hidden-state'

export type ReadFile = (path: string) => Promise<string | undefined>
export type WriteFile = (path: string, contents: string) => Promise<void>
export type Exec = (command: string, args: readonly string[]) => Promise<string>

export interface CleanupFileDeps {
  readonly backupDir: string
  readonly readFile?: ReadFile
  readonly writeFile?: WriteFile
  readonly now?: () => Date
}

export interface CleanupFailure {
  readonly source: string
  readonly name: string
  readonly reason: string
}

export interface ShellCleanupEntry {
  /** 客户看到的位置；软链时是链接本身。 */
  readonly source: string
  /** 真正读写的文件；软链时是目标。旧凭据没有这个字段，回退用 source。 */
  readonly file?: string
  readonly backupPath: string
  readonly name: string
  readonly line: number
  readonly originalLine: string
  readonly commentedLine: string
}

export interface ShellCleanupReceipt {
  readonly version: 1
  readonly at: string
  readonly entries: readonly ShellCleanupEntry[]
  readonly failures: readonly CleanupFailure[]
  readonly notes: readonly string[]
}

export interface RegistryCleanupEntry {
  readonly key: string
  readonly name: string
  readonly backupPath: string
}

export interface RegistryCleanupReceipt {
  readonly version: 1
  readonly at: string
  readonly entries: readonly RegistryCleanupEntry[]
  readonly failures: readonly CleanupFailure[]
  readonly notes: readonly string[]
}

export interface ClaudeOnboardingEntry {
  readonly path: string
  readonly backupPath: string | null
  readonly changed: boolean
}

export type RestoreOutcome = 'restored' | 'already-restored' | 'failed'

export interface RestoreResult {
  readonly source: string
  readonly name: string
  readonly outcome: RestoreOutcome
  readonly reason?: string
  /** 自动恢复不成时，客户（或客服）还能拿这份备份手工还原。 */
  readonly backupPath?: string
}

const RESTART_NOTE = '已改的设置要新开一个终端窗口才生效；现在开着的终端里还是旧值。'

async function defaultReadFile(path: string): Promise<string | undefined> {
  try {
    // 软链要落到真实路径再读：当成「文件不存在」会让后面的写入把目标整份覆盖掉。
    const resolved = await resolveSymlink(path)
    const info = await lstat(resolved)
    if (!info.isFile() || info.size > 512 * 1024) throw new Error('HIDDEN_STATE_FILE_INVALID')
    return await readFileImpl(resolved, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 是软链就返回它指向的真实路径；不是（或还不存在）就原样返回。 */
async function resolveSymlink(path: string): Promise<string> {
  try {
    const info = await lstat(path)
    return info.isSymbolicLink() ? await realpath(path) : path
  } catch {
    return path
  }
}

/** 原子写：先写临时文件再 rename，中途断电也不会留下半份配置。已有文件保持原权限。 */
async function defaultWriteFile(target: string, contents: string): Promise<void> {
  // 直接 rename 到软链上会把链接本身替换成普通文件，客户的 dotfiles 布局就散了。
  const path = await resolveSymlink(target)
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const mode = await existingMode(path)
  const temporary = join(parent, `.laixin-hidden-state-${randomUUID()}.tmp`)
  try {
    await writeFileImpl(temporary, contents, { flag: 'wx', mode: 0o600 })
    if (mode !== null) await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function existingMode(path: string): Promise<number | null> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() ? info.mode & 0o777 : null
  } catch {
    return null
  }
}

export function backupStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

export function commentPrefix(at: Date): string {
  return `# 来信AI工具箱 ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} 停用: `
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return '没有写入权限'
  return error instanceof Error && error.message !== '' ? error.message : '处理失败'
}

/**
 * 把 shell 启动文件里的那几行**注释掉**，⛔ 删。改之前整份文件备份一次。
 * 行号或行内容跟扫描时对不上就跳过这一条（客户在中间自己改过），⛔ 蒙着改。
 */
export async function cleanShellExports(
  findings: readonly HiddenStateFinding[],
  deps: CleanupFileDeps
): Promise<ShellCleanupReceipt> {
  const readFile = deps.readFile ?? defaultReadFile
  const writeFile = deps.writeFile ?? defaultWriteFile
  const at = deps.now?.() ?? new Date()
  const prefix = commentPrefix(at)
  const entries: ShellCleanupEntry[] = []
  const failures: CleanupFailure[] = []

  // 按**真正读写的文件**分组（两个软链可能指向同一份），展示仍用客户看到的那个路径。
  const byFile = new Map<string, { display: string; group: HiddenStateFinding[] }>()
  for (const finding of findings) {
    if (finding.kind !== 'shell_export' || !finding.cleanable || finding.line === undefined) continue
    const file = finding.resolvedSource ?? finding.source
    const bucket = byFile.get(file) ?? { display: finding.source, group: [] }
    bucket.group.push(finding)
    byFile.set(file, bucket)
  }

  for (const [file, { display: source, group }] of byFile) {
    let contents: string | undefined
    try {
      contents = await readFile(file)
    } catch (error) {
      for (const finding of group) failures.push({ source, name: finding.name, reason: reasonOf(error) })
      continue
    }
    if (contents === undefined) {
      for (const finding of group) failures.push({ source, name: finding.name, reason: '文件已经不在了' })
      continue
    }

    let backupPath: string
    try {
      backupPath = join(deps.backupDir, `${basename(source)}.${backupStamp(at)}.bak`)
      await writeFile(backupPath, contents)
    } catch (error) {
      for (const finding of group) failures.push({ source, name: finding.name, reason: `备份失败：${reasonOf(error)}` })
      continue
    }

    // 按 '\n' 切、按 '\n' 拼：CRLF 的 \r 留在行尾原样带回去，恢复时才能逐字节一样。
    const lines = contents.split('\n')
    const staged: ShellCleanupEntry[] = []
    for (const finding of group) {
      const index = (finding.line ?? 0) - 1
      const current = lines[index]
      if (current === undefined || !mentions(current, finding.name)) {
        failures.push({ source, name: finding.name, reason: '这一行和刚才检查到的已经不一样了，没有动它；重新检查一次就能拿到最新的位置' })
        continue
      }
      const commented = `${prefix}${current}`
      lines[index] = commented
      staged.push({ source, file, backupPath, name: finding.name, line: finding.line ?? 0, originalLine: current, commentedLine: commented })
    }
    if (staged.length === 0) continue
    try {
      await writeFile(file, lines.join('\n'))
      entries.push(...staged)
    } catch (error) {
      for (const finding of staged) failures.push({ source, name: finding.name, reason: reasonOf(error) })
    }
  }

  return { version: 1, at: at.toISOString(), entries, failures, notes: entries.length > 0 ? [RESTART_NOTE] : [] }
}

/** 行还在不在、是不是同一条设置。只认真正会导出的写法，⛔ 靠字符串包含就动手。 */
function mentions(line: string, name: string): boolean {
  const syntax = /^\s*set\s+-/.test(line) ? 'fish' : 'posix'
  return parseShellAssignments(line, syntax).some((item) => item.name.toUpperCase() === name.toUpperCase() && !item.commented)
}

/**
 * 撤销：把注释掉的那一行原样换回来。
 * 找不到注释行但原行已经在 ⇒ 早就恢复过了，当成功、**⛔ 拿备份去盖**（客户后来的改动会没）。
 * 两样都找不到才报失败，并把备份路径给出去。
 */
export async function restoreShellExports(
  receipt: ShellCleanupReceipt,
  deps: Pick<CleanupFileDeps, 'readFile' | 'writeFile'> = {}
): Promise<readonly RestoreResult[]> {
  const readFile = deps.readFile ?? defaultReadFile
  const writeFile = deps.writeFile ?? defaultWriteFile
  const results: RestoreResult[] = []

  const byFile = new Map<string, { display: string; group: ShellCleanupEntry[] }>()
  for (const entry of receipt.entries) {
    const file = entry.file ?? entry.source
    const bucket = byFile.get(file) ?? { display: entry.source, group: [] }
    bucket.group.push(entry)
    byFile.set(file, bucket)
  }

  for (const [file, { display: source, group }] of byFile) {
    let contents: string | undefined
    try {
      contents = await readFile(file)
    } catch (error) {
      for (const entry of group) results.push({ source, name: entry.name, outcome: 'failed', reason: reasonOf(error), backupPath: entry.backupPath })
      continue
    }
    if (contents === undefined) {
      for (const entry of group) results.push({ source, name: entry.name, outcome: 'failed', reason: '文件已经不在了', backupPath: entry.backupPath })
      continue
    }
    const lines = contents.split('\n')
    let changed = false
    const staged: RestoreResult[] = []
    for (const entry of group) {
      const commented = lines.indexOf(entry.commentedLine)
      if (commented !== -1) {
        lines[commented] = entry.originalLine
        changed = true
        staged.push({ source, name: entry.name, outcome: 'restored' })
        continue
      }
      staged.push(lines.includes(entry.originalLine)
        ? { source, name: entry.name, outcome: 'already-restored' }
        : { source, name: entry.name, outcome: 'failed', reason: '这一行后来又被改过了，没有动它；备份里是停用前的原样', backupPath: entry.backupPath })
    }
    if (!changed) { results.push(...staged); continue }
    try {
      await writeFile(file, lines.join('\n'))
      results.push(...staged)
    } catch (error) {
      for (const entry of group) results.push({ source, name: entry.name, outcome: 'failed', reason: reasonOf(error), backupPath: entry.backupPath })
    }
  }
  return results
}

export interface RegistryCleanupDeps {
  readonly backupDir: string
  readonly exec: Exec
  readonly now?: () => Date
}

/**
 * Windows 注册表里的环境变量：先 `reg export` 整键备份，再 `reg delete` 单条。
 * **⛔ 广播 WM_SETTINGCHANGE 这类系统级动作**——只在凭据里写清楚「新开的终端才生效」。
 */
export async function cleanRegistryEnv(
  findings: readonly HiddenStateFinding[],
  deps: RegistryCleanupDeps
): Promise<RegistryCleanupReceipt> {
  const at = deps.now?.() ?? new Date()
  const entries: RegistryCleanupEntry[] = []
  const failures: CleanupFailure[] = []

  const byKey = new Map<string, HiddenStateFinding[]>()
  for (const finding of findings) {
    if (finding.kind !== 'registry_env' || !finding.cleanable) continue
    const list = byKey.get(finding.source) ?? []
    list.push(finding)
    byKey.set(finding.source, list)
  }

  for (const [key, group] of byKey) {
    const backupPath = join(deps.backupDir, `${key.replace(/[\\/:*?"<>|]+/g, '_')}.${backupStamp(at)}.reg`)
    try {
      await mkdir(deps.backupDir, { recursive: true, mode: 0o700 })
      await deps.exec('reg', ['export', key, backupPath, '/y'])
    } catch (error) {
      for (const finding of group) failures.push({ source: key, name: finding.name, reason: `备份失败：${reasonOf(error)}` })
      continue
    }
    for (const finding of group) {
      try {
        await deps.exec('reg', ['delete', key, '/v', finding.name, '/f'])
        entries.push({ key, name: finding.name, backupPath })
      } catch (error) {
        // HKLM 那一份要管理员权限，普通账号删不动是常事，⛔ 让它把整批都带失败。
        failures.push({ source: key, name: finding.name, reason: reasonOf(error) })
      }
    }
  }

  return { version: 1, at: at.toISOString(), entries, failures, notes: entries.length > 0 ? [RESTART_NOTE] : [] }
}

/** 撤销：把导出的 .reg 导回去。一个键只导一次，⛔ 每条都跑一遍。 */
export async function restoreRegistryEnv(
  receipt: RegistryCleanupReceipt,
  deps: { readonly exec: Exec }
): Promise<readonly RestoreResult[]> {
  const results: RestoreResult[] = []
  for (const backupPath of [...new Set(receipt.entries.map((entry) => entry.backupPath))]) {
    const group = receipt.entries.filter((entry) => entry.backupPath === backupPath)
    try {
      await deps.exec('reg', ['import', backupPath])
      for (const entry of group) results.push({ source: entry.key, name: entry.name, outcome: 'restored' })
    } catch (error) {
      for (const entry of group) results.push({ source: entry.key, name: entry.name, outcome: 'failed', reason: reasonOf(error), backupPath })
    }
  }
  return results
}

/**
 * 只把 `hasCompletedOnboarding` 点成 true，其余键原样留着（⛔ 整文件覆盖——CC Switch 就是栽在这）。
 * 文件不在就新建一份只有这个键的；读得到却解析不了就报错不动它。
 */
export async function markClaudeOnboarded(
  path: string,
  deps: CleanupFileDeps
): Promise<ClaudeOnboardingEntry> {
  const readFile = deps.readFile ?? defaultReadFile
  const writeFile = deps.writeFile ?? defaultWriteFile
  const at = deps.now?.() ?? new Date()
  const contents = await readFile(path)
  const config: Record<string, unknown> = contents === undefined ? {} : (JSON.parse(contents) as Record<string, unknown>)
  if (config[CLAUDE_ONBOARDING_KEY] === true) return { path, backupPath: null, changed: false }

  let backupPath: string | null = null
  if (contents !== undefined) {
    backupPath = join(deps.backupDir, `${basename(path)}.${backupStamp(at)}.bak`)
    await writeFile(backupPath, contents)
  }
  await writeFile(path, `${JSON.stringify({ ...config, [CLAUDE_ONBOARDING_KEY]: true }, null, 2)}\n`)
  return { path, backupPath, changed: true }
}

/** 撤销引导标记：把备份整份写回去；本来就是新建的（没有备份）就没什么可撤的。 */
export async function restoreClaudeOnboarding(
  entry: ClaudeOnboardingEntry,
  deps: Pick<CleanupFileDeps, 'readFile' | 'writeFile'> = {}
): Promise<RestoreResult> {
  const readFile = deps.readFile ?? defaultReadFile
  const writeFile = deps.writeFile ?? defaultWriteFile
  const name = CLAUDE_ONBOARDING_KEY
  if (!entry.changed || entry.backupPath === null) return { source: entry.path, name, outcome: 'already-restored' }
  try {
    const backup = await readFile(entry.backupPath)
    if (backup === undefined) return { source: entry.path, name, outcome: 'failed', reason: '备份文件不在了', backupPath: entry.backupPath }
    await writeFile(entry.path, backup)
    return { source: entry.path, name, outcome: 'restored' }
  } catch (error) {
    return { source: entry.path, name, outcome: 'failed', reason: reasonOf(error), backupPath: entry.backupPath }
  }
}
