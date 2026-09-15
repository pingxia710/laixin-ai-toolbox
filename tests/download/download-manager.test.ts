import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDownloadActions } from '../../app/main/actions/download'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
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
    },
    {
      id: 'external-fixture',
      software: 'Hermes',
      platform: 'macos',
      architecture: 'arm64',
      type: 'external-entry',
      officialPageUrl: 'https://official.test/store',
      allowedHosts: ['official.test'],
      version: 'fixture',
      officialVersionLabel: 'fixture',
      approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
    }
  ]
})

class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()
  readonly events: Array<Record<string, string>> = []

  async save(task: StoredDownloadTask): Promise<void> {
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
    void task
  }
  async deleteArtifact(task: StoredDownloadTask): Promise<void> {
    void task
  }
  async artifactStatus(task: StoredDownloadTask): Promise<{ size: number; mtimeMs: number } | undefined> {
    void task
    return { size: artifact.byteLength, mtimeMs: 1_000 }
  }
  async hashArtifact(task: StoredDownloadTask): Promise<ArtifactDigest | undefined> {
    void task
    return { byteLength: artifact.byteLength, sha256, mtimeMs: 1_000 }
  }
}

class ControlledTransfer implements DownloadTransfer {
  private readonly progressListeners: Array<(receivedBytes: number, totalBytes: number) => void> = []
  private readonly completionWaiters: Array<(value: DownloadCompletion) => void> = []
  cancelled = false
  resumed = false

  onProgress(listener: (receivedBytes: number, totalBytes: number) => void): void {
    this.progressListeners.push(listener)
  }

  waitForCompletion(): Promise<DownloadCompletion> {
    return new Promise((resolve) => this.completionWaiters.push(resolve))
  }

  cancel(): void {
    this.cancelled = true
    this.finish('cancelled', false)
  }

  resume(): void {
    this.resumed = true
  }

  emitProgress(receivedBytes: number): void {
    this.progressListeners.forEach((listener) => listener(receivedBytes, artifact.byteLength))
  }

  finish(state: 'completed' | 'cancelled' | 'interrupted', canResume = false, mimeType = 'application/octet-stream'): void {
    const resolve = this.completionWaiters.shift()
    resolve?.({
      state,
      receivedBytes: state === 'completed' ? artifact.byteLength : Math.floor(artifact.byteLength / 2),
      totalBytes: artifact.byteLength,
      canResume,
      etag: 'fixture-etag',
      lastModified: 'fixture-last-modified',
      mimeType,
      urlChain: ['http://127.0.0.1:8080/Hermes.dmg']
    })
  }
}

class FakeEngine implements DownloadEngine {
  readonly starts: Array<{ readonly taskId: string; readonly proxyUrl: string }> = []
  readonly transfers: ControlledTransfer[] = []

  async start(request: Parameters<DownloadEngine['start']>[0]): Promise<DownloadTransfer> {
    this.starts.push({ taskId: request.taskId, proxyUrl: request.proxyUrl })
    const transfer = new ControlledTransfer()
    this.transfers.push(transfer)
    return transfer
  }
}

const connectedTunnel: TunnelSnapshot = { state: 'connected', localProxyUrl: 'http://127.0.0.1:19080' }
const stoppedTunnel: TunnelSnapshot = { state: 'stopped', localProxyUrl: undefined }
const inspector: DownloadArtifactInspector = {
  inspect: async () => ({ kind: 'installer', identity: null })
}

const managers: DownloadManager[] = []

function createManager(
  tunnel: TunnelSnapshot,
  engine = new FakeEngine(),
  store = new MemoryStore(),
  hasExistingInstallation = () => false,
  resourceCatalog = catalog
) {
  let sequence = 0
  const manager = new DownloadManager({
    catalog: resourceCatalog,
    engine,
    store,
    inspector,
    tunnel: () => tunnel,
    hasExistingInstallation,
    externalOpen: async () => undefined,
    taskId: () => `task-${managers.length + 1}-${++sequence}`,
    autoResumeLimit: 0
  })
  managers.push(manager)
  return { manager, engine, store }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
})

it('退出后的未完成下载保留中断原因，重试产生新任务；完整安装包不重复下载', async () => {
  const { manager, engine, store } = createManager(connectedTunnel)
  const first = await manager.start('fixture-dmg')
  await manager.dispose()
  const reopened = createManager(connectedTunnel, new FakeEngine(), store).manager
  await reopened.recoverAfterRestart()
  expect(await reopened.latest('fixture-dmg')).toMatchObject({ taskId: first.taskId, state: 'interrupted-terminal', reason: 'app-restarted' })
  expect(engine.starts).toHaveLength(1)
  expect((await reopened.retry(first.taskId)).taskId).not.toBe(first.taskId)
})

it('安装包打开失败保留已核验文件，下一次只重新核验并打开，不再下载', async () => {
  const engine = new FakeEngine(); const store = new MemoryStore(); let attempts = 0
  const manager = new DownloadManager({ catalog, engine, store, inspector, tunnel: () => connectedTunnel,
    installerHandoff: async () => { if (++attempts === 1) throw new Error('temporary open failure'); return 'opened' } })
  managers.push(manager)
  const task = await manager.start('fixture-dmg'); engine.transfers[0].finish('completed'); await manager.waitForSettled(task.taskId)
  expect(await manager.openInstaller(task.taskId)).toMatchObject({ state: 'ready', reason: 'installer-open-failed' })
  expect(await manager.openInstaller(task.taskId)).toMatchObject({ state: 'handed-off-install' })
  expect(engine.starts).toHaveLength(1)
})

describe('下载任务状态机', () => {
  function multiSourceCatalog() {
    return { ...catalog, resources: [{ ...catalog.resources[0], sources: [
      { id: 'overseas', assetUrl: 'http://127.0.0.1:8080/remote.dmg', allowedHosts: ['127.0.0.1'], network: 'tunnel' as const },
      { id: 'domestic-a', assetUrl: 'http://127.0.0.1:8080/primary.dmg', allowedHosts: ['127.0.0.1'], network: 'direct' as const },
      { id: 'domestic-b', assetUrl: 'http://127.0.0.1:8080/backup.dmg', allowedHosts: ['127.0.0.1'], network: 'direct' as const }
    ] }] }
  }

  class SourceEngine extends FakeEngine {
    readonly requests: Parameters<DownloadEngine['start']>[0][] = []
    failFirstStart = false
    override async start(request: Parameters<DownloadEngine['start']>[0]): Promise<DownloadTransfer> {
      this.requests.push(request)
      if (this.failFirstStart && this.requests.length === 1) throw new Error('local fixture network failure')
      return super.start(request)
    }
  }

  it('国内直连下载不需要订阅通道，并优先于列表里的境外来源', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    expect(task.state).toBe('downloading')
    expect(sourceEngine.requests[0]).toMatchObject({ network: 'direct', proxyUrl: '', assetUrl: 'http://127.0.0.1:8080/primary.dmg' })
    sourceEngine.transfers[0].finish('completed')
    expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
  })

  it('主渠道启动失败会换备用渠道，同一任务仍执行原包校验', async () => {
    const sourceEngine = new SourceEngine()
    sourceEngine.failFirstStart = true
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    expect(sourceEngine.requests.map((r) => r.assetUrl)).toEqual(['http://127.0.0.1:8080/primary.dmg', 'http://127.0.0.1:8080/backup.dmg'])
    expect(new Set(sourceEngine.requests.map((r) => r.taskId)).size).toBe(1)
    sourceEngine.transfers[0].finish('completed')
    expect((await manager.waitForSettled(task.taskId)).localSha256).toBe(sha256)
  })

  it('中途不可恢复的断网换备用源，但备用源返回网页仍拒绝安装', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    sourceEngine.transfers[0].finish('interrupted')
    await expect.poll(() => sourceEngine.transfers.length).toBe(2)
    sourceEngine.transfers[1].finish('completed', false, 'text/html')
    expect(await manager.waitForSettled(task.taskId)).toMatchObject({ state: 'failed', reason: 'not-installer' })
    expect(sourceEngine.requests.length).toBe(2)
  })

  it('境外备用只在通道可用时使用；无通道不会偷偷直接访问', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    sourceEngine.transfers[0].finish('interrupted')
    await expect.poll(() => sourceEngine.transfers.length).toBe(2)
    sourceEngine.transfers[1].finish('interrupted')
    expect((await manager.waitForSettled(task.taskId)).state).toBe('needs-tunnel')
    expect(sourceEngine.requests.every((r) => r.network === 'direct')).toBe(true)
  })

  it('可恢复中断用完自动重试次数后取消旧下载并换渠道', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    sourceEngine.transfers[0].finish('interrupted', true)
    await expect.poll(() => sourceEngine.transfers.length).toBe(2)
    expect(sourceEngine.transfers[0].cancelled).toBe(true)
    sourceEngine.transfers[1].finish('completed')
    expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
  })

  it('已有通道时可在两个直连渠道失败后使用境外备用', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(connectedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    sourceEngine.transfers[0].finish('interrupted')
    await expect.poll(() => sourceEngine.transfers.length).toBe(2)
    sourceEngine.transfers[1].finish('interrupted')
    await expect.poll(() => sourceEngine.transfers.length).toBe(3)
    expect(sourceEngine.requests[2]).toMatchObject({ network: 'tunnel', proxyUrl: connectedTunnel.localProxyUrl })
    sourceEngine.transfers[2].finish('completed')
    expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
  })

  it('客户取消下载后不会启动备用来源', async () => {
    const sourceEngine = new SourceEngine()
    const { manager } = createManager(stoppedTunnel, sourceEngine, new MemoryStore(), () => false, multiSourceCatalog())
    const task = await manager.start('fixture-dmg')
    await manager.cancel(task.taskId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sourceEngine.requests.length).toBe(1)
    expect((await manager.status(task.taskId)).state).toBe('cancelled')
  })

  it('通道未接时拒起且下载引擎零请求', async () => {
    const { manager, engine } = createManager(stoppedTunnel)

    await expect(manager.start('fixture-dmg')).resolves.toMatchObject({ state: 'needs-tunnel', message: '先接通道' })
    expect(engine.starts).toEqual([])
  })

  it('已有安装痕迹时先要求确认且不覆盖、不启动下载', async () => {
    const { manager, engine } = createManager(connectedTunnel, new FakeEngine(), new MemoryStore(), () => true)

    await expect(manager.start('fixture-dmg')).resolves.toMatchObject({
      state: 'not-downloaded',
      message: '检测到已安装，请先确认'
    })
    expect(engine.starts).toEqual([])
  })

  it('只将本地代理地址交给引擎，完成后记录独立下载字节与本地摘要', async () => {
    const { manager, engine, store } = createManager(connectedTunnel)
    const started = await manager.start('fixture-dmg')
    engine.transfers[0].emitProgress(4)
    engine.transfers[0].finish('completed')
    await manager.waitForSettled(started.taskId)

    await expect(manager.status(started.taskId)).resolves.toMatchObject({
      state: 'ready',
      receivedBytes: String(artifact.byteLength),
      localSha256: sha256,
      message: '官方值一致'
    })
    expect(engine.starts).toEqual([{ taskId: started.taskId, proxyUrl: 'http://127.0.0.1:19080' }])
    expect(store.events).toContainEqual(expect.objectContaining({ bytes: String(artifact.byteLength), result: 'ready' }))
    expect(JSON.stringify(store.events)).not.toContain('通道用量')
  })

  it('可恢复中断只在同一进程 resume；终止中断只能 retry 新任务', async () => {
    const { manager, engine } = createManager(connectedTunnel)
    const resumable = await manager.start('fixture-dmg')
    engine.transfers[0].finish('interrupted', true)
    await manager.waitForSettled(resumable.taskId)
    await expect(manager.resume(resumable.taskId)).resolves.toMatchObject({ state: 'downloading' })
    expect(engine.transfers[0].resumed).toBe(true)

    await manager.cancel(resumable.taskId)
    const terminal = await manager.start('fixture-dmg')
    engine.transfers[1].finish('interrupted', false)
    await manager.waitForSettled(terminal.taskId)
    await expect(manager.resume(terminal.taskId)).rejects.toThrow('DOWNLOAD_RESUME_NOT_ALLOWED')
    await expect(manager.retry(terminal.taskId)).resolves.toMatchObject({ taskId: expect.not.stringMatching(new RegExp(`^${terminal.taskId}$`)) })
  })

  it('取消会清理任务临时文件且不自动重下；外部入口零字节只交接安装器', async () => {
    const { manager, engine } = createManager(connectedTunnel)
    const started = await manager.start('fixture-dmg')
    await expect(manager.cancel(started.taskId)).resolves.toMatchObject({ state: 'cancelled' })
    expect(engine.transfers[0].cancelled).toBe(true)
    await expect(manager.openExternal('external-fixture')).resolves.toMatchObject({
      state: 'handed-off-install',
      receivedBytes: '0',
      message: '已交给系统打开 / 安装待核'
    })
  })
})

// 审计 R5(2026-09-12 上线检查):下载终态只释放引擎,不从活动表移除传输对象。
// 证据 evidence/repro-download-retention.json:三次下载均 ready,active.size 仍为 3。
describe('终态从活动表移除传输对象(审计 R5)', () => {
  const activeOf = (manager: DownloadManager): Map<string, unknown> =>
    (manager as unknown as { active: Map<string, unknown> }).active

  it('三次下载完成后活动表清空,不随完成次数累积', async () => {
    const { manager, engine } = createManager(connectedTunnel)
    for (let round = 0; round < 3; round += 1) {
      const task = await manager.start('fixture-dmg')
      engine.transfers.at(-1)!.finish('completed')
      expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
    }
    expect(activeOf(manager).size).toBe(0)
  })

  it('引擎侧取消与不可恢复中断的终态同样移除活动传输', async () => {
    const cancelled = createManager(connectedTunnel)
    const c1 = await cancelled.manager.start('fixture-dmg')
    cancelled.engine.transfers[0].finish('cancelled')
    expect((await cancelled.manager.waitForSettled(c1.taskId)).state).toBe('cancelled')
    expect(activeOf(cancelled.manager).size).toBe(0)

    const interrupted = createManager(connectedTunnel)
    const c2 = await interrupted.manager.start('fixture-dmg')
    interrupted.engine.transfers[0].finish('interrupted', false)
    expect((await interrupted.manager.waitForSettled(c2.taskId)).state).toBe('interrupted-terminal')
    expect(activeOf(interrupted.manager).size).toBe(0)
  })
})

describe('下载校验三态:签名是信任根,快照只判「变没变」', () => {
  const updatedArtifact = Buffer.from('fixture-dmg-bytes-official-v2')
  const pinnedSigningSubject = 'Developer ID Application: Fixture (TEAMID0000)'
  const pinnedCatalog = parseCatalog({
    catalogVersion: 'test',
    resources: [
      {
        id: 'pinned-dmg',
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
        officialSha256: null,
        recordedSha256: sha256,
        identity: {
          installerBundleIdentifier: 'com.nousresearch.hermes.setup',
          installedBundleIdentifier: null,
          signingSubject: pinnedSigningSubject,
          architecture: 'arm64'
        },
        approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
      }
    ]
  })

  class ArtifactStore extends MemoryStore {
    constructor(private readonly served: Buffer) {
      super()
    }
    override async artifactStatus(): Promise<{ size: number; mtimeMs: number } | undefined> {
      return { size: this.served.byteLength, mtimeMs: 1_000 }
    }
    override async hashArtifact(): Promise<ArtifactDigest | undefined> {
      return { byteLength: this.served.byteLength, sha256: createHash('sha256').update(this.served).digest('hex'), mtimeMs: 1_000 }
    }
  }

  const inspectorFor = (signingSubject: string): DownloadArtifactInspector => ({
    inspect: async () => ({
      kind: 'installer' as const,
      identity: { installerBundleIdentifier: 'com.nousresearch.hermes.setup', signingSubject, architecture: 'arm64' }
    })
  })

  function createPinnedManager(inspector: DownloadArtifactInspector, store: ArtifactStore) {
    const engine = new FakeEngine()
    const manager = new DownloadManager({
      catalog: pinnedCatalog,
      engine,
      store,
      inspector,
      tunnel: () => connectedTunnel,
      taskId: () => `pinned-${managers.length + 1}`,
      autoResumeLimit: 0
    })
    managers.push(manager)
    return { manager, engine, store }
  }

  async function settle(manager: DownloadManager, engine: FakeEngine, resourceId: string): Promise<StoredDownloadTask> {
    const started = await manager.start(resourceId)
    engine.transfers[0].finish('completed')
    return manager.waitForSettled(started.taskId)
  }

  it('签名一致且快照一致 ⇒ 一致 ⇒ 放行(读数与 f08133d 一致)', async () => {
    const { manager, engine, store } = createPinnedManager(inspectorFor(pinnedSigningSubject), new ArtifactStore(artifact))
    const settled = await settle(manager, engine, 'pinned-dmg')
    expect(settled).toMatchObject({ state: 'ready', reason: '', message: '来源与文件核验通过，可以打开安装包', localSha256: sha256 })
    expect(store.events).toContainEqual(expect.objectContaining({ result: 'ready' }))
  })

  it('签名一致但 sha / 字节数变了 ⇒「官方包已更新,我们的记录过期了」⛔「校验不符」,且留下我们要收到的信号', async () => {
    const { manager, engine, store } = createPinnedManager(inspectorFor(pinnedSigningSubject), new ArtifactStore(updatedArtifact))
    const settled = await settle(manager, engine, 'pinned-dmg')
    // 字节数变了(f08133d 会死在字节数闸);新判决必须穿过它落到 sha + 身份合并的那一判。
    expect(updatedArtifact.byteLength).not.toBe(artifact.byteLength)
    expect(settled).toMatchObject({
      state: 'failed',
      reason: 'official-build-updated',
      message: '官方安装包已更新，当前记录需要更新。请复制问题信息给来信客服，确认后再试。'
    })
    expect(settled.message).not.toContain('校验不符')
    // 信号:事件账里这一条 result 告诉我们目录条目该更新了。
    expect(store.events).toContainEqual(expect.objectContaining({ result: 'failed-official-build-updated' }))
  })

  it('签名主体对不上 ⇒ 身份不符,拦,报安全性措辞', async () => {
    const { manager, engine, store } = createPinnedManager(inspectorFor('Developer ID Application: Stranger (OTHER00000)'), new ArtifactStore(artifact))
    const settled = await settle(manager, engine, 'pinned-dmg')
    expect(settled).toMatchObject({ state: 'failed', reason: 'identity-mismatch', message: '身份不符' })
    expect(store.events).not.toContainEqual(expect.objectContaining({ result: 'failed-official-build-updated' }))
  })

  it('没钉签名的条目没有信任根,快照对不上时保持原判「校验不符」', async () => {
    const engine = new FakeEngine()
    const manager = new DownloadManager({
      catalog,
      engine,
      store: new ArtifactStore(updatedArtifact),
      inspector,
      tunnel: () => connectedTunnel,
      taskId: () => `drift-${managers.length + 1}`,
      autoResumeLimit: 0
    })
    managers.push(manager)
    const settled = await settle(manager, engine, 'fixture-dmg')
    expect(settled).toMatchObject({ state: 'failed', reason: 'integrity-mismatch', message: '校验不符' })
  })

  it('经产品真实入口(download.start/status 桥)取到「官方包已更新」那句,⛔ 只断言内部读数', async () => {
    const { manager, engine } = createPinnedManager(inspectorFor(pinnedSigningSubject), new ArtifactStore(updatedArtifact))
    const registry = new BridgeRegistry()
    registerDownloadActions(registry, manager)

    const started = (await registry.execute('download.start', { resourceId: 'pinned-dmg' })) as { taskId: string; state: string }
    expect(started.state).toBe('downloading')
    engine.transfers[0].finish('completed')
    await manager.waitForSettled(started.taskId)

    const status = (await registry.execute('download.status', { taskId: started.taskId })) as {
      state: string
      reason: string
      message: string
    }
    expect(status).toMatchObject({
      state: 'failed',
      reason: 'official-build-updated',
      message: '官方安装包已更新，当前记录需要更新。请复制问题信息给来信客服，确认后再试。'
    })
  })
})
