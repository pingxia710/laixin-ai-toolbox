import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../../app/main/download/catalog'
import { WinArtifactInspector, WinInstallerHandoff } from '../../app/main/download/win-artifact'

describe('Windows 目录条目(经 loadCatalog 真实解析)', () => {
  it('hermes-windows-x86-64:exe、直连单源、identity 待真机为 null、快照钉死', () => {
    const catalog = loadCatalog()
    const resource = catalog.resources.find((entry) => entry.id === 'hermes-windows-x86-64')
    expect(resource).toBeDefined()
    expect(resource).toMatchObject({
      software: 'Hermes',
      platform: 'windows',
      architecture: 'x86_64',
      type: 'download',
      format: 'exe',
      expectedBytes: '7946048',
      recordedSha256: 'cfc818adf831a748c61a407152a03c7a426ebee78f499d20a31fae2b5ac5d827',
      identity: null
    })
    // 网络侧 Windows 尚无 sidecar:只允许直连来源,⛔ 配一个到不了隧道源。
    expect(resource?.sources).toHaveLength(1)
    expect(resource?.sources?.[0]).toMatchObject({ id: 'official-direct', network: 'direct' })
  })
})

describe('Windows exe 校验面(形状检查 + 钉死快照)', () => {
  it('MZ 头判 installer,非 exe/非 PE 判 not-installer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'win-artifact-'))
    const inspector = new WinArtifactInspector()
    const exe = join(dir, 'Hermes-Setup.exe')
    await writeFile(exe, Buffer.from('MZ' + Buffer.alloc(64)))
    await expect(inspector.inspect({ artifactPath: exe, format: 'exe' })).resolves.toMatchObject({ kind: 'installer', identity: null })
    const plain = join(dir, 'plain.exe')
    await writeFile(plain, 'not-an-installer')
    await expect(inspector.inspect({ artifactPath: plain, format: 'exe' })).resolves.toMatchObject({ kind: 'not-installer' })
    const dmg = join(dir, 'Hermes-Setup.dmg')
    await writeFile(dmg, Buffer.from('MZ' + Buffer.alloc(64)))
    await expect(inspector.inspect({ artifactPath: dmg, format: 'dmg' })).resolves.toMatchObject({ kind: 'not-installer' })
  })
})

describe('Windows 交接(不代跑 exe,在资源管理器中显示)', () => {
  it('exe 交接调 reveal 并给出双击指引;非 exe 只给指引', async () => {
    const revealed: string[] = []
    const handoff = new WinInstallerHandoff((filePath) => revealed.push(filePath))
    const task = { artifactPath: 'C:\\download\\Hermes-Setup.exe' } as Parameters<WinInstallerHandoff['handoff']>[0]
    const resource = { format: 'exe' } as Parameters<WinInstallerHandoff['handoff']>[1]
    const message = await handoff.handoff(task, resource)
    expect(message).toContain('双击运行')
    expect(revealed).toEqual(['C:\\download\\Hermes-Setup.exe'])
    const other = await handoff.handoff(task, { format: 'dmg' } as Parameters<WinInstallerHandoff['handoff']>[1])
    expect(other).not.toContain('双击')
    expect(revealed).toHaveLength(1)
  })
})
