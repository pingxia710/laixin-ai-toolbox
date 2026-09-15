// 校验期必须能退出:hdiutil 遇许可协议 DMG 会在 stdin 上等，run() 无超时就永挂；
// 而 verifying 下 cancel/retry 都被拒、start 只回同一个任务 ⇒ 客户只能退出工具箱重开。
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
import { parseCatalog } from '../../app/main/download/catalog'
import type { ArtifactDigest, DownloadArtifactInspector, DownloadTaskStore, StoredDownloadTask } from '../../app/main/download/types'

const artifact = Buffer.from('fixture-dmg-bytes')
const sha256 = createHash('sha256').update(artifact).digest('hex')
const catalog = parseCatalog({ catalogVersion: 'test', resources: [{ id: 'fixture-dmg', software: 'Hermes', platform: 'macos', architecture: 'arm64', type: 'download',
  officialPageUrl: 'https://official.test/desktop', assetUrl: 'http://127.0.0.1:8080/Hermes.dmg', allowedHosts: ['127.0.0.1'], version: 'fixture', officialVersionLabel: 'fixture',
  format: 'dmg', expectedBytes: String(artifact.byteLength), officialSha256: sha256, recordedSha256: sha256, identity: null,
  approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' } }] })

class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()
  deletedArtifacts = 0
  async save(task: StoredDownloadTask) { this.tasks.set(task.taskId, structuredClone(task)) }
  async get(taskId: string) { const t = this.tasks.get(taskId); return t && structuredClone(t) }
  async list() { return [...this.tasks.values()].map((t) => structuredClone(t)) }
  async appendEvent() {}
  async promotePart() {}
  async deletePart() {}
  async deleteArtifact() { this.deletedArtifacts += 1 }
  async artifactStatus() { return { size: artifact.byteLength, mtimeMs: 1000 } }
  async hashArtifact(): Promise<ArtifactDigest> { return { byteLength: artifact.byteLength, sha256, mtimeMs: 1000 } }
}

class Transfer implements DownloadTransfer {
  private waiters: Array<(v: DownloadCompletion) => void> = []
  onProgress() {}
  waitForCompletion() { return new Promise<DownloadCompletion>((r) => this.waiters.push(r)) }
  cancel() { this.finish('cancelled') }
  resume() {}
  finish(state: 'completed' | 'cancelled') {
    this.waiters.shift()?.({ state, receivedBytes: artifact.byteLength, totalBytes: artifact.byteLength, canResume: false, etag: 'e', lastModified: 'l', mimeType: 'application/octet-stream', urlChain: ['http://127.0.0.1:8080/Hermes.dmg'] })
  }
}

class Engine implements DownloadEngine { transfers: Transfer[] = []; async start() { const t = new Transfer(); this.transfers.push(t); return t } }

const managers: DownloadManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.dispose())) })

function managerWith(inspector: DownloadArtifactInspector, store = new MemoryStore()) {
  const engine = new Engine()
  const manager = new DownloadManager({ catalog, engine, store, inspector, tunnel: () => ({ state: 'connected', localProxyUrl: 'http://127.0.0.1:19080' }), autoResumeLimit: 0 })
  managers.push(manager)
  return { manager, engine, store }
}

async function reachVerifying(inspector: DownloadArtifactInspector, store?: MemoryStore) {
  const built = managerWith(inspector, store)
  const task = await built.manager.start('fixture-dmg')
  built.engine.transfers[0].finish('completed')
  await new Promise((r) => setTimeout(r, 50))
  expect(await built.manager.status(task.taskId)).toMatchObject({ state: 'verifying' })
  return { ...built, task }
}

describe('校验期可取消', () => {
  it('inspector 挂住时取消立即生效：中止校验子进程、任务落取消态', async () => {
    let aborted = false
    const hanging: DownloadArtifactInspector = {
      inspect: (input) => new Promise((_resolve, reject) => {
        // 生产实现把这个信号传给 execFile,取消即杀 hdiutil/codesign 子进程。
        input.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('DOWNLOAD_INSPECT_ABORTED')) })
      })
    }
    const { manager, task } = await reachVerifying(hanging)

    await expect(manager.cancel(task.taskId)).resolves.toMatchObject({ state: 'cancelled' })
    expect(aborted).toBe(true)
    // 取消后在途校验不得把状态改回去(⛔ 覆盖成 ready / 不是安装包)。
    await new Promise((r) => setTimeout(r, 50))
    expect((await manager.status(task.taskId)).state).toBe('cancelled')
  })

  it('取消后可重新开始下载，⛔ 卡在同一个任务里出不去', async () => {
    const hanging: DownloadArtifactInspector = {
      inspect: (input) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('DOWNLOAD_INSPECT_ABORTED')))
      })
    }
    const { manager, task } = await reachVerifying(hanging)
    await manager.cancel(task.taskId)
    const restarted = await manager.start('fixture-dmg')
    expect(restarted.taskId).not.toBe(task.taskId)
    expect(restarted.state).not.toBe('cancelled')
  })

  it('校验慢但没取消时照常出结果，⛔ 误伤正常路径', async () => {
    const slow: DownloadArtifactInspector = {
      inspect: async () => { await new Promise((r) => setTimeout(r, 30)); return { kind: 'installer' as const, identity: null } }
    }
    const { manager, engine } = managerWith(slow)
    const task = await manager.start('fixture-dmg')
    engine.transfers[0].finish('completed')
    await expect(manager.waitForSettled(task.taskId)).resolves.toMatchObject({ state: 'ready' })
  })
})
