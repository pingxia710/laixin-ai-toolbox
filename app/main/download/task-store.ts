import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { DownloadResource, DownloadTaskStore, StoredDownloadTask } from './types'

// 下载事件账本按体积轮转:当前文件 + 一份归档,⛔ 无限追加。
export const EVENT_LEDGER_MAX_BYTES = 5 * 1024 * 1024
export const EVENT_LEDGER_ARCHIVES_KEPT = 1

export function taskPaths(root: string, taskId: string, resource: DownloadResource): { readonly artifactPath: string; readonly partPath: string } {
  const directory = join(root, 'downloads', resource.software, resource.version, taskId)
  const filename = resource.format === undefined ? 'installer' : `${resource.id}.${resource.format}`
  const artifactPath = withinRoot(root, join(directory, filename))
  return { artifactPath, partPath: withinRoot(root, `${artifactPath}.part`) }
}

export function createFileTaskStore(root: string): DownloadTaskStore {
  const recordsRoot = withinRoot(root, 'download-records')
  const ledgerPath = withinRoot(root, 'download-events.jsonl')
  return {
    save: async (task) => {
      const taskPath = withinRoot(recordsRoot, `${task.taskId}.json`)
      await mkdir(dirname(taskPath), { recursive: true })
      await mkdir(dirname(withinRoot(root, task.artifactPath)), { recursive: true })
      const temporaryPath = `${taskPath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(task), 'utf8')
      await rename(temporaryPath, taskPath)
    },
    get: async (taskId) => readTask(recordsRoot, taskId),
    list: async () => listTasks(recordsRoot),
    appendEvent: async (event) => {
      await mkdir(dirname(ledgerPath), { recursive: true })
      await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8')
      await rotateEventLedger(ledgerPath)
    },
    promotePart: async (task) => {
      if (task.partPath === '' || task.artifactPath === '') return
      await rename(withinRoot(root, task.partPath), withinRoot(root, task.artifactPath))
    },
    deletePart: async (task) => removeTaskPath(root, task.partPath),
    deleteArtifact: async (task) => removeTaskPath(root, task.artifactPath),
    artifactStatus: async (task) => {
      if (task.artifactPath === '') return undefined
      try {
        const info = await stat(withinRoot(root, task.artifactPath))
        return { size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return undefined
      }
    },
    hashArtifact: async (task) => {
      if (task.artifactPath === '') return undefined
      const path = withinRoot(root, task.artifactPath)
      try {
        const info = await stat(path)
        // 大安装包只流过固定小缓冲,⛔ readFile 整包进内存。
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        return { byteLength: info.size, sha256: hash.digest('hex'), mtimeMs: info.mtimeMs }
      } catch {
        return undefined
      }
    }
  }
}

async function rotateEventLedger(ledgerPath: string): Promise<void> {
  const info = await stat(ledgerPath).catch(() => undefined)
  if (info === undefined || info.size <= EVENT_LEDGER_MAX_BYTES) return
  for (let index = EVENT_LEDGER_ARCHIVES_KEPT; index >= 1; index -= 1) {
    const archive = index === 1 ? `${ledgerPath}.1` : `${ledgerPath}.${index - 1}`
    const target = `${ledgerPath}.${index}`
    if (index === EVENT_LEDGER_ARCHIVES_KEPT) await rm(target, { force: true })
    else await rename(archive, target).catch(() => undefined)
  }
  await rename(ledgerPath, `${ledgerPath}.1`).catch(() => undefined)
}

/** 启动清扫:删除没有任何任务记录引用的下载目录,被任务引用的目录一律保留。 */
export async function sweepOrphanDownloadDirectories(root: string, tasks: readonly StoredDownloadTask[]): Promise<number> {
  const referenced = new Set<string>()
  for (const task of tasks) {
    for (const value of [task.artifactPath, task.partPath]) {
      if (value === '') continue
      let directory: string
      try { directory = dirname(withinRoot(root, value)) } catch { continue }
      referenced.add(relative(root, directory))
    }
  }
  const downloadsRoot = withinRoot(root, 'downloads')
  let removed = 0
  const softwareEntries = await withFileTypesSafe(downloadsRoot)
  for (const software of softwareEntries.filter((entry) => entry.isDirectory())) {
    const versionEntries = await withFileTypesSafe(join(downloadsRoot, software.name))
    for (const version of versionEntries.filter((entry) => entry.isDirectory())) {
      const taskEntries = await withFileTypesSafe(join(downloadsRoot, software.name, version.name))
      for (const entry of taskEntries.filter((item) => item.isDirectory())) {
        const directory = join(downloadsRoot, software.name, version.name, entry.name)
        if (referenced.has(relative(root, directory))) continue
        await rm(directory, { recursive: true, force: true })
        removed += 1
      }
    }
  }
  return removed
}

async function withFileTypesSafe(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readTask(recordsRoot: string, taskId: string): Promise<StoredDownloadTask | undefined> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(taskId)) {
    return undefined
  }
  let contents: string
  try { contents = await readFile(withinRoot(recordsRoot, `${taskId}.json`), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('DOWNLOAD_STORAGE_UNAVAILABLE', { cause: error })
  }
  try {
    const task: unknown = JSON.parse(contents)
    if (typeof task !== 'object' || task === null || Array.isArray(task)) return undefined
    const value = task as Record<string, unknown>
    const fields = ['taskId', 'resourceId', 'authorizationId', 'state', 'reason', 'message', 'receivedBytes', 'totalBytes', 'retryCount', 'resumeEtag', 'resumeLastModified', 'localSha256', 'artifactPath', 'partPath', 'startedAt', 'endedAt']
    return value.taskId === taskId && fields.every((field) => typeof value[field] === 'string') ? task as StoredDownloadTask : undefined
  } catch {
    return undefined
  }
}

async function listTasks(recordsRoot: string): Promise<StoredDownloadTask[]> {
  try {
    const records = await readdir(recordsRoot, { withFileTypes: true })
    const tasks = await Promise.all(
      records
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readTask(recordsRoot, entry.name.slice(0, -5)))
    )
    return tasks.filter((task): task is StoredDownloadTask => task !== undefined)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('DOWNLOAD_STORAGE_UNAVAILABLE', { cause: error })
  }
}

async function removeTaskPath(root: string, path: string): Promise<void> {
  if (path === '') {
    return
  }
  await rm(withinRoot(root, path), { force: true })
}

function withinRoot(root: string, ...segments: string[]): string {
  const candidate = segments.length === 1 && isAbsolute(segments[0]) ? segments[0] : join(root, ...segments)
  const normalized = relative(root, candidate)
  if (normalized === '' || (!normalized.startsWith('..') && !normalized.includes('../'))) {
    return candidate
  }
  throw new Error('DOWNLOAD_STORAGE_PATH_INVALID')
}
