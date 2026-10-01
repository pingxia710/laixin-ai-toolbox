// 启动恢复的工件保留与孤儿清扫:ready 工件按 software 设保留上限(超出删记录+删目录),
// 无任务引用的孤儿下载目录并入恢复清扫;⛔ 清扫只碰工具箱自己命名规则的目录。
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadManager, type DownloadEngine } from '../../app/main/download/download-manager'
import { createFileTaskStore, taskPaths } from '../../app/main/download/task-store'
import { parseCatalog } from '../../app/main/download/catalog'
import type { DownloadArtifactInspector, DownloadResource, DownloadTaskStore, StoredDownloadTask } from '../../app/main/download/types'

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

// 恢复流程不下载:引擎存在只为满足构造参数,被调用即失败。
class IdleEngine implements DownloadEngine {
  async start(): Promise<never> {
    throw new Error('recovery fixture never downloads')
  }
}

const inspector: DownloadArtifactInspector = { inspect: async () => ({ kind: 'installer', identity: null }) }

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seedReadyTask(root: string, store: DownloadTaskStore, resource: DownloadResource, taskId: string, startedAt: string): Promise<StoredDownloadTask> {
  const paths = taskPaths(root, taskId, resource)
  await mkdir(dirname(paths.artifactPath), { recursive: true })
  await writeFile(paths.artifactPath, artifact)
  const info = await stat(paths.artifactPath)
  const task: StoredDownloadTask = {
    taskId,
    resourceId: resource.id,
    authorizationId: '',
    state: 'ready',
    reason: '',
    message: '',
    receivedBytes: String(artifact.byteLength),
    totalBytes: String(artifact.byteLength),
    retryCount: '0',
    resumeEtag: '',
    resumeLastModified: '',
    localSha256: sha256,
    artifactPath: paths.artifactPath,
    partPath: paths.partPath,
    startedAt,
    endedAt: startedAt,
    artifactSize: String(artifact.byteLength),
    artifactMtimeMs: String(info.mtimeMs)
  }
  await store.save(task)
  return task
}

function recoveryManager(root: string, store: DownloadTaskStore): DownloadManager {
  return new DownloadManager({
    catalog,
    engine: new IdleEngine(),
    store,
    inspector,
    tunnel: () => ({ state: 'stopped', localProxyUrl: undefined }),
    taskPaths: (taskId, resource) => taskPaths(root, taskId, resource)
  })
}

describe('启动恢复:ready 工件保留上限与孤儿清扫', () => {
  it('同一软件仅保留最新两份 ready 工件:最旧的删记录、目录同步删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-retention-')); roots.push(root)
    const store = createFileTaskStore(root)
    const resource = catalog.resources[0]
    const oldest = await seedReadyTask(root, store, resource, 'task-oldest', '2026-09-01T00:00:00.000Z')
    await seedReadyTask(root, store, resource, 'task-mid', '2026-09-02T00:00:00.000Z')
    const newest = await seedReadyTask(root, store, resource, 'task-newest', '2026-09-03T00:00:00.000Z')
    await recoveryManager(root, store).recoverAfterRestart()

    await expect(store.get('task-oldest')).resolves.toBeUndefined()
    await expect(store.get('task-mid')).resolves.toMatchObject({ state: 'ready' })
    await expect(store.get('task-newest')).resolves.toMatchObject({ state: 'ready' })
    await expect(stat(oldest.artifactPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(newest.artifactPath)).resolves.toBeTruthy()
  })

  it('恢复时清扫无任务引用的孤儿目录;工具箱根内外的用户文件一律不碰', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-retention-sweep-')); roots.push(root)
    const store = createFileTaskStore(root)
    const resource = catalog.resources[0]
    const kept = await seedReadyTask(root, store, resource, 'task-kept', '2026-09-01T00:00:00.000Z')
    const orphanDir = join(root, 'downloads', 'Hermes', 'fixture', 'task-orphan')
    await mkdir(orphanDir, { recursive: true })
    await writeFile(join(orphanDir, 'installer.part'), 'leftover')
    await mkdir(join(root, 'downloads', 'notes'), { recursive: true })
    await writeFile(join(root, 'downloads', 'notes', '用户笔记.txt'), 'user content')
    await writeFile(join(root, '用户说明.txt'), 'user content')

    await recoveryManager(root, store).recoverAfterRestart()

    await expect(stat(kept.artifactPath)).resolves.toBeTruthy()
    await expect(stat(orphanDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'downloads', 'notes', '用户笔记.txt'))).resolves.toBeTruthy()
    await expect(stat(join(root, '用户说明.txt'))).resolves.toBeTruthy()
  })
})
