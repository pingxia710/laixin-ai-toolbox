import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DownloadManager } from '../../app/main/download/download-manager'
import { createFileTaskStore, taskPaths } from '../../app/main/download/task-store'
import type { DownloadResource } from '../../app/main/download/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-local-import-'))
  roots.push(root)
  const bytes = Buffer.from('approved-test-package')
  const source = join(root, 'customer.dmg')
  await writeFile(source, bytes)
  const resource: DownloadResource = {
    id: 'hermes-macos-arm64', software: 'hermes', platform: 'macos', architecture: 'arm64', type: 'download',
    officialPageUrl: 'https://official.test/', assetUrl: 'https://official.test/app.dmg', allowedHosts: ['official.test'],
    version: '1', officialVersionLabel: '1', format: 'dmg', expectedBytes: String(bytes.length), officialSha256: null,
    recordedSha256: createHash('sha256').update(bytes).digest('hex'),
    identity: { installerBundleIdentifier: 'test.hermes', installedBundleIdentifier: null, signingSubject: 'test-vendor', architecture: 'arm64' },
    approval: { approvedAt: '2026-09-07', approvedBy: 'fixture', sourceBuild: 'fixture', scope: 'fixture' }
  }
  const store = createFileTaskStore(join(root, 'managed'))
  const start = vi.fn().mockRejectedValue(new Error('Network must not be used'))
  const handoff = vi.fn().mockResolvedValue('已打开安装包')
  const inspect = vi.fn().mockResolvedValue({ kind: 'installer', identity: { installerBundleIdentifier: 'test.hermes', signingSubject: 'test-vendor', architecture: 'arm64' } })
  const options = {
    catalog: { catalogVersion: 'fixture', resources: [resource] }, store,
    engine: { start }, inspector: { inspect }, tunnel: () => ({ state: 'stopped' as const, localProxyUrl: undefined }),
    taskPaths: (id: string, item: DownloadResource) => taskPaths(join(root, 'managed'), id, item),
    copyLocalArtifact: async (path: string, destination: string) => { await copyFile(path, destination) },
    installerHandoff: handoff
  }
  return { source, bytes, start, handoff, inspect, options, manager: new DownloadManager(options) }
}

it('本地包不要求通道；复制后按与下载相同的签名和摘要规则核验，重开可发现任务', async () => {
  const x = await setup()
  const result = await x.manager.importLocal('hermes-macos-arm64', x.source)
  expect(result.state).toBe('ready')
  expect(x.start).not.toHaveBeenCalled()
  expect(x.handoff).not.toHaveBeenCalled()
  expect(await readFile(x.source)).toEqual(x.bytes)
  const reopened = new DownloadManager(x.options)
  await reopened.recoverAfterRestart()
  expect((await reopened.latest('hermes-macos-arm64'))?.taskId).toBe(result.taskId)
  expect((await reopened.latest('hermes-macos-arm64'))?.state).toBe('ready')
})

it('本地包身份错误不能启动，也不删除客户原文件', async () => {
  const x = await setup()
  x.inspect.mockResolvedValue({ kind: 'installer', identity: { installerBundleIdentifier: 'wrong.app', signingSubject: 'test-vendor', architecture: 'arm64' } })
  const result = await x.manager.importLocal('hermes-macos-arm64', x.source)
  expect(result.reason).toBe('identity-mismatch')
  await expect(x.manager.openInstaller(result.taskId)).rejects.toThrow('DOWNLOAD_INSTALLER_NOT_READY')
  expect(await readFile(x.source)).toEqual(x.bytes)
  expect(x.handoff).not.toHaveBeenCalled()
})

it('已核验的包在点击打开前被替换，必须重新拒绝', async () => {
  const x = await setup()
  const result = await x.manager.importLocal('hermes-macos-arm64', x.source)
  await writeFile(result.artifactPath, 'replaced-after-verification')
  expect((await x.manager.openInstaller(result.taskId)).state).toBe('failed')
  expect(x.handoff).not.toHaveBeenCalled()
})

it('重复点击打开只交接一次，重开后不能把已丢失的安装包显示为可打开', async () => {
  const x = await setup()
  const ready = await x.manager.importLocal('hermes-macos-arm64', x.source)
  const results = await Promise.all([x.manager.openInstaller(ready.taskId), x.manager.openInstaller(ready.taskId)])
  expect(results.every((task) => task.state === 'handed-off-install')).toBe(true)
  expect(x.handoff).toHaveBeenCalledOnce()
  await rm(ready.artifactPath)
  const reopened = new DownloadManager(x.options)
  await reopened.recoverAfterRestart()
  expect(await reopened.latest('hermes-macos-arm64')).toMatchObject({ state: 'failed', reason: 'artifact-unavailable' })
  await expect(reopened.openInstaller(ready.taskId)).rejects.toThrow('DOWNLOAD_INSTALLER_NOT_READY')
})

it('找回某个软件的任务不会误取其他软件，损坏的单条记录不隐藏正常任务', async () => {
  const x = await setup()
  const result = await x.manager.importLocal('hermes-macos-arm64', x.source)
  const root = roots.at(-1)!
  await writeFile(join(root, 'managed/download-records/broken.json'), '{')
  expect((await x.manager.latest('hermes-macos-arm64'))?.taskId).toBe(result.taskId)
  await expect(x.manager.latest('unknown-software')).rejects.toThrow('DOWNLOAD_RESOURCE_NOT_FOUND')
})
