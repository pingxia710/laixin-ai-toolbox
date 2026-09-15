import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { DownloadResource, StoredDownloadTask } from '../../app/main/download/types'
import { isSafeZip, listZipEntries, MacArtifactInspector, MacInstallerHandoff, type ZipEntry } from '../../app/main/download/mac-artifact'

const execFileAsync = promisify(execFile)
const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('zip 安装器形态守卫', () => {
  it('只接受一个顶层 app 或 pkg，拒绝多目标与越界路径', () => {
    expect(isSafeZip([
      zipEntry('Hermes.app/'),
      zipEntry('Hermes.app/Contents/Info.plist')
    ])).toBe(true)
    expect(isSafeZip([
      zipEntry('Hermes.pkg/'),
      zipEntry('Hermes.pkg/Contents/Archive.pax.gz')
    ])).toBe(true)
    expect(isSafeZip([
      zipEntry('Hermes.app/Contents/Info.plist'),
      zipEntry('Other.app/Contents/Info.plist')
    ])).toBe(false)
    expect(isSafeZip([zipEntry('../Hermes.app/Contents/Info.plist')])).toBe(false)
    expect(isSafeZip([zipEntry('/Hermes.app/Contents/Info.plist')])).toBe(false)
  })

  it('拒绝规范化后重复的真实 ZIP，并在 inspect 与 handoff 两条路径阻断', async () => {
    const root = await createFixtureRoot()
    const archivePath = await createInstallerZip(root, true)
    await renameEntryInPlace(archivePath, 'Hermes.app/Contents/a/Info.plist', 'Hermes.app/Contents/./Info.plist')

    const entries = await listZipEntries(archivePath)
    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'Hermes.app/Contents/Info.plist',
      'Hermes.app/Contents/./Info.plist'
    ]))
    expect(isSafeZip(entries)).toBe(false)

    await expect(new MacArtifactInspector().inspect({ artifactPath: archivePath, format: 'zip' })).resolves.toEqual({ kind: 'not-installer', identity: null })
    await expect(new MacInstallerHandoff().handoff(taskFor(archivePath), zipResource())).rejects.toThrow('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  })

  it('拒绝含归档外符号链接的真实 ZIP，并在 inspect 与 handoff 两条路径阻断', async () => {
    const root = await createFixtureRoot()
    const appPath = await createFixtureApplication(root, false)
    await symlink('/private/tmp/not-in-archive', join(appPath, 'Contents', 'MacOS', 'escaped-link'))
    const archivePath = await archiveApplication(root, true)

    const entries = await listZipEntries(archivePath)
    expect(entries.some((entry) => entry.isSymbolicLink)).toBe(true)
    expect(isSafeZip(entries)).toBe(false)

    await expect(new MacArtifactInspector().inspect({ artifactPath: archivePath, format: 'zip' })).resolves.toEqual({ kind: 'not-installer', identity: null })
    await expect(new MacInstallerHandoff().handoff(taskFor(archivePath), zipResource())).rejects.toThrow('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  })

  it('正常 app ZIP 仍可通过 inspect 并完成 handoff 解包', async () => {
    const root = await createFixtureRoot()
    const archivePath = await createInstallerZip(root, false)

    const entries = await listZipEntries(archivePath)
    expect(isSafeZip(entries)).toBe(true)
    await expect(new MacArtifactInspector().inspect({ artifactPath: archivePath, format: 'zip' })).resolves.toEqual({ kind: 'installer', identity: null })
    await expect(new MacInstallerHandoff().handoff(taskFor(archivePath), zipResource())).resolves.toBe('已解包')
    await expect(readFile(join(root, 'unpacked', 'Hermes.app', 'Contents', 'Info.plist'), 'utf8')).resolves.toContain('com.apple.calculator')
  })

  it('同一个 ZIP 连开两遍都成功：第二次先清旧目录，⛔ ENOTEMPTY', async () => {
    const root = await createFixtureRoot()
    const archivePath = await createInstallerZip(root, false)
    const handoff = new MacInstallerHandoff()

    await expect(handoff.handoff(taskFor(archivePath), zipResource())).resolves.toBe('已解包')
    // 管理器允许 handed-off-install 的任务再次「打开」;第二次必须同样成功,
    // 否则客户看到「安装包未能打开…请重试打开」而重试永远失败。
    await expect(handoff.handoff(taskFor(archivePath), zipResource())).resolves.toBe('已解包')
    await expect(readFile(join(root, 'unpacked', 'Hermes.app', 'Contents', 'Info.plist'), 'utf8')).resolves.toContain('com.apple.calculator')
  })
})

function zipEntry(name: string, externalFileAttributes = 0o100644 * 0x1_0000): ZipEntry {
  return { name, externalFileAttributes, isSymbolicLink: false }
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp('/private/tmp/laixin-toolbox-zip-')
  fixtureRoots.push(root)
  return root
}

async function createInstallerZip(root: string, includeAlias: boolean): Promise<string> {
  await createFixtureApplication(root, includeAlias)
  return archiveApplication(root, false)
}

async function createFixtureApplication(root: string, includeAlias: boolean): Promise<string> {
  const appPath = join(root, 'Hermes.app')
  const contentsPath = join(appPath, 'Contents')
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  const plist = await readFile('/System/Applications/Calculator.app/Contents/Info.plist')
  await writeFile(join(contentsPath, 'Info.plist'), plist)
  await writeFile(join(contentsPath, 'MacOS', 'Calculator'), 'fixture executable')
  if (includeAlias) {
    await mkdir(join(contentsPath, 'a'), { recursive: true })
    await writeFile(join(contentsPath, 'a', 'Info.plist'), plist)
  }
  return appPath
}

async function archiveApplication(root: string, preserveSymlinks: boolean): Promise<string> {
  const archivePath = join(root, 'Hermes.zip')
  if (!preserveSymlinks) {
    await execFileAsync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(root, 'Hermes.app'), archivePath])
    return archivePath
  }
  const args = ['-q']
  args.push('-y')
  args.push('-r', archivePath, 'Hermes.app')
  await execFileAsync('/usr/bin/zip', args, { cwd: root })
  return archivePath
}

async function renameEntryInPlace(archivePath: string, originalName: string, replacementName: string): Promise<void> {
  const archive = await readFile(archivePath)
  const original = Buffer.from(originalName)
  const replacement = Buffer.from(replacementName)
  if (original.length !== replacement.length) throw new Error('fixture ZIP entry names must have equal lengths')

  const endOfCentralDirectory = findEndOfCentralDirectory(archive)
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10)
  let offset = archive.readUInt32LE(endOfCentralDirectory + 16)
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('fixture ZIP central directory is malformed')
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const nameOffset = offset + 46
    if (archive.subarray(nameOffset, nameOffset + nameLength).equals(original)) {
      replacement.copy(archive, nameOffset)
      const localOffset = archive.readUInt32LE(offset + 42)
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('fixture ZIP local header is malformed')
      replacement.copy(archive, localOffset + 30)
      await writeFile(archivePath, archive)
      return
    }
    offset = nameOffset + nameLength + extraLength + commentLength
  }
  throw new Error(`fixture ZIP entry not found: ${originalName}`)
}

function findEndOfCentralDirectory(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 0xffff - 22); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      return offset
    }
  }
  throw new Error('fixture ZIP end record is missing')
}

function taskFor(artifactPath: string): StoredDownloadTask {
  return {
    taskId: 'fixture-task', resourceId: 'fixture-resource', authorizationId: 'fixture-authorization', state: 'ready', reason: '', message: '', receivedBytes: '1', totalBytes: '1', retryCount: '0', resumeEtag: '', resumeLastModified: '', localSha256: '', artifactPath, partPath: `${artifactPath}.part`, startedAt: '', endedAt: ''
  }
}

function zipResource(): DownloadResource {
  return {
    id: 'fixture-resource', software: 'Hermes', platform: 'macos', architecture: 'arm64', type: 'download', officialPageUrl: 'https://example.invalid', assetUrl: 'https://example.invalid/Hermes.zip', allowedHosts: ['example.invalid'], version: '0.0.0', officialVersionLabel: '0.0.0', format: 'zip', approval: { approvedAt: '2026-01-01T00:00:00Z', approvedBy: 'fixture', sourceBuild: 'fixture', scope: '核准这一次下载的那个包' }
  }
}
