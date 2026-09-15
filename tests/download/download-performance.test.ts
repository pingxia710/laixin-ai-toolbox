import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
import { createFileTaskStore, sweepOrphanDownloadDirectories, taskPaths } from '../../app/main/download/task-store'
import { parseCatalog } from '../../app/main/download/catalog'
import type { ArtifactDigest, DownloadArtifactInspector, DownloadTaskStore, StoredDownloadTask, TunnelSnapshot } from '../../app/main/download/types'

const artifact = Buffer.from('fixture-dmg-bytes')
const sha256 = createHash('sha256').update(artifact).digest('hex')

const catalog = parseCatalog({
  catalogVersion: 'test',
  resources: [
    {
      id: 'fixture-dmg',
      software: 'Hermes',
      platform: 'macos',
      architecture: 'arm64',
      type: 'download',
      officialPageUrl: 'https://official.test/desktop',
      assetUrl: 'http://127.0.0.1:8080/Hermes.dmg',
      allowedHosts: ['127.0.0.1'],
      version: 'fixture',
      officialVersionLabel: 'fixture',
      format: 'dmg',
      expectedBytes: String(artifact.byteLength),
      officialSha256: sha256,
      recordedSha256: sha256,
      identity: null,
      approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
    }
  ]
})

const connectedTunnel: TunnelSnapshot = { state: 'connected', localProxyUrl: 'http://127.0.0.1:19080' }
const inspector: DownloadArtifactInspector = { inspect: async () => ({ kind: 'installer', identity: null }) }

class CountingTransfer implements DownloadTransfer {
  private readonly progressListeners: Array<(receivedBytes: number, totalBytes: number) => void> = []
  private readonly completionWaiters: Array<(value: DownloadCompletion) => void> = []
  private readonly completions: DownloadCompletion[] = []
  resumeCount = 0
  releaseCount = 0

  onProgress(listener: (receivedBytes: number, totalBytes: number) => void): void {
    this.progressListeners.push(listener)
  }

  async waitForCompletion(): Promise<DownloadCompletion> {
    const completion = this.completions.shift()
    if (completion !== undefined) return completion
    return new Promise((resolve) => this.completionWaiters.push(resolve))
  }

  cancel(): void { this.finish('cancelled') }
  resume(): void { this.resumeCount += 1 }

  async release(): Promise<void> { this.releaseCount += 1 }

  emitProgress(receivedBytes: number): void {
    this.progressListeners.forEach((listener) => listener(receivedBytes, artifact.byteLength))
  }

  finish(state: 'completed' | 'cancelled' | 'interrupted', canResume = false, mimeType = 'application/octet-stream'): void {
    this.completions.shift()
    const completion: DownloadCompletion = {
      state,
      receivedBytes: state === 'completed' ? artifact.byteLength : Math.floor(artifact.byteLength / 2),
      totalBytes: artifact.byteLength,
      canResume,
      etag: 'fixture-etag',
      lastModified: 'fixture-last-modified',
      mimeType,
      urlChain: ['http://127.0.0.1:8080/Hermes.dmg']
    }
    const waiter = this.completionWaiters.shift()
    if (waiter === undefined) this.completions.push(completion)
    else waiter(completion)
  }
}

class CountingEngine implements DownloadEngine {
  readonly transfers: CountingTransfer[] = []
  async start(): Promise<DownloadTransfer> {
    const transfer = new CountingTransfer()
    this.transfers.push(transfer)
    return transfer
  }
}

interface MemoryStoreOptions {
  /** 旧实现竞态注入:让满足条件的 save 拖后落盘。 */
  readonly saveDelayMs?: (task: StoredDownloadTask) => number
}

class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()
  readonly events: Array<Record<string, string>> = []
  readonly deletedParts: string[] = []
  readonly deletedArtifacts: string[] = []
  saveCount = 0
  hashArtifactCalls = 0
  artifactStatusResult: { size: number; mtimeMs: number } | undefined = { size: artifact.byteLength, mtimeMs: 1_000 }
  hashArtifactResult: ArtifactDigest | undefined = { byteLength: artifact.byteLength, sha256, mtimeMs: 1_000 }

  constructor(private readonly options: MemoryStoreOptions = {}) {}

  async save(task: StoredDownloadTask): Promise<void> {
    this.saveCount += 1
    const delay = this.options.saveDelayMs?.(task) ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    this.tasks.set(task.taskId, structuredClone(task))
  }

  async get(taskId: string): Promise<StoredDownloadTask | undefined> {
    const task = this.tasks.get(taskId)
    return task === undefined ? undefined : structuredClone(task)
  }

  async list(): Promise<StoredDownloadTask[]> {
    return [...this.tasks.values()].map((task) => structuredClone(task))
  }

  async appendEvent(event: Record<string, string>): Promise<void> {
    this.events.push(event)
  }

  async promotePart(task: StoredDownloadTask): Promise<void> {
    void task
  }
  async deletePart(task: StoredDownloadTask): Promise<void> {
    this.deletedParts.push(task.partPath)
  }
  async deleteArtifact(task: StoredDownloadTask): Promise<void> {
    this.deletedArtifacts.push(task.artifactPath)
  }
  async artifactStatus(): Promise<{ size: number; mtimeMs: number } | undefined> {
    return this.artifactStatusResult
  }
  async hashArtifact(): Promise<ArtifactDigest | undefined> {
    this.hashArtifactCalls += 1
    return this.hashArtifactResult
  }
}

const managers: DownloadManager[] = []

function createManager(
  engine: DownloadEngine,
  store: DownloadTaskStore,
  extra: { autoResumeLimit?: number; retryBackoffMs?: readonly number[] } = {}
) {
  const manager = new DownloadManager({
    catalog,
    engine,
    store,
    inspector,
    tunnel: () => connectedTunnel,
    taskId: (() => { let sequence = 0; return () => `task-${managers.length + 1}-${++sequence}` })(),
    ...extra
  })
  managers.push(manager)
  return { manager, engine: engine as CountingEngine, store }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
  vi.useRealTimers()
})

describe('下载进度落盘节流与写入串行化', () => {
  it('1000 次进度事件最多落盘 3 次:进度不再每个事件同步写盘', async () => {
    vi.useFakeTimers()
    const engine = new CountingEngine()
    const store = new MemoryStore()
    const { manager } = createManager(engine, store)
    const task = await manager.start('fixture-dmg')
    const transfer = engine.transfers[0]
    const savesBefore = store.saveCount
    for (let index = 1; index <= 1000; index += 1) transfer.emitProgress(index)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.saveCount - savesBefore).toBe(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(store.saveCount - savesBefore).toBeLessThanOrEqual(3)
    transfer.finish('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
  })

  it('进度回写与状态迁移并发时不互相覆盖(E-7):终态不被迟到的旧进度盖回 downloading', async () => {
    const engine = new CountingEngine()
    // 旧实现:进度写入(receivedBytes>0 且仍在 downloading)落盘拖 50ms,
    // 状态迁移先落盘;旧进度迟到后会把 ready 盖回 downloading。新实现按任务串行化,终态稳定。
    const store = new MemoryStore({ saveDelayMs: (task) => (task.state === 'downloading' && task.receivedBytes !== '0' ? 50 : 0) })
    const { manager } = createManager(engine, store)
    const task = await manager.start('fixture-dmg')
    const transfer = engine.transfers[0]
    transfer.emitProgress(10)
    transfer.finish('completed')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await manager.status(task.taskId)).state).toBe('ready')
  })

  it('终态迁移释放引擎会话资源', async () => {
    const engine = new CountingEngine()
    const { manager } = createManager(engine, new MemoryStore())
    const task = await manager.start('fixture-dmg')
    engine.transfers[0].finish('completed')
    await manager.waitForSettled(task.taskId)
    expect(engine.transfers[0].releaseCount).toBe(1)
  })
})

describe('重试指数退避', () => {
  it('自动恢复中断按 2s/8s/30s 退避,不再瞬间烧完重试次数', async () => {
    vi.useFakeTimers()
    const engine = new CountingEngine()
    const { manager } = createManager(engine, new MemoryStore(), { autoResumeLimit: 3, retryBackoffMs: [2_000, 8_000, 30_000] })
    const task = await manager.start('fixture-dmg')
    const transfer = engine.transfers[0]

    transfer.finish('interrupted', true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_900)
    expect(transfer.resumeCount).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(transfer.resumeCount).toBe(1)

    transfer.finish('interrupted', true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(7_900)
    expect(transfer.resumeCount).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(transfer.resumeCount).toBe(2)

    transfer.finish('interrupted', true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(29_900)
    expect(transfer.resumeCount).toBe(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(transfer.resumeCount).toBe(3)
    expect((await manager.status(task.taskId)).state).toBe('downloading')
  })
})

describe('启动恢复跳过未变大安装包的重算', () => {
  it('size+mtime 与核验记录一致时不读文件内容不重算哈希;文件变化才重算', async () => {
    const engine = new CountingEngine()
    const store = new MemoryStore()
    const { manager } = createManager(engine, store)
    const task = await manager.start('fixture-dmg')
    engine.transfers[0].finish('completed')
    const ready = await manager.waitForSettled(task.taskId)
    expect(ready.state).toBe('ready')
    expect(ready.artifactSize).toBe(String(artifact.byteLength))
    expect(ready.artifactMtimeMs).toBe('1000')

    const hashCallsAfterReady = store.hashArtifactCalls
    const reopened = createManager(new CountingEngine(), store).manager
    await reopened.recoverAfterRestart()
    expect(store.hashArtifactCalls).toBe(hashCallsAfterReady)
    expect(await reopened.latest('fixture-dmg')).toMatchObject({ taskId: task.taskId, state: 'ready' })

    // 文件变了(mtime 变):允许重算;摘要与记录一致则仍保留。
    const changedStore = new MemoryStore()
    changedStore.artifactStatusResult = { size: artifact.byteLength, mtimeMs: 2_000 }
    changedStore.tasks.set(task.taskId, structuredClone(ready))
    const changedManager = createManager(new CountingEngine(), changedStore).manager
    await changedManager.recoverAfterRestart()
    expect(changedStore.hashArtifactCalls).toBe(1)
    expect(await changedManager.latest('fixture-dmg')).toMatchObject({ state: 'ready' })
  })

  it('安装包已不在原处时按原语义判失败并清理', async () => {
    const engine = new CountingEngine()
    const store = new MemoryStore()
    const { manager } = createManager(engine, store)
    const task = await manager.start('fixture-dmg')
    engine.transfers[0].finish('completed')
    await manager.waitForSettled(task.taskId)
    const ready = await manager.status(task.taskId)

    const missingStore = new MemoryStore()
    missingStore.artifactStatusResult = undefined
    missingStore.hashArtifactResult = undefined
    missingStore.tasks.set(task.taskId, structuredClone(ready))
    const reopened = createManager(new CountingEngine(), missingStore).manager
    await reopened.recoverAfterRestart()
    expect(missingStore.deletedArtifacts).toContain(ready.artifactPath)
    expect(await reopened.latest('fixture-dmg')).toMatchObject({ state: 'failed', reason: 'artifact-unavailable' })
  })
})

describe('终态中断清理', () => {
  it('终止中断删除分段文件并释放引擎资源', async () => {
    const engine = new CountingEngine()
    const store = new MemoryStore()
    const { manager } = createManager(engine, store, { autoResumeLimit: 0 })
    const task = await manager.start('fixture-dmg')
    const partsBefore = store.deletedParts.length
    engine.transfers[0].finish('interrupted', false)
    await manager.waitForSettled(task.taskId)
    expect((await manager.status(task.taskId)).state).toBe('interrupted-terminal')
    expect(store.deletedParts.length).toBe(partsBefore + 1)
    expect(engine.transfers[0].releaseCount).toBeGreaterThanOrEqual(1)
  })

  it('可续传中断保留分段,等待退避或人工恢复', async () => {
    const engine = new CountingEngine()
    const store = new MemoryStore()
    const { manager } = createManager(engine, store, { autoResumeLimit: 0 })
    const task = await manager.start('fixture-dmg')
    const partsBefore = store.deletedParts.length
    engine.transfers[0].finish('interrupted', true)
    await manager.waitForSettled(task.taskId)
    expect((await manager.status(task.taskId)).state).toBe('interrupted-resumable')
    expect(store.deletedParts.length).toBe(partsBefore)
  })
})

describe('孤儿目录清扫', () => {
  it('只删除无任务引用的下载目录,被引用目录原样保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-sweep-'))
    try {
      const resource = catalog.resources[0]
      const kept = taskPaths(root, 'task-kept', resource)
      await mkdir(dirname(kept.artifactPath), { recursive: true })
      await writeFile(kept.artifactPath, 'artifact')
      const orphanDir = join(root, 'downloads', 'Hermes', 'fixture', 'task-orphan')
      await mkdir(orphanDir, { recursive: true })
      await writeFile(join(orphanDir, 'installer.part'), 'leftover')
      const tasks: StoredDownloadTask[] = [{
        taskId: 'task-kept', resourceId: resource.id, authorizationId: '', state: 'ready', reason: '', message: '',
        receivedBytes: '0', totalBytes: '0', retryCount: '0', resumeEtag: '', resumeLastModified: '', localSha256: '',
        artifactPath: kept.artifactPath, partPath: kept.partPath, startedAt: '', endedAt: ''
      }]
      const removed = await sweepOrphanDownloadDirectories(root, tasks)
      expect(removed).toBe(1)
      await expect(stat(kept.artifactPath)).resolves.toBeTruthy()
      await expect(stat(orphanDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('文件任务存储流式哈希', () => {
  it('300MB 安装包核验进程 RSS 增量 < 50MB,摘要正确', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-stream-hash-'))
    try {
      const store = createFileTaskStore(root)
      const resource = catalog.resources[0]
      const paths = taskPaths(root, 'task-big', resource)
      await mkdir(dirname(paths.artifactPath), { recursive: true })
      const chunk = Buffer.alloc(1024 * 1024, 7)
      const handle = await open(paths.artifactPath, 'w')
      try {
        for (let index = 0; index < 300; index += 1) await handle.writeFile(chunk)
      } finally { await handle.close() }
      const task: StoredDownloadTask = {
        taskId: 'task-big', resourceId: resource.id, authorizationId: '', state: 'verifying', reason: '', message: '',
        receivedBytes: '0', totalBytes: '0', retryCount: '0', resumeEtag: '', resumeLastModified: '', localSha256: '',
        artifactPath: paths.artifactPath, partPath: paths.partPath, startedAt: '', endedAt: ''
      }
      const rssBefore = process.memoryUsage().rss
      const digest = await store.hashArtifact(task)
      const rssAfter = process.memoryUsage().rss
      expect(digest?.byteLength).toBe(300 * 1024 * 1024)
      const expected = createHash('sha256')
      for await (const piece of createReadStream(paths.artifactPath)) expected.update(piece as Buffer)
      expect(digest?.sha256).toBe(expected.digest('hex'))
      expect(rssAfter - rssBefore).toBeLessThan(50 * 1024 * 1024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
