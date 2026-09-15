import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { loadCatalog } from '../../app/main/download/catalog'
import { DownloadManager } from '../../app/main/download/download-manager'
import { MacArtifactInspector } from '../../app/main/download/mac-artifact'
import { createFileTaskStore, taskPaths } from '../../app/main/download/task-store'

const exec = promisify(execFile)
const artifact = process.env.TOOLBOX_HERMES_ARTIFACT

// Opt-in: inspect a supplied official DMG without executing its installer.
// 逐屏引导退役(0.4.8-fix.1)后,原来的「Setup 身份读取」一段随引导适配器一起去掉;
// 这里仍验下载侧的导入、字节校验与重开恢复,以及 DMG 能被正常挂载。
it.skipIf(!artifact)('真实官方 DMG 经生产导入、签名核验与重开恢复通过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'toolbox-official-hermes-'))
  const mount = join(root, 'mount')
  let attached = false
  try {
    const catalog = loadCatalog()
    const manager = new DownloadManager({
      catalog, engine: { start: async () => { throw new Error('No network permitted') } },
      store: createFileTaskStore(root), inspector: new MacArtifactInspector(),
      tunnel: () => ({ state: 'stopped', localProxyUrl: undefined }),
      copyLocalArtifact: copyFile, taskPaths: (id, resource) => taskPaths(root, id, resource)
    })
    const task = await manager.importLocal('hermes-macos-arm64', resolve(artifact!))
    expect(task.state).toBe('ready')
    expect(task.localSha256).toBe(catalog.resources[0].recordedSha256)
    await manager.recoverAfterRestart()
    expect((await manager.latest('hermes-macos-arm64'))?.state).toBe('ready')
    await mkdir(mount)
    await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, resolve(artifact!)])
    attached = true
    // 官方 DMG 里就是这个 Setup 应用;安装由客户自己双击完成,工具箱不再逐屏引导。
    expect(existsSync(join(mount, 'Hermes.app/Contents/MacOS/Hermes-Setup'))).toBe(true)
  } finally {
    if (attached) await exec('/usr/bin/hdiutil', ['detach', mount])
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
