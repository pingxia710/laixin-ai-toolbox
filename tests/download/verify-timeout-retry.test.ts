// 校验超时是「判不出来」，不是「判坏了」：原先它走 not-installer 那条路，客户看到「不是安装包」，
// 已下载好的文件被删掉，重试等于把几百 MB 重下一遍。超时要有自己的结论、保留文件、重试只重新校验。
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
import { parseCatalog } from '../../app/main/download/catalog'
import { DOWNLOAD_VERIFY_TIMEOUT } from '../../app/main/download/types'
import type { ArtifactDigest, DownloadArtifactInspector, DownloadTaskStore, StoredDownloadTask } from '../../app/main/download/types'

const artifact = Buffer.from('fixture-dmg-bytes')
const sha256 = createHash('sha256').update(artifact).digest('hex')
const catalog = parseCatalog({ catalogVersion: 'test', resources: [{ id: 'fixture-dmg', software: 'Hermes', platform: 'macos', architecture: 'arm64', type: 'download',
  officialPageUrl: 'https://official.test/desktop', assetUrl: 'http://127.0.0.1:8080/Hermes.dmg', allowedHosts: ['127.0.0.1'], version: 'fixture', officialVersionLabel: 'fixture',
  format: 'dmg', expectedBytes: String(artifact.byteLength), officialSha256: sha256, recordedSha256: sha256, identity: null,
  approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' } }] })

// 安装包按任务记:清理只该清掉被放弃的那个任务的包,⛔ 连别的任务的一起清。
class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()
  readonly artifacts = new Set<string>()
  deleteArtifactCalls = 0
  async save(task: StoredDownloadTask) { this.tasks.set(task.taskId, structuredClone(task)) }
  async get(taskId: string) { const t = this.tasks.get(taskId); return t && structuredClone(t) }
  async list() { return [...this.tasks.values()].map((t) => structuredClone(t)) }
  async appendEvent() {}
  async promotePart(task: StoredDownloadTask) { this.artifacts.add(task.taskId) }
  async deletePart() {}
  async deleteArtifact(task: StoredDownloadTask) { this.deleteArtifactCalls += 1; this.artifacts.delete(task.taskId) }
  async artifactStatus(task: StoredDownloadTask) {
    return this.artifacts.has(task.taskId) ? { size: artifact.byteLength, mtimeMs: 1000 } : undefined
  }
  async hashArtifact(task: StoredDownloadTask): Promise<ArtifactDigest | undefined> {
    return this.artifacts.has(task.taskId) ? { byteLength: artifact.byteLength, sha256, mtimeMs: 1000 } : undefined
  }
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

class Engine implements DownloadEngine {
  transfers: Transfer[] = []
  starts = 0
  async start() { this.starts += 1; const t = new Transfer(); this.transfers.push(t); return t }
}

const managers: DownloadManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.dispose())) })

function timeoutError(): Error {
  return Object.assign(new Error(DOWNLOAD_VERIFY_TIMEOUT), { code: DOWNLOAD_VERIFY_TIMEOUT })
}

async function reachFailure(inspector: DownloadArtifactInspector, tunnel = { state: 'connected' as 'connected' | 'stopped' }) {
  const engine = new Engine()
  const store = new MemoryStore()
  const manager = new DownloadManager({
    catalog, engine, store, inspector, autoResumeLimit: 0,
    tunnel: () => (tunnel.state === 'connected'
      ? { state: 'connected', localProxyUrl: 'http://127.0.0.1:19080' }
      : { state: 'stopped', localProxyUrl: undefined })
  })
  managers.push(manager)
  const task = await manager.start('fixture-dmg')
  engine.transfers[0].finish('completed')
  const settled = await manager.waitForSettled(task.taskId)
  return { manager, engine, store, task, settled }
}

describe('校验超时与「不是安装包」分开', () => {
  it('超时：自己的结论 + 文件保留 + 重试只重新校验不重下', async () => {
    let attempt = 0
    const inspector: DownloadArtifactInspector = {
      inspect: async () => {
        attempt += 1
        if (attempt === 1) throw timeoutError()
        return { kind: 'installer' as const, identity: null }
      }
    }
    const { manager, engine, store, task, settled } = await reachFailure(inspector)

    expect(settled.state).toBe('failed')
    expect(settled.reason).toBe('verify-timeout')
    expect(settled.message).toContain('超时')
    expect(settled.message).not.toContain('不是安装包')
    // 已下载好的文件必须留着,⛔ 让客户为一次判不出来重下几百 MB。
    expect(store.deleteArtifactCalls).toBe(0)
    expect(store.artifacts.has(task.taskId)).toBe(true)

    const startsBefore = engine.starts
    const retried = await manager.retry(task.taskId)
    expect(retried.taskId).toBe(task.taskId)
    expect(engine.starts).toBe(startsBefore)
    expect((await manager.waitForSettled(task.taskId)).state).toBe('ready')
    expect(attempt).toBe(2)
  })

  it('明确判定「不是安装包」：仍旧删文件、重试走重下', async () => {
    const inspector: DownloadArtifactInspector = {
      inspect: async () => ({ kind: 'not-installer' as const, identity: null })
    }
    const { manager, engine, store, task, settled } = await reachFailure(inspector)

    expect(settled.state).toBe('failed')
    expect(settled.reason).toBe('not-installer')
    expect(store.deleteArtifactCalls).toBeGreaterThan(0)

    const startsBefore = engine.starts
    const retried = await manager.retry(task.taskId)
    expect(retried.taskId).not.toBe(task.taskId)
    expect(engine.starts).toBe(startsBefore + 1)
  })

  it('超时保留后客户改点重新下载：旧任务那份包被清掉，⛔ 几百 MB 无人认领', async () => {
    const inspector: DownloadArtifactInspector = { inspect: async () => { throw timeoutError() } }
    const { manager, engine, store, task, settled } = await reachFailure(inspector)
    expect(settled.reason).toBe('verify-timeout')
    expect(store.artifacts.has(task.taskId)).toBe(true)

    // 客户不重试校验,而是对同一资源重新下载 ⇒ 新任务有自己的目录,旧目录那份再没人会碰。
    const fresh = await manager.start('fixture-dmg')
    expect(fresh.taskId).not.toBe(task.taskId)
    expect(engine.starts).toBe(2)
    expect(store.artifacts.has(task.taskId)).toBe(false)
    // 旧任务的文案不能继续说「已下载的文件保留…不用重新下载」——那份已经不在了。
    const stale = await manager.status(task.taskId)
    expect(stale.message).not.toContain('不用重新下载')
  })

  it('⛔ 顺手清掉 ready 任务的包：那是客户还要拿来装的', async () => {
    const inspector: DownloadArtifactInspector = { inspect: async () => ({ kind: 'installer' as const, identity: null }) }
    const { manager, engine, store, task, settled } = await reachFailure(inspector)
    expect(settled.state).toBe('ready')
    expect(store.artifacts.has(task.taskId)).toBe(true)

    await manager.start('fixture-dmg')
    expect(engine.starts).toBe(2)
    expect(store.artifacts.has(task.taskId)).toBe(true)
    expect(store.deleteArtifactCalls).toBe(0)
  })

  it('按了重新下载但通道连不上：这次根本没开始下，保留的包先别动', async () => {
    const inspector: DownloadArtifactInspector = { inspect: async () => { throw timeoutError() } }
    const tunnel = { state: 'connected' as 'connected' | 'stopped' }
    const { manager, store, task } = await reachFailure(inspector, tunnel)
    expect(store.artifacts.has(task.taskId)).toBe(true)

    tunnel.state = 'stopped'
    expect((await manager.start('fixture-dmg')).state).toBe('needs-tunnel')
    // 一个字节都没下到就把上一份毁掉,等于白白让客户重来;他还可能回去重试校验。
    expect(store.artifacts.has(task.taskId)).toBe(true)
    expect(store.deleteArtifactCalls).toBe(0)
  })

  it('超时后文件真的不在了：重试退回重下，⛔ 对着空气反复校验', async () => {
    const inspector: DownloadArtifactInspector = { inspect: async () => { throw timeoutError() } }
    const { manager, engine, store, task } = await reachFailure(inspector)
    store.artifacts.delete(task.taskId)

    const startsBefore = engine.starts
    const retried = await manager.retry(task.taskId)
    expect(retried.taskId).not.toBe(task.taskId)
    expect(engine.starts).toBe(startsBefore + 1)
  })
})
