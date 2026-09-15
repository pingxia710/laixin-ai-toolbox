import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileTaskStore, taskPaths } from '../../app/main/download/task-store'
import type { DownloadResource, StoredDownloadTask } from '../../app/main/download/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('下载任务落盘', () => {
  it('记录目录暂时不可读不能冒充没有下载；修复后可原地重读', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-toolbox-download-')); roots.push(root)
    const store = createFileTaskStore(root)
    await writeFile(join(root, 'download-records'), 'temporary wrong entry type')
    await expect(store.list()).rejects.toThrow('DOWNLOAD_STORAGE_UNAVAILABLE')
    await rm(join(root, 'download-records'))
    await expect(store.list()).resolves.toEqual([])
  })

  it('只在工具箱任务根目录写记录、分段文件和独立下载账', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-toolbox-download-'))
    roots.push(root)
    const resource: DownloadResource = {
      id: 'hermes-macos-arm64',
      software: 'Hermes',
      platform: 'macos',
      architecture: 'arm64',
      type: 'download',
      officialPageUrl: 'https://official.test/desktop',
      assetUrl: 'https://assets.test/Hermes.dmg',
      allowedHosts: ['assets.test'],
      version: 'fixture',
      officialVersionLabel: 'fixture',
      format: 'dmg',
      expectedBytes: '3',
      officialSha256: null,
      recordedSha256: 'a'.repeat(64),
      identity: null,
      approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
    }
    const paths = taskPaths(root, 'task-1', resource)
    const task: StoredDownloadTask = {
      taskId: 'task-1',
      resourceId: resource.id,
      authorizationId: '待接片2',
      state: 'downloading',
      reason: '',
      message: '下载中',
      receivedBytes: '0',
      totalBytes: '3',
      retryCount: '0',
      resumeEtag: '',
      resumeLastModified: '',
      localSha256: '',
      artifactPath: paths.artifactPath,
      partPath: paths.partPath,
      startedAt: '2026-09-07T00:00:00.000Z',
      endedAt: ''
    }
    const store = createFileTaskStore(root)
    await store.save(task)
    await writeFile(paths.partPath, 'dmg')
    await store.promotePart(task)
    await store.appendEvent({ bytes: '3', result: 'ready' })

    expect(relative(root, paths.artifactPath).startsWith('..')).toBe(false)
    await expect(store.get(task.taskId)).resolves.toEqual(task)
    await expect(store.hashArtifact(task)).resolves.toMatchObject({ byteLength: 3, sha256: createHash('sha256').update('dmg').digest('hex') })
    await expect(store.artifactStatus(task)).resolves.toMatchObject({ size: 3 })
    await expect(store.list()).resolves.toEqual([task])
    await expect(readFile(join(root, 'download-events.jsonl'), 'utf8')).resolves.toContain('"bytes":"3"')
    expect(dirname(paths.artifactPath)).toContain(join('downloads', 'Hermes', 'fixture'))
  })
})
