import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../../app/main/download/catalog'
import { DownloadManager } from '../../app/main/download/download-manager'
import { createFileTaskStore, taskPaths } from '../../app/main/download/task-store'
import { WinArtifactInspector, WinInstallerHandoff } from '../../app/main/download/win-artifact'
import type { DownloadResource } from '../../app/main/download/types'

function resource(): DownloadResource {
  const item = loadCatalog().resources.find((entry) => entry.id === 'codex-windows-x86-64')
  if (!item) throw new Error('CODEX_WINDOWS_RESOURCE_MISSING')
  return item
}

describe('Windows Codex 完整 MSIX 下载与打开', () => {
  it('生产目录指向已实测的官方 x64 完整包，下载不强制订阅网络', () => {
    expect(resource()).toMatchObject({
      assetUrl: 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix',
      platform: 'windows', architecture: 'x86_64', format: 'msix',
      version: '26.901.6511.0', expectedBytes: '796592344',
      recordedSha256: 'fd9ae9eeeeaf11577191ce5a39d0b8f95fa73d591aa3a94f688b84d294d1fa85'
    })
    expect(resource().sources?.[0].network).toBe('direct')
  })

  it('真实文件导入、校验、交接；打开失败保留文件，篡改后复查拒绝打开', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-win-download-'))
    const source = join(root, 'source.msix')
    const bytes = Buffer.from('PK\x03\x04local-msix-fixture')
    await writeFile(source, bytes)
    const item = { ...resource(), recordedSha256: createHash('sha256').update(bytes).digest('hex'), expectedBytes: String(bytes.length) }
    const open = vi.fn(async () => 'App Installer unavailable')
    const store = createFileTaskStore(join(root, 'tasks'))
    const fallback = loadCatalog().resources.find((entry) => entry.id === 'codex-windows-official-installer')!
    const manager = new DownloadManager({ catalog: { catalogVersion: 'test', resources: [item, fallback] },
      engine: { start: async () => { throw new Error('UNEXPECTED_NETWORK') } }, store,
      inspector: new WinArtifactInspector(), tunnel: () => ({ state: 'stopped', localProxyUrl: undefined }),
      taskPaths: (id, entry) => taskPaths(join(root, 'tasks'), id, entry),
      hasExistingInstallation: () => false, copyLocalArtifact: copyFile,
      installerHandoff: new WinInstallerHandoff(() => undefined, open).handoff
    })
    const imported = await manager.importLocal(item.id, source)
    expect(imported.state).toBe('ready')
    expect(open).not.toHaveBeenCalled()
    const failedOpen = await manager.openInstaller(imported.taskId)
    expect(failedOpen).toMatchObject({ state: 'ready', reason: 'installer-open-failed' })
    expect(await readFile(source)).toEqual(bytes)
    open.mockResolvedValue('')
    const handed = await manager.openInstaller(imported.taskId)
    expect(handed.state).toBe('handed-off-install')
    expect(handed.message).toContain('安装结果')
    expect(handed.message).not.toContain('Hermes')
    await writeFile(handed.artifactPath, Buffer.from('PK\x03\x04changed-file'))
    const changed = await manager.openInstaller(handed.taskId)
    expect(changed.state).toBe('failed')
    expect(open).toHaveBeenCalledTimes(2)
    await expect(manager.openExternal('codex-windows-official-installer')).rejects.toThrow('DOWNLOAD_HANDOFF_UNAVAILABLE')
    await manager.dispose()
  })

  it.skipIf(!process.env.TOOLBOX_CODEX_WINDOWS_ARTIFACT)('实下载官方 MSIX 经生产目录和下载管理器核验后才能交接', async () => {
    const source = process.env.TOOLBOX_CODEX_WINDOWS_ARTIFACT!
    const root = await mkdtemp(join(tmpdir(), 'codex-win-official-'))
    const item = resource()
    const open = vi.fn(async () => '')
    const manager = new DownloadManager({ catalog: loadCatalog(),
      engine: { start: async () => { throw new Error('UNEXPECTED_NETWORK') } },
      store: createFileTaskStore(root), inspector: new WinArtifactInspector(),
      tunnel: () => ({ state: 'stopped', localProxyUrl: undefined }),
      taskPaths: (id, entry) => taskPaths(root, id, entry),
      hasExistingInstallation: () => false, copyLocalArtifact: copyFile,
      installerHandoff: new WinInstallerHandoff(() => undefined, open).handoff
    })
    try {
      expect((await stat(source)).size).toBe(Number(item.expectedBytes))
      const imported = await manager.importLocal(item.id, source)
      expect(imported).toMatchObject({ state: 'ready', localSha256: item.recordedSha256 })
      expect(open).not.toHaveBeenCalled()
      const handed = await manager.openInstaller(imported.taskId)
      expect(handed.state).toBe('handed-off-install')
      expect(open).toHaveBeenCalledExactlyOnceWith(handed.artifactPath)
      expect(handed.artifactPath).not.toBe(source)
    } finally { await manager.dispose() }
  }, 60_000)
})
