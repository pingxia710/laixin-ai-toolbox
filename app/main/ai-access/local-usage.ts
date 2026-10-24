/**
 * 本机用量：官方不给接口时，只读壳自己写下的记录算个估算值。
 * 三条硬规矩：只读（⛔ 改壳的任何文件）、只统计次数与 Token（⛔ 碰对话内容）、
 * 读不到就说读不到（⛔ 拿 0 当答案）。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { LOCAL_USAGE_DAYS, type LocalUsage, type PlanUsageStatus } from '../../shared/plan-usage-types'

export type LocalUsageStatus = Extract<PlanUsageStatus, 'local' | 'not-installed' | 'no-records' | 'unreadable'>

export interface LocalUsageResult {
  readonly usage: LocalUsage | null
  readonly status: LocalUsageStatus
  /** 读到了一部分、另一部分被跳过（文件太大 / 超出文件数上限 / 读不动）：数字是残缺的，界面必须说出来。 */
  readonly partial?: boolean
}

export interface UsageDatabase {
  query(sql: string, parameter: number): readonly Record<string, unknown>[]
  close(): void
}

export type OpenUsageDatabase = (path: string) => Promise<UsageDatabase>

export interface LocalUsageOptions {
  readonly days?: number
  readonly now?: () => number
}

/** 一个会话文件再大也不该拖住界面：超过这个大小按读不动处理，并让状态说出来。 */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024
const MAX_SESSION_FILES = 4_000

function windowStart(options: LocalUsageOptions): { cut: number; days: number } {
  const days = options.days ?? LOCAL_USAGE_DAYS
  return { cut: (options.now ?? Date.now)() - days * 86_400_000, days }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/**
 * Kimi Code：每个会话的每个 agent 各写一份 wire.jsonl。
 * `usage.record` 是一次模型请求的 Token；`prompt.accepted` 只出现在主 agent，正好是「对话次数」。
 */
export async function readKimiCodeLocalUsage(home: string, options: LocalUsageOptions = {}): Promise<LocalUsageResult> {
  const root = join(home, '.kimi-code', 'sessions')
  if (!await exists(root)) return { usage: null, status: 'not-installed' }
  const { cut, days } = windowStart(options)
  let conversations = 0
  let requests = 0
  let tokens = 0
  let newestAt: number | null = null
  let wire: WireFiles
  // 目录整个读不动（权限之类）就是「读不出来」，⛔ 吞成「没有记录」。
  try { wire = await collectWireFiles(root, cut) } catch { return { usage: null, status: 'unreadable' } }
  let unreadable = wire.skipped
  for (const file of wire.files) {
    try {
      for await (const line of readLines(file)) {
        const event = record(safeParse(line))
        const at = positive(event?.time)
        if (!event || at < cut) continue
        if (event.type === 'prompt.accepted') { conversations += 1; newestAt = Math.max(newestAt ?? 0, at); continue }
        if (event.type !== 'usage.record') continue
        const usage = record(event.usage)
        if (!usage) continue
        requests += 1
        tokens += positive(usage.inputOther) + positive(usage.inputCacheRead) + positive(usage.inputCacheCreation) + positive(usage.output)
        newestAt = Math.max(newestAt ?? 0, at)
      }
    } catch { unreadable = true }
  }
  if (requests === 0 && conversations === 0) return { usage: null, status: unreadable ? 'unreadable' : 'no-records' }
  return unreadable
    ? { usage: { days, conversations, requests, tokens, newestAt }, status: 'local', partial: true }
    : { usage: { days, conversations, requests, tokens, newestAt }, status: 'local' }
}

interface WireFiles {
  readonly files: readonly string[]
  /** 有该统计的文件被跳过了（太大 / 超出文件数上限 / 属性读不动）：结果就不完整。 */
  readonly skipped: boolean
}

async function collectWireFiles(root: string, cut: number): Promise<WireFiles> {
  const files: string[] = []
  let skipped = false
  // 目录形状固定：sessions/<工作区>/<会话>/agents/<agent>/wire.jsonl。
  for (const workspace of await directories(root)) {
    for (const session of await directories(join(root, workspace))) {
      const agents = join(root, workspace, session, 'agents')
      for (const agent of await directories(agents)) {
        // 文件数上限在遍历阶段就收手，⛔ 先把几万条路径收齐再说读不动。
        if (files.length >= MAX_SESSION_FILES) return { files, skipped: true }
        const file = join(agents, agent, 'wire.jsonl')
        try {
          const info = await stat(file)
          // 整个文件都比统计窗口旧就跳过：省掉绝大部分读盘，这不算漏统计。
          if (!info.isFile() || info.mtimeMs < cut) continue
          // 太大的文件跳过是对的（⛔ 拖住界面），但漏掉多少必须让界面说出来。
          if (info.size > MAX_SESSION_FILE_BYTES) { skipped = true; continue }
          files.push(file)
        } catch (error) {
          // 没这个文件是常态（不是每个 agent 都写过 wire.jsonl）；读不动才是漏统计。
          if (!missing(error)) skipped = true
        }
      }
    }
  }
  return { files, skipped }
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT'
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    // 目录不在是正常的（那层还没建过）；权限之类的错误抛给上层报「读不出来」，⛔ 吞成「没有记录」。
    if (missing(error)) return []
    throw error
  }
}

function readLines(file: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
}

function safeParse(line: string): unknown {
  try { return JSON.parse(line) } catch { return null }
}

/**
 * 智谱 ZCode：CLI 与桌面端共用 `~/.zcode/cli/db/db.sqlite`，
 * 里面 `model_usage` 一行一次模型请求、`turn_usage` 一行一轮对话，都带 Token 数。
 */
export async function readZcodeLocalUsage(home: string, options: LocalUsageOptions & { readonly open?: OpenUsageDatabase } = {}): Promise<LocalUsageResult> {
  const path = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  if (!await exists(path)) return { usage: null, status: 'not-installed' }
  const { cut, days } = windowStart(options)
  let database: UsageDatabase | undefined
  try {
    database = await (options.open ?? openSqlite)(path)
    const [totals] = database.query('select count(*) as requests, coalesce(sum(computed_total_tokens), 0) as tokens, coalesce(max(started_at), 0) as newest from model_usage where started_at >= ?', cut)
    const requests = Math.trunc(positive(totals?.requests))
    const tokens = Math.trunc(positive(totals?.tokens))
    const newest = positive(totals?.newest)
    // 老版本没有 turn_usage：对话次数拿不到就报 0，其余照显示。
    let conversations = 0
    try {
      const [turns] = database.query('select count(*) as conversations from turn_usage where started_at >= ?', cut)
      conversations = Math.trunc(positive(turns?.conversations))
    } catch { conversations = 0 }
    if (requests === 0 && conversations === 0) return { usage: null, status: 'no-records' }
    return { usage: { days, conversations, requests, tokens, newestAt: newest > 0 ? newest : null }, status: 'local' }
  } catch {
    return { usage: null, status: 'unreadable' }
  } finally {
    try { database?.close() } catch { /* 关不上不影响已经读到的数 */ }
  }
}

/** node:sqlite 还是实验特性，延迟到真要读 ZCode 用量时才加载，⛔ 让每次启动都带一条警告。 */
const openSqlite: OpenUsageDatabase = async (path) => {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(path, { readOnly: true })
  return {
    query: (sql, parameter) => database.prepare(sql).all(parameter) as readonly Record<string, unknown>[],
    close: () => { database.close() }
  }
}
