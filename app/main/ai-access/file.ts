import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ManagedTextFile } from './deepseek-config'
import { symlinkMarkedError } from './configuration-target'

export type AppendTextResult = 'appended' | 'changed'
export type CreateTextResult = 'created' | 'exists' | 'changed'

/**
 * These are deliberately append/create-only operations. Node has no cross-platform primitive
 * that conditionally replaces an existing file by expected inode and contents, so callers must
 * never use this adapter to rewrite a customer file after a comparison.
 */
export interface AppendOnlyTextFile {
  appendIfCurrent(path: string, expected: string, contents: string): Promise<AppendTextResult>
  createIfMissing(path: string, contents: string): Promise<CreateTextResult>
}

/** Test-only hook: runs after the descriptor comparison and before the append write. */
export interface ManagedTextFileOptions {
  readonly beforeAppend?: (path: string) => Promise<void> | void
}

const maxTextFileBytes = 128 * 1024

/** The file at `path` is a symlink; resolve where it really points so the notice can say so. */
async function symlinkFailure(path: string): Promise<Error> {
  let target = '(目标不存在)'
  try { target = await realpath(path) } catch { /* 链断了也照实说 */ }
  return symlinkMarkedError(path, target)
}

/** A small file adapter that never follows a final-path symlink and never shells out. */
export function createManagedTextFile(options: ManagedTextFileOptions = {}): ManagedTextFile & AppendOnlyTextFile {
  const read = async (path: string): Promise<string | undefined> => {
    let info: Stats
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
    }
    // 软链单独标记：调用方要说清真身在哪，⛔ 只回一句「无效」。
    if (info.isSymbolicLink()) return Promise.reject(await symlinkFailure(path))
    if (!info.isFile() || info.size > maxTextFileBytes) throw new Error('AI_ACCESS_CONFIG_FILE_INVALID')
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
    }
  }

  const ensureParent = async (path: string): Promise<void> => {
    const parent = dirname(path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const directory = await lstat(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('AI_ACCESS_CONFIG_FILE_INVALID')
  }

  const createTemporary = async (path: string, contents: string): Promise<string> => {
    await ensureParent(path)
    const temporary = join(dirname(path), `.laixin-ai-access-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
      return temporary
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  const write = async (path: string, contents: string): Promise<void> => {
    let temporary: string | undefined
    try {
      const existing = await existingFile(path)
      if (existing === 'invalid') throw new Error('AI_ACCESS_CONFIG_FILE_INVALID')
      temporary = await createTemporary(path, contents)
      await rename(temporary, path)
      temporary = undefined
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
    }
  }

  return {
    read,
    write,

    async appendIfCurrent(path, expected, contents) {
      const initial = await stableSnapshot(path)
      if (initial === undefined || initial.contents !== expected || initial.identity === undefined) return 'changed'

      let handle: FileHandle | undefined
      try {
        // O_NOFOLLOW protects the final component on POSIX. Windows does not expose that flag,
        // but the pre-open and descriptor snapshots still fail closed when the source changes.
        const flags = constants.O_RDWR | constants.O_APPEND | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
        handle = await open(path, flags)
        if (!sameSnapshot(initial, await stableHandleSnapshot(handle))) return 'changed'

        await options.beforeAppend?.(path)
        if (!sameSnapshot(initial, await stableHandleSnapshot(handle))) return 'changed'

        // O_APPEND makes this one kernel append; it never seeks back and replaces customer bytes.
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } catch (error) {
        if (error instanceof Error && error.message === 'AI_ACCESS_CONFIG_FILE_INVALID') throw error
        throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
      } finally {
        await handle?.close().catch(() => undefined)
      }

      const latest = await stableSnapshot(path)
      return latest !== undefined && latest.contents === `${expected}${contents}` ? 'appended' : 'changed'
    },

    async createIfMissing(path, contents) {
      try {
        await ensureParent(path)
        await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
      }
      return await read(path) === contents ? 'created' : 'changed'
    },

    async remove(path) {
      const existing = await existingFile(path)
      if (existing === 'missing') return
      if (existing === 'invalid') throw new Error('AI_ACCESS_CONFIG_FILE_INVALID')
      try { await rm(path) } catch (error) { throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error }) }
    },

    async list(dir) {
      try {
        const info = await lstat(dir)
        if (!info.isDirectory() || info.isSymbolicLink()) return []
        return await readdir(dir)
      } catch {
        return []
      }
    }
  }
}

interface StableFileSnapshot {
  readonly contents: string | undefined
  readonly identity: FileIdentity | undefined
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

/** Two metadata checks bracket each read so a detected race fails before any append occurs. */
async function stableSnapshot(path: string): Promise<StableFileSnapshot | undefined> {
  let before: Stats
  try {
    before = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { contents: undefined, identity: undefined }
    throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
  }
  if (!validFile(before)) throw new Error('AI_ACCESS_CONFIG_FILE_INVALID')
  const contents = await readFile(path, 'utf8')
  let after: Stats
  try {
    after = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('AI_ACCESS_CONFIG_FILE_INVALID', { cause: error })
  }
  if (!validFile(after) || !sameIdentity(identity(before), identity(after))) return undefined
  return { contents, identity: identity(after) }
}

/** The descriptor stays pinned to the inode we compared; a replacement at the path cannot pass. */
async function stableHandleSnapshot(handle: FileHandle): Promise<StableFileSnapshot | undefined> {
  const before = await handle.stat()
  if (!validFile(before)) return undefined
  const buffer = Buffer.alloc(before.size)
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
  const after = await handle.stat()
  if (bytesRead !== buffer.length || !validFile(after) || !sameIdentity(identity(before), identity(after))) return undefined
  return { contents: buffer.toString('utf8'), identity: identity(after) }
}

function validFile(value: Stats): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.size <= maxTextFileBytes
}

function identity(value: Stats): FileIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs }
}

function sameSnapshot(left: StableFileSnapshot, right: StableFileSnapshot | undefined): boolean {
  return right !== undefined && left.contents === right.contents && sameIdentity(left.identity, right.identity)
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left === undefined || right === undefined ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
      left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function existingFile(path: string): Promise<'present' | 'missing' | 'invalid'> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() ? 'present' : 'invalid'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'
  }
}
