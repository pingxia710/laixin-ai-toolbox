import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { DownloadManager, type DownloadCompletion, type DownloadEngine, type DownloadTransfer } from '../../app/main/download/download-manager'
import { downloadTunnelSnapshot } from '../../app/main/download/tunnel-runtime'
import type { ArtifactDigest, DownloadArtifactInspector, DownloadCatalog, DownloadTaskStore, StoredDownloadTask } from '../../app/main/download/types'
import { initializeTunnelRuntime } from '../../app/main/tunnel/runtime-owner'
import { TunnelService, type TunnelServiceDeps } from '../../app/main/tunnel/tunnel-service'
import { buildPackageEntries, writePackageDir } from '../tunnel/fixtures/package-builder'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const SIDECAR_DIR = join(process.cwd(), 'sidecar', 'mac')

const catalog: DownloadCatalog = {
  catalogVersion: 'download-tunnel-runtime-integration',
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
      expectedBytes: '0',
      officialSha256: null,
      recordedSha256: '',
      identity: null,
      approval: { approvedAt: '2026-09-07T00:00:00+08:00', approvedBy: 'test', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
    }
  ]
}

class MemoryStore implements DownloadTaskStore {
  readonly tasks = new Map<string, StoredDownloadTask>()

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

  async appendEvent(): Promise<void> {}
  async promotePart(): Promise<void> {}
  async deletePart(): Promise<void> {}
  async deleteArtifact(): Promise<void> {}
  async artifactStatus(): Promise<{ size: number; mtimeMs: number } | undefined> {
    return undefined
  }
  async hashArtifact(): Promise<ArtifactDigest | undefined> {
    return undefined
  }
}

class CountingEngine implements DownloadEngine {
  starts = 0

  async start(): Promise<DownloadTransfer> {
    this.starts += 1
    return {
      onProgress: () => undefined,
      waitForCompletion: () => new Promise<DownloadCompletion>(() => undefined),
      cancel: () => undefined,
      resume: () => undefined
    }
  }
}

const inspector: DownloadArtifactInspector = {
  inspect: async () => ({ kind: 'not-installer', identity: null })
}

function createManager(tunnel: () => ReturnType<typeof downloadTunnelSnapshot>) {
  const engine = new CountingEngine()
  const manager = new DownloadManager({
    catalog,
    engine,
    store: new MemoryStore(),
    inspector,
    tunnel,
    taskId: (() => {
      let sequence = 0
      return () => `task-${String(++sequence)}`
    })()
  })
  return { manager, engine }
}

describe('下载读取片 3 通道运行时', () => {
  it('真实通道由未连变已连时，下载快照与引擎调用同步变化；固定 stopped 反向变体会被拒起', async () => {
    const dataDir = makeTempDir('laixin-download-tunnel-data-')
    const packageDir = makeTempDir('laixin-download-tunnel-package-')
    const managers: DownloadManager[] = []
    let service: TunnelService | undefined
    const daemon = new EventEmitter()

    try {
      const built = buildPackageEntries({ configVersion: 1 })
      const packagePath = writePackageDir(join(packageDir, 'valid-package'), built)
      const deps: TunnelServiceDeps = {
        dataDir,
        sidecarDir: SIDECAR_DIR,
        picker: () => Promise.resolve(packagePath),
        trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
        now: () => NOW,
        spawnDaemon: (dir) => {
          writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'connected', exitIp: '203.0.113.7' }))
          return daemon
        },
        spawnRestore: () => undefined,
        routesFile: join(SIDECAR_DIR, 'routes.default.json')
      }
      service = initializeTunnelRuntime(() => new TunnelService(deps))
      const live = createManager(downloadTunnelSnapshot)
      managers.push(live.manager)

      expect(downloadTunnelSnapshot()).toEqual({ state: 'stopped', localProxyUrl: undefined })
      await expect(live.manager.start('fixture-dmg')).resolves.toMatchObject({ state: 'needs-tunnel' })
      expect(live.engine.starts).toBe(0)

      await expect(service.importConfig()).resolves.toMatchObject({ outcome: 'imported' })
      await expect(service.applyPending()).resolves.toMatchObject({ outcome: 'applied' })
      await expect(service.start()).resolves.toMatchObject({ outcome: 'started' })
      expect(service.status().state).toBe('已连')

      expect(downloadTunnelSnapshot()).toEqual({ state: 'connected', localProxyUrl: 'http://127.0.0.1:18080' })
      await expect(live.manager.start('fixture-dmg')).resolves.toMatchObject({ state: 'downloading' })
      expect(live.engine.starts).toBeGreaterThan(0)

      vi.resetModules()
      vi.doMock('../../app/main/tunnel/runtime', () => ({
        readTunnelSnapshot: () => ({ state: 'stopped' as const, localProxyUrl: undefined })
      }))
      const { downloadTunnelSnapshot: fixedStoppedSnapshot } = await import('../../app/main/download/tunnel-runtime')
      const counterfactual = createManager(fixedStoppedSnapshot)
      managers.push(counterfactual.manager)
      await expect(counterfactual.manager.start('fixture-dmg')).resolves.toMatchObject({ state: 'needs-tunnel' })
      expect(counterfactual.engine.starts).toBe(0)
      vi.doUnmock('../../app/main/tunnel/runtime')
    } finally {
      vi.doUnmock('../../app/main/tunnel/runtime')
      await Promise.all(managers.map((manager) => manager.dispose()))
      const stopping = service?.requestShutdown()
      daemon.emit('exit', 0, null)
      await stopping
      removeTempDir(dataDir)
      removeTempDir(packageDir)
    }
  }, 30_000)
})
