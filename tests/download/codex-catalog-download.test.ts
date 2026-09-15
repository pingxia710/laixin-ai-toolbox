import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { registerDownloadActions } from '../../app/main/actions/download'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { loadCatalog } from '../../app/main/download/catalog'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
import type { ArtifactDigest, DownloadArtifactInspector, DownloadCatalog, DownloadResource, DownloadTaskStore, StoredDownloadTask, TunnelSnapshot } from '../../app/main/download/types'

// 判据纪律:结论落在输出面,判据必须来自输出面。目录读数经真实 loadCatalog()(⛔ 直接 import JSON 断言);
// 核验读数经 download.start / download.status 桥(⛔ 只断言内部读数)。
const codexResource = loadCatalog().resources.find((resource) => resource.id === 'codex-macos-arm64')
expect(codexResource).toBeDefined()

// 事实核-Codex桌面版官方包-mac-20260907 的实测值,条目必须逐字钉死这些读数。
const measured = {
  assetUrl: 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg',
  expectedBytes: '643007873',
  recordedSha256: 'b6ffed73d581047862e85de5b4d322ba431004949a5338736e7059182dff6082',
  version: '26.901.51231',
  installerBundleIdentifier: 'com.openai.codex',
  installedBundleIdentifier: 'com.openai.codex',
  signingSubject: 'Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)'
}

const fixtureArtifact = Buffer.from('fixture-codex-dmg-bytes')
const fixtureSha256 = createHash('sha256').update(fixtureArtifact).digest('hex')
const updatedArtifact = Buffer.from('fixture-codex-dmg-bytes-official-v2')

const connectedTunnel: TunnelSnapshot = { state: 'connected', localProxyUrl: 'http://127.0.0.1:19080' }

class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()
  readonly events: Array<Record<string, string>> = []

  constructor(private readonly served: Buffer) {}

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

  async artifactStatus(): Promise<{ size: number; mtimeMs: number } | undefined> {
    return { size: this.served.byteLength, mtimeMs: 1_000 }
  }
  async hashArtifact(): Promise<ArtifactDigest | undefined> {
    return { byteLength: this.served.byteLength, sha256: createHash('sha256').update(this.served).digest('hex'), mtimeMs: 1_000 }
  }
}

class ControlledTransfer implements DownloadTransfer {
  private readonly completionWaiters: Array<(value: DownloadCompletion) => void> = []

  onProgress(): void {
    void 0
  }

  waitForCompletion(): Promise<DownloadCompletion> {
    return new Promise((resolve) => this.completionWaiters.push(resolve))
  }

  cancel(): void {
    this.finish('cancelled')
  }

  resume(): void {
    void 0
  }

  finish(state: 'completed' | 'cancelled' | 'interrupted', canResume = false, mimeType = 'application/octet-stream'): void {
    const resolve = this.completionWaiters.shift()
    resolve?.({
      state,
      receivedBytes: state === 'completed' ? fixtureArtifact.byteLength : Math.floor(fixtureArtifact.byteLength / 2),
      totalBytes: fixtureArtifact.byteLength,
      canResume,
      etag: 'fixture-etag',
      lastModified: 'fixture-last-modified',
      mimeType,
      urlChain: [measured.assetUrl]
    })
  }
}

class FakeEngine implements DownloadEngine {
  readonly transfers: ControlledTransfer[] = []
  readonly requests: Parameters<DownloadEngine['start']>[0][] = []

  async start(request: Parameters<DownloadEngine['start']>[0]): Promise<DownloadTransfer> {
    this.requests.push(request)
    const transfer = new ControlledTransfer()
    this.transfers.push(transfer)
    return transfer
  }
}

const inspectors = {
  // 实测身份:bundle、签名主体、架构全部与目录条目一致。
  measured: {
    inspect: async () => ({
      kind: 'installer' as const,
      identity: {
        installerBundleIdentifier: measured.installerBundleIdentifier,
        signingSubject: measured.signingSubject,
        architecture: 'arm64'
      }
    })
  },
  // 反向输入:同一 bundle 但签名主体换成了别家(Team ID 对不上 ⇒ 安全事件,必须拦)。
  stranger: {
    inspect: async () => ({
      kind: 'installer' as const,
      identity: {
        installerBundleIdentifier: measured.installerBundleIdentifier,
        signingSubject: 'Developer ID Application: Stranger (OTHER00000)',
        architecture: 'arm64'
      }
    })
  }
} satisfies Record<string, DownloadArtifactInspector>

const managers: DownloadManager[] = []

function createCodexManager(inspector: DownloadArtifactInspector, served: Buffer, resource: DownloadResource, tunnel: TunnelSnapshot = connectedTunnel): { manager: DownloadManager; engine: FakeEngine; store: MemoryStore } {
  const catalog: DownloadCatalog = { catalogVersion: 'codex-fixture', resources: [resource] }
  const engine = new FakeEngine()
  const store = new MemoryStore(served)
  const manager = new DownloadManager({
    catalog,
    engine,
    store,
    inspector,
    tunnel: () => tunnel,
    taskId: (() => {
      let sequence = 0
      return () => `codex-task-${++sequence}`
    })(),
    autoResumeLimit: 0
  })
  managers.push(manager)
  return { manager, engine, store }
}

async function settleViaBridge(
  manager: DownloadManager,
  engine: FakeEngine
): Promise<Record<string, string>> {
  const registry = new BridgeRegistry()
  registerDownloadActions(registry, manager)
  const started = (await registry.execute('download.start', { resourceId: 'codex-macos-arm64' })) as { taskId: string; state: string }
  expect(started.state).toBe('downloading')
  engine.transfers[0].finish('completed')
  await manager.waitForSettled(started.taskId)
  return (await registry.execute('download.status', { taskId: started.taskId })) as Record<string, string>
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
})

describe('Codex 目录条目(经真实 loadCatalog 解析)', () => {
  it('实测值逐字入库:直链、字节数、sha256、双身份、签名主体、钉住的版本', () => {
    expect(codexResource).toMatchObject({
      id: 'codex-macos-arm64',
      software: 'Codex',
      platform: 'macos',
      architecture: 'arm64',
      type: 'download',
      format: 'dmg',
      officialPageUrl: 'https://learn.chatgpt.com/docs/app',
      allowedHosts: ['persistent.oaistatic.com'],
      assetUrl: measured.assetUrl,
      expectedBytes: measured.expectedBytes,
      recordedSha256: measured.recordedSha256,
      version: measured.version
    })
    expect(codexResource?.identity).toMatchObject({
      installerBundleIdentifier: measured.installerBundleIdentifier,
      installedBundleIdentifier: measured.installedBundleIdentifier,
      signingSubject: measured.signingSubject,
      architecture: 'arm64'
    })
  })

  it('官方未发布摘要如实记 null,批准语义按款分钉版本(与 Hermes 的 stub 语义不同)', () => {
    expect(codexResource?.officialSha256).toBeNull()
    expect(codexResource?.approval.scope).toContain('26.901.51231')
    expect(codexResource?.approval.scope).toContain('版本钉得住')
    expect(codexResource?.approval.scope).toContain('功能核准已完成')
  })
})

describe('Codex 下载核验三态(签名是信任根,快照只判「变没变」;读数经产品桥)', () => {
  it('签名一致且快照一致 ⇒ ready 放行,官方摘要如实报「未与官方值核对」', async () => {
    // 放行路径需要一个 sha 与 recordedSha256 一致的工件;测试没有 643 MB 真包,
    // 把条目快照换成 fixture 摘要(身份钉死值保持真实条目原样,⛔ 动)。
    const resource = { ...codexResource!, recordedSha256: fixtureSha256 } as DownloadResource
    const { manager, engine } = createCodexManager(inspectors.measured, fixtureArtifact, resource)
    const status = await settleViaBridge(manager, engine)
    expect(status).toMatchObject({ state: 'ready', reason: '', message: '来源与文件核验通过，可以打开安装包', localSha256: fixtureSha256 })
  })

  it('版本钉死可红:签名一致但包换了(sha/字节变了)⇒「官方包已更新」,⛔「校验不符」,且事件账留下信号', async () => {
    const { manager, engine, store } = createCodexManager(inspectors.measured, updatedArtifact, codexResource!)
    const status = await settleViaBridge(manager, engine)
    expect(status).toMatchObject({
      state: 'failed',
      reason: 'official-build-updated',
      message: '官方安装包已更新，当前记录需要更新。请复制问题信息给来信客服，确认后再试。'
    })
    expect(status.message).not.toContain('校验不符')
    expect(store.events).toContainEqual(expect.objectContaining({ result: 'failed-official-build-updated' }))
  })

  it('直连中断后换通道备用源:通道已连接则以固定代理续跑同一任务', async () => {
    const { manager, engine } = createCodexManager(inspectors.measured, fixtureArtifact, codexResource!)
    const started = await manager.start('codex-macos-arm64')
    // 真实目录直连优先;直连不可恢复中断 ⇒ 自动切通道源。
    engine.transfers[0].finish('interrupted')
    await expect.poll(() => engine.transfers.length).toBe(2)
    expect(engine.requests[1]).toMatchObject({ network: 'tunnel', proxyUrl: connectedTunnel.localProxyUrl, sourceId: 'official-tunnel' })
    engine.transfers[1].finish('completed', false, 'text/html') // 备用源返回网页 ⇒ 仍按原包校验拒绝
    expect(await manager.waitForSettled(started.taskId)).toMatchObject({ state: 'failed', reason: 'not-installer' })
  })

  it('通道未接时不偷跑通道源:直连失败后如实报 needs-tunnel', async () => {
    const stopped: TunnelSnapshot = { state: 'stopped', localProxyUrl: undefined }
    const { manager, engine } = createCodexManager(inspectors.measured, fixtureArtifact, codexResource!, stopped)
    const started = await manager.start('codex-macos-arm64')
    engine.transfers[0].finish('interrupted')
    const settled = await manager.waitForSettled(started.taskId)
    expect(settled).toMatchObject({ state: 'needs-tunnel', reason: 'tunnel-not-connected' })
    expect(engine.requests.every((request) => request.network === 'direct')).toBe(true)
  })

  it('签名主体对不上 ⇒ 身份不符,拦,报安全性措辞', async () => {
    const { manager, engine, store } = createCodexManager(inspectors.stranger, fixtureArtifact, codexResource!)
    const status = await settleViaBridge(manager, engine)
    expect(status).toMatchObject({ state: 'failed', reason: 'identity-mismatch', message: '身份不符' })
    expect(store.events).not.toContainEqual(expect.objectContaining({ result: 'failed-official-build-updated' }))
  })
})
