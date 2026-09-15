import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { DOWNLOAD_VERIFY_TIMEOUT, isVerifyTimeout } from './types'
import type { DownloadArtifactInspector, DownloadResource, StoredDownloadTask } from './types'

const execFileAsync = promisify(execFile)

// 单条校验命令的上限:hdiutil attach 遇许可协议 DMG 会在 stdin 上等,codesign --deep
// 对大 .app 也可能久挂。⛔ 无超时——任务会永远停在「校验中」,界面上没有任何按钮能退出,
// 只能退出工具箱重开(重启后才由 recoverAfterRestart 收尾)。
const VERIFY_COMMAND_TIMEOUT_MS = 60_000
// 卸载挂载点是清理动作:本次校验已被取消或超时时它也必须跑完,所以自带短上限、⛔ 吃取消信号。
const DETACH_TIMEOUT_MS = 15_000

interface RunOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export class MacArtifactInspector implements DownloadArtifactInspector {
  async inspect(input: Parameters<DownloadArtifactInspector['inspect']>[0]): ReturnType<DownloadArtifactInspector['inspect']> {
    if (input.format === 'dmg') {
      return this.inspectDmg(input.artifactPath, input.signal)
    }
    if (input.format === 'zip') {
      return this.inspectZip(input.artifactPath, input.signal)
    }
    return this.inspectPkg(input.artifactPath, input.signal)
  }

  private async inspectDmg(artifactPath: string, signal?: AbortSignal): Promise<Awaited<ReturnType<DownloadArtifactInspector['inspect']>>> {
    const mountPath = await createScratchDirectory(artifactPath, '.identity-dmg-')
    try {
      await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPath, artifactPath], { signal })
      return await inspectSingleApplication(mountPath, signal)
    } catch (error) {
      // 超时是判不出来,⛔ 吞成「不是安装包」——那会删掉客户已经下好的文件。
      if (isVerifyTimeout(error)) throw error
      return { kind: 'not-installer', identity: null }
    } finally {
      await detachQuietly(mountPath)
      await rm(mountPath, { recursive: true, force: true })
    }
  }

  private async inspectZip(artifactPath: string, signal?: AbortSignal): Promise<Awaited<ReturnType<DownloadArtifactInspector['inspect']>>> {
    const scratchPath = await createScratchDirectory(artifactPath, '.identity-zip-')
    try {
      const entries = await listZipEntries(artifactPath)
      if (!isSafeZip(entries)) {
        return { kind: 'not-installer', identity: null }
      }
      await run('/usr/bin/ditto', ['-x', '-k', artifactPath, scratchPath], { signal })
      return await inspectSingleApplication(scratchPath, signal)
    } catch (error) {
      if (isVerifyTimeout(error)) throw error
      return { kind: 'not-installer', identity: null }
    } finally {
      await rm(scratchPath, { recursive: true, force: true })
    }
  }

  private async inspectPkg(artifactPath: string, signal?: AbortSignal): Promise<Awaited<ReturnType<DownloadArtifactInspector['inspect']>>> {
    try {
      await run('/usr/sbin/pkgutil', ['--check-signature', artifactPath], { signal })
      return { kind: 'installer', identity: null }
    } catch (error) {
      if (isVerifyTimeout(error)) throw error
      return { kind: 'not-installer', identity: null }
    }
  }
}

export class MacInstallerHandoff {
  async handoff(task: StoredDownloadTask, resource: DownloadResource): Promise<string> {
    if (resource.format === 'dmg') {
      await run('/usr/bin/open', [task.artifactPath])
      return '已打开安装包，请按窗口中的步骤安装'
    }
    if (resource.format === 'zip') {
      await this.extractZip(task.artifactPath)
      return '已解包'
    }
    return '待安装器启动'
  }

  private async extractZip(artifactPath: string): Promise<void> {
    const entries = await listZipEntries(artifactPath)
    if (!isSafeZip(entries)) {
      throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
    }
    const scratchPath = await createScratchDirectory(artifactPath, '.unpack-')
    const destination = join(dirname(artifactPath), 'unpacked')
    try {
      await run('/usr/bin/ditto', ['-x', '-k', artifactPath, scratchPath])
      // 先清旧目录再落位:destination 是固定名,第二次「打开」时旧目录还在,
      // rename 会 ENOTEMPTY ⇒ 客户看到「安装包未能打开,请重试打开」而重试永远失败。
      // 清理放在解包成功之后:新内容已经完整落在 scratch 上,⛔ 先删旧再解包。
      await rm(destination, { recursive: true, force: true })
      await rename(scratchPath, destination)
    } catch (error) {
      await rm(scratchPath, { recursive: true, force: true })
      throw error
    }
  }
}

export interface ZipEntry {
  readonly name: string
  readonly externalFileAttributes: number
  readonly isSymbolicLink: boolean
}

export async function listZipEntries(artifactPath: string): Promise<readonly ZipEntry[]> {
  return parseZipEntries(await readFile(artifactPath))
}

export function isSafeZip(entries: readonly ZipEntry[]): boolean {
  const topLevelTargets = new Set<string>()
  const paths = new Set<string>()
  for (const entry of entries) {
    if (isZipSymbolicLink(entry.externalFileAttributes)) return false
    const path = normalizeZipPath(entry.name)
    if (path === undefined || paths.has(path)) return false
    paths.add(path)
    const topLevel = path.split('/', 1)[0]
    if (topLevel.endsWith('.app') || topLevel.endsWith('.pkg')) {
      topLevelTargets.add(topLevel)
    }
  }
  return topLevelTargets.size === 1
}

function parseZipEntries(archive: Buffer): readonly ZipEntry[] {
  const endOfCentralDirectory = findEndOfCentralDirectory(archive)
  if (endOfCentralDirectory === undefined) throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')

  const diskNumber = archive.readUInt16LE(endOfCentralDirectory + 4)
  const centralDirectoryDisk = archive.readUInt16LE(endOfCentralDirectory + 6)
  const entriesOnDisk = archive.readUInt16LE(endOfCentralDirectory + 8)
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10)
  const centralDirectorySize = archive.readUInt32LE(endOfCentralDirectory + 12)
  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectory + 16)
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffff_ffff ||
    centralDirectoryOffset === 0xffff_ffff
  ) {
    throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryEnd > endOfCentralDirectory || centralDirectoryEnd < centralDirectoryOffset) {
    throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  }

  const entries: ZipEntry[] = []
  let offset = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
    }
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength
    if (entryEnd > centralDirectoryEnd || entryEnd < offset) {
      throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
    }
    const name = decodeZipEntryName(archive.subarray(offset + 46, offset + 46 + nameLength))
    const externalFileAttributes = archive.readUInt32LE(offset + 38)
    entries.push({
      name,
      externalFileAttributes,
      isSymbolicLink: isZipSymbolicLink(externalFileAttributes)
    })
    offset = entryEnd
  }
  if (offset !== centralDirectoryEnd) throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  return entries
}

function isZipSymbolicLink(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & 0xf000) === 0xa000
}

function findEndOfCentralDirectory(archive: Buffer): number | undefined {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 0xffff - 22); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      return offset
    }
  }
  return undefined
}

function decodeZipEntryName(nameBytes: Buffer): string {
  const name = nameBytes.toString('utf8')
  if (!Buffer.from(name, 'utf8').equals(nameBytes)) throw new Error('DOWNLOAD_ARCHIVE_SHAPE_INVALID')
  return name
}

function normalizeZipPath(name: string): string | undefined {
  if (name.startsWith('/') || name.includes('\0')) return undefined
  const segments: string[] = []
  for (const segment of name.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') return undefined
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

async function inspectSingleApplication(root: string, signal?: AbortSignal): Promise<Awaited<ReturnType<DownloadArtifactInspector['inspect']>>> {
  const applications = await findApplications(root)
  if (applications.length !== 1) {
    return { kind: 'not-installer', identity: null }
  }
  const application = applications[0]
  try {
    const plist = join(application, 'Contents', 'Info.plist')
    const bundleIdentifier = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { signal })).trim()
    const executable = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { signal })).trim()
    const executablePath = join(application, 'Contents', 'MacOS', executable)
    let signingSubject: string | undefined
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { signal })
      const signature = await run('/usr/bin/codesign', ['-dv', '--verbose=4', application], { signal })
      signingSubject = signature.split('\n').find((line) => line.startsWith('Authority='))?.slice('Authority='.length)
    } catch (error) {
      // codesign 挂住是判不出来,⛔ 悄悄当成「这个包没签名」——那等于把超时降级成身份结论。
      if (isVerifyTimeout(error)) throw error
      signingSubject = undefined
    }
    const fileDescription = await run('/usr/bin/file', [executablePath], { signal })
    return {
      kind: 'installer',
      identity: signingSubject === undefined
        ? null
        : {
            installerBundleIdentifier: bundleIdentifier,
            signingSubject,
            architecture: fileDescription.includes('arm64') ? 'arm64' : 'unknown'
          }
    }
  } catch (error) {
    if (isVerifyTimeout(error)) throw error
    return { kind: 'not-installer', identity: null }
  }
}

async function findApplications(directory: string): Promise<string[]> {
  const applications: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      applications.push(path)
      continue
    }
    if (entry.isDirectory()) {
      applications.push(...await findApplications(path))
    }
  }
  return applications
}

async function createScratchDirectory(artifactPath: string, prefix: string): Promise<string> {
  const root = dirname(artifactPath)
  const path = join(root, `${prefix}${Math.random().toString(16).slice(2)}`)
  if (relative(root, path).startsWith('..')) {
    throw new Error('DOWNLOAD_ARCHIVE_PATH_INVALID')
  }
  await mkdir(path, { recursive: false })
  return path
}

// attach 被超时/取消杀在半路时挂载点可能已经建立 ⇒ 无条件试一次卸载,
// ⛔ 只在「attach 返回成功」时才卸载(那会把镜像一直挂在系统上)。
// 普通 detach 在进程被 SIGKILL 后可能拒绝,再补一次 -force;两次都失败就算了,不挡主流程。
async function detachQuietly(mountPath: string): Promise<void> {
  try {
    await run('/usr/bin/hdiutil', ['detach', mountPath], { timeoutMs: DETACH_TIMEOUT_MS })
  } catch {
    await run('/usr/bin/hdiutil', ['detach', mountPath, '-force'], { timeoutMs: DETACH_TIMEOUT_MS }).catch(() => undefined)
  }
}

async function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  const execution = execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? VERIFY_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    signal: options.signal
  })
  // execFile 不转发 stdio,子进程 stdin 是我们永不写入的管道 ⇒ hdiutil 遇到带许可协议的
  // DMG 会停在 Agree? 上永远等下去。立刻给它 EOF;超时与 signal 只是兜底。
  execution.child.stdin?.end()
  try {
    const { stdout, stderr } = await execution
    return `${stdout}${stderr}`
  } catch (error) {
    // 取消是用户动作,照原样抛给上层认。超时是「判不出来」,必须与「判定不是安装包」分开:
    // 后者会把已下载好的文件删掉让客户重下,而超时时文件多半好端端的。
    if (isAborted(error, options.signal)) {
      // Node 的 AbortSignal 中止只发 SIGTERM(⛔ 看 killSignal),而且会把 execFile 自带的
      // SIGKILL 兜底定时器一并清掉 ⇒ 忽略 TERM 的子进程会一直活着。这里补一刀。
      // hdiutil/codesign/PlistBuddy 都是只读检查,被 KILL 不留脏状态;挂载点由 detachQuietly 收。
      execution.child.kill('SIGKILL')
      throw error
    }
    if (isTimeoutKill(error)) throw Object.assign(new Error(DOWNLOAD_VERIFY_TIMEOUT), { code: DOWNLOAD_VERIFY_TIMEOUT, command })
    throw error
  }
}

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as { name?: string }).name === 'AbortError'
}

// execFile 超时后用 killSignal 杀子进程,错误上带 killed=true 与该信号。
function isTimeoutKill(error: unknown): boolean {
  return (error as { killed?: boolean }).killed === true
}
