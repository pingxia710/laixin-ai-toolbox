import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sanitizeFaultRecord, type FaultRecord } from '../../shared/fault-log-types'

/** 按天一个 JSON Lines 文件；文件名即日期，排序即时间顺序。 */
const namePattern = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface FaultLogFiles {
  list(): Promise<readonly string[]>
  read(name: string): Promise<string | undefined>
  write(name: string, contents: string): Promise<void>
  append(name: string, line: string): Promise<void>
  remove(name: string): Promise<void>
}

export interface FaultLogOptions {
  readonly files: FaultLogFiles
  readonly version?: () => string
  readonly now?: () => number
  /** 最多保留多少天。 */
  readonly days?: number
  /** 全部记录的总字节上限。 */
  readonly totalBytes?: number
  /** 单日文件字节上限，超了只留装得下的最新几行。 */
  readonly fileBytes?: number
  /** 同样的一条在这段时间内不重复记，防故障风暴把记录刷爆。 */
  readonly dedupeMs?: number
}

export type FaultInput = Omit<FaultRecord, 'at' | 'version'> & { readonly at?: string }

/**
 * 故障经过按天留存：客服要看的是「什么时候、哪个软件、哪一类问题、试过什么、结果如何」。
 * 写入前一律过 sanitizeFaultRecord，**⛔ Key、令牌、提示词与回复正文**；容量有硬上限，超了删最旧。
 */
export class FaultLog {
  private readonly options: Required<Omit<FaultLogOptions, 'files'>> & { files: FaultLogFiles }
  private lastSignature = ''
  private lastAt = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(options: FaultLogOptions) {
    this.options = {
      files: options.files,
      version: options.version ?? (() => ''),
      now: options.now ?? Date.now,
      days: options.days ?? 30,
      totalBytes: options.totalBytes ?? 2 * 1024 * 1024,
      fileBytes: options.fileBytes ?? 256 * 1024,
      dedupeMs: options.dedupeMs ?? 60_000
    }
  }

  /** 记一条；从不抛错（同步异常也不外泄）、从不阻塞调用方的主流程。 */
  record(input: FaultInput): Promise<void> {
    try {
      const at = this.options.now()
      const record = sanitizeFaultRecord({ ...input, at: input.at ?? new Date(at).toISOString(), version: this.options.version() })
      if (!record) return Promise.resolve()
      const signature = [record.shell, record.provider, record.code, record.action, record.outcome, record.network].join('|')
      if (signature === this.lastSignature && at - this.lastAt < this.options.dedupeMs) return Promise.resolve()
      this.lastSignature = signature
      this.lastAt = at
      return this.serialize(async () => {
        await this.options.files.append(dayName(at), `${JSON.stringify(record)}\n`)
        await this.prune()
      })
    } catch { return Promise.resolve() }
  }

  /** 最近的记录，新的在前；读到的内容同样过清洗，文件被改过也不会把脏东西带进摘要。 */
  async recent(limit = 20): Promise<readonly FaultRecord[]> {
    await this.queue
    const names = await this.days()
    const records: FaultRecord[] = []
    for (const name of [...names].reverse()) {
      const contents = await this.options.files.read(name)
      if (contents === undefined) continue
      for (const line of contents.split('\n').reverse()) {
        if (line.trim() === '') continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        const record = sanitizeFaultRecord(parsed)
        if (record) records.push(record)
        if (records.length >= limit) return records
      }
    }
    return records
  }

  private async days(): Promise<readonly string[]> {
    return (await this.options.files.list()).filter((name) => namePattern.test(name)).sort()
  }

  /** 先把超标的单日文件收到上限内，再按天数与总量删最旧。 */
  private async prune(): Promise<void> {
    let names = await this.days()
    const sizes = new Map<string, number>()
    for (const name of names) {
      const contents = await this.options.files.read(name)
      if (contents === undefined) continue
      if (contents.length > this.options.fileBytes) {
        // 留最新的、装得下的那些行；最新一行无论如何保留，⛔ 把当天记录清空。
        const lines = contents.split('\n').filter((line) => line.trim() !== '')
        const kept: string[] = []
        let size = 0
        for (const line of [...lines].reverse()) {
          if (kept.length > 0 && size + line.length + 1 > this.options.fileBytes) break
          kept.unshift(line)
          size += line.length + 1
        }
        const trimmed = kept.length ? `${kept.join('\n')}\n` : ''
        await this.options.files.write(name, trimmed)
        sizes.set(name, trimmed.length)
      } else sizes.set(name, contents.length)
    }
    const total = () => [...sizes.values()].reduce((sum, size) => sum + size, 0)
    while (names.length > this.options.days || (names.length > 1 && total() > this.options.totalBytes)) {
      const oldest = names[0]
      await this.options.files.remove(oldest)
      sizes.delete(oldest)
      names = names.slice(1)
    }
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task, task)
    this.queue = result.then(() => undefined, () => undefined)
    return this.queue
  }
}

function dayName(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`
}

/** 生产落盘：目录 0700、文件 0600，只追加、不跟随符号链接。 */
export function createFaultLogFiles(root: string): FaultLogFiles {
  const resolve = (name: string): string => {
    if (!namePattern.test(name)) throw new Error('FAULT_LOG_NAME_INVALID')
    return join(root, name)
  }
  const ensureRoot = async (): Promise<void> => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('FAULT_LOG_ROOT_INVALID')
  }
  return {
    async list() {
      try { return await readdir(root) } catch { return [] }
    },
    async read(name) {
      try {
        const path = resolve(name)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) return undefined
        return await readFile(path, 'utf8')
      } catch { return undefined }
    },
    async write(name, contents) {
      await ensureRoot()
      const path = resolve(name)
      const temporary = join(root, `.fault-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },
    async append(name, line) {
      await ensureRoot()
      await appendFile(resolve(name), line, { mode: 0o600 })
    },
    async remove(name) {
      await rm(resolve(name), { force: true })
    }
  }
}
