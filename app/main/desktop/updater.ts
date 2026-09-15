import { createHash } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateView } from '../../desktop-types'
import { displayReleaseVersion } from '../../release-version'
import { newerVersion, readUpdateManifest, type UpdateRelease } from './update-manifest'
import { updateArchivePaths } from './zip-paths'
import { resolveTunnelDataDir } from '../tunnel/paths'
import { RESIDENT_LABEL } from '../tunnel/platform/resident'

const execFile = promisify(execFileCallback)
// Electron's patched fs interprets app.asar as a directory. Hash the physical archive bytes.
const physicalFs: typeof fs = process.versions.electron ? createRequire(__filename)('original-fs') : fs
interface UpdaterOptions {
  version: string; platform: string; origin: string; publicKey: string; directory: string
  executable: string; helperPath: string; packaged: boolean; quit: () => void
  githubRepository?: string
  sourceTimeoutMs?: number
  fetch?: typeof fetch
}

interface PreviousUpdateFailure {
  readonly version: string
  readonly code: string
}

const updateFailureMessages: Record<string, string> = {
  UPDATE_PARENT_EXIT_TIMEOUT: '旧版未能在规定时间内退出',
  UPDATE_INSTALL_TIMEOUT: '安装程序未能在规定时间内完成',
  UPDATE_INSTALL_FAILED: '安装程序未能完成',
  UPDATE_ASSET_CHANGED: '更新包校验未通过',
  UPDATE_ASAR_INVALID: '安装后的程序校验未通过',
  UPDATE_STARTUP_UNCONFIRMED: '新版未能正常启动'
}

function updateFailureView(failure: PreviousUpdateFailure, notes = ''): UpdateView {
  const reason = updateFailureMessages[failure.code] ?? '上一次更新未完成'
  return { state: 'error', version: failure.version, notes, progress: 0,
    message: `${reason}。原版本、账号和配置已保留；请点击“重新下载”重试，仍失败请复制诊断给客服。` }
}

function readPreviousUpdateFailure(directory: string): PreviousUpdateFailure | undefined {
  try {
    const value = JSON.parse(physicalFs.readFileSync(join(directory, 'result.json'), 'utf8')) as { version?: unknown; state?: unknown; code?: unknown }
    if (value.state !== 'error' || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 100) return undefined
    return { version: value.version, code: typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'UPDATE_PREVIOUS_ATTEMPT_FAILED' }
  } catch { return undefined }
}

export class ToolboxUpdater {
  private view: UpdateView = { state: 'idle', version: '', notes: '', progress: 0, message: '可检查来信 AI 工具箱的新版本。' }
  private release?: UpdateRelease
  private controller?: AbortController
  private downloaded?: string
  private busy = false
  private disposed = false
  constructor(private readonly options: UpdaterOptions) {
    const failure = readPreviousUpdateFailure(options.directory)
    if (failure !== undefined) this.view = updateFailureView(failure)
  }
  status(): UpdateView { return { ...this.view } }

  async check(): Promise<UpdateView> {
    if (this.busy || this.disposed || ['ready', 'installing'].includes(this.view.state)) return this.status()
    this.busy = true; this.view = { state: 'checking', version: '', notes: '', progress: 0, message: '正在检查新版本…' }
    this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(), 20_000)
    try {
      const origin = new URL(this.options.origin)
      const release = await this.readRelease(origin)
      // 这一版装过、网络连不上、已经自动退回来了 ⇒ ⛔ 再自动装一次(否则客户卡在
      // 装上→连不上→退回→再装 的循环里,而且不知道发生了什么)。如实告诉他,并留一条手动重试的路。
      const rejected = await readRejectedVersion(this.options.directory)
      if (rejected?.version === release.version) {
        this.release = undefined
        this.view = { state: 'current', version: release.version, notes: release.notes, progress: 0,
          message: `${displayReleaseVersion(release.version)} 安装后 AI网络无法连接，已自动还原到当前版本。可稍后再试，或联系来信客服。` }
        return this.status()
      }
      this.release = release
      const available = newerVersion(release.version, this.options.version)
      const failure = readPreviousUpdateFailure(this.options.directory)
      if (available && failure?.version === release.version) {
        this.view = updateFailureView(failure, release.notes)
        return this.status()
      }
      this.view = { state: available ? 'available' : 'current', version: release.version, notes: release.notes, progress: 0,
        message: available ? `发现新版 ${displayReleaseVersion(release.version)}` : '当前已是最新可用版本。' }
    } catch (error) {
      this.release = undefined
      this.fail(error instanceof Error && error.message === 'UPDATE_FEED_UNAVAILABLE' ? '更新服务暂未提供版本信息，请稍后再检查。' : '暂时无法检查更新，请稍后重试。')
    } finally { clearTimeout(timeout); this.busy = false }
    return this.status()
  }

  async download(): Promise<UpdateView> {
    if (this.busy || this.disposed || !this.release || !newerVersion(this.release.version, this.options.version)) return this.status()
    this.busy = true; this.controller = new AbortController()
    this.view = { ...this.view, state: 'downloading', progress: 0, message: '正在下载新版…' }
    let partial: string | undefined
    const timeout = setTimeout(() => this.controller?.abort(), 30 * 60_000)
    try {
      const asset = this.release.assets[this.options.platform]
      const folder = await mkdtemp(await this.updatePrefix())
      const destination = join(folder, this.options.platform.startsWith('darwin-') ? 'update.zip' : 'update.exe')
      partial = `${destination}.part`
      let downloaded = false
      for (const url of [...(asset.mirrors ?? []), asset.url]) {
        await rm(partial, { force: true })
        try {
          await this.downloadAsset(url, partial, asset)
          downloaded = true
          break
        } catch {
          if (this.controller.signal.aborted) throw new Error('UPDATE_DOWNLOAD_FAILED')
        }
      }
      if (!downloaded) throw new Error('UPDATE_DOWNLOAD_FAILED')
      await rename(partial, destination); partial = undefined; this.downloaded = destination
      this.view = { ...this.view, state: 'ready', progress: 100, message: '新版已准备好。更新并重启会暂时断开 AI网络，账号和配置会保留。' }
    } catch {
      if (partial) await rm(partial, { force: true }).catch(() => undefined)
      this.fail('新版下载未完成或校验未通过，请重试。当前版本仍可继续使用。')
    } finally { clearTimeout(timeout); this.busy = false }
    return this.status()
  }

  async install(): Promise<UpdateView> {
    if (this.busy || this.disposed || this.view.state !== 'ready' || !this.release || !this.downloaded) return this.status()
    if (!this.options.packaged) { this.fail('请在已安装的工具箱中使用更新功能。'); return this.status() }
    this.busy = true; this.view = { ...this.view, state: 'installing', message: '正在准备更新并重启…' }
    try {
      const asset = this.release.assets[this.options.platform]
      if ((await stat(this.downloaded)).size !== asset.size || await fileDigest(this.downloaded) !== asset.sha256) throw new Error('UPDATE_DIGEST_INVALID')
      const mac = this.options.platform.startsWith('darwin-')
      const target = mac ? dirname(dirname(dirname(this.options.executable))) : dirname(this.options.executable)
      if (mac && (!target.endsWith('.app') || target.startsWith('/Volumes/'))) throw new Error('UPDATE_LOCATION_UNWRITABLE')
      await access(mac ? dirname(target) : target, constants.W_OK)
      const jobDirectory = dirname(this.downloaded)
      let staged = ''
      if (mac) {
        const names = await updateArchivePaths(this.downloaded)
        if (!names.length || names.some((name) => !name.startsWith('来信AI工具箱统一版.app/') || name.split('/').includes('..'))) throw new Error('UPDATE_ARCHIVE_INVALID')
        const extracted = await mkdtemp(join(jobDirectory, 'extracted-'))
        await execFile('/usr/bin/ditto', ['-xk', this.downloaded, extracted], { timeout: 120_000 })
        staged = join(extracted, '来信AI工具箱统一版.app')
        await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], { timeout: 60_000 })
        const plist = join(staged, 'Contents', 'Info.plist')
        const bundle = (await execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).stdout.trim()
        const version = (await execFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).stdout.trim()
        if (bundle !== 'com.laixin.ai-toolbox.ui-capabilities' || version !== this.release.version ||
            await fileDigest(join(staged, 'Contents', 'Resources', 'app.asar')) !== asset.asarSha256) throw new Error('UPDATE_BUNDLE_INVALID')
      }
      const userData = dirname(this.options.directory)
      const residentHandoff = residentHandoffFields(userData)
      const job = { parentPid: process.pid, platform: mac ? 'mac' : 'win', target, staged, installer: this.downloaded,
        userData,
        ...residentHandoff,
        executable: this.options.executable, version: this.release.version, asarSha256: asset.asarSha256,
        assetSha256: asset.sha256, assetSize: asset.size,
        // 助手等回执的上限:客户本来没连着就照旧 45 秒,⛔ 多等一秒;本来连着的要容下
        // 「新版起来 → 装常驻 → 首连(含守护自己 42 秒的退避梯子)」,再留 30 秒给新版退出。
        // 两端都认这个字段(mac update-helper.cjs / win update-helper.ps1),⛔ 各写一个数。
        startupTimeoutMs: residentHandoff.tunnelResume ? 90_000 : 45_000,
        result: join(this.options.directory, 'result.json'), ready: join(jobDirectory, 'helper-ready'),
        acknowledgement: join(this.options.directory, 'acknowledgement.json') }
      const jobPath = join(jobDirectory, 'job.json')
      await writeFile(jobPath, JSON.stringify(job), { mode: 0o600 })
      await Promise.all([rm(job.ready, { force: true }), rm(join(this.options.directory, 'result.json'), { force: true })])
      // requireConnected:更新前客户是连着的 ⇒ 新版「起来了」还不算数,要等网络真的连上才写回执。
      await writeFile(join(this.options.directory, 'pending.json'),
        JSON.stringify({ version: job.version, acknowledgement: job.acknowledgement, requireConnected: job.tunnelResume }), { mode: 0o600 })
      const child = spawn(mac ? this.options.executable : 'powershell.exe', mac ? [this.options.helperPath, jobPath] :
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.options.helperPath, '-JobPath', jobPath], {
        env: mac ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env, detached: true, windowsHide: true, stdio: 'ignore'
      })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      const deadline = Date.now() + 5000
      while (!await pathExists(job.ready)) {
        if (Date.now() > deadline) throw new Error('UPDATE_HELPER_FAILED')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Let the IPC reply reach the window before normal shutdown starts.
      setTimeout(() => this.options.quit(), 100)
    } catch (error) {
      const location = ['EACCES', 'EPERM', 'UPDATE_LOCATION_UNWRITABLE'].includes((error as NodeJS.ErrnoException).code ?? (error as Error).message)
      this.fail(location ? '暂时无法替换程序，请将工具箱移至可写的应用目录后重试。账号和配置已保留。'
        : '更新包未能完成校验或准备，请重新下载。原版本和账号数据已保留。')
    } finally { this.busy = false }
    return this.status()
  }

  dispose(): void { this.disposed = true; this.controller?.abort() }
  private fail(message: string): void { this.view = { ...this.view, state: 'error', message } }
  private async updatePrefix(): Promise<string> { await mkdir(this.options.directory, { recursive: true, mode: 0o700 }); return join(this.options.directory, 'download-') }

  private async readRelease(origin: URL): Promise<UpdateRelease> {
    let unavailable = false
    for (const url of this.feedUrls(origin)) {
      const source = new AbortController()
      const abort = () => source.abort()
      this.controller?.signal.addEventListener('abort', abort, { once: true })
      const sourceTimeout = setTimeout(abort, this.options.sourceTimeoutMs ?? 8_000)
      try {
        const response = await (this.options.fetch ?? fetch)(url, { signal: source.signal, redirect: 'follow' })
        if (response.status === 404) unavailable = true
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 64 * 1024 || !response.body) continue
        const chunks: Uint8Array[] = []; let length = 0
        for await (const chunk of response.body) {
          length += chunk.length
          if (length > 64 * 1024) throw new Error('UPDATE_MANIFEST_INVALID')
          chunks.push(chunk)
        }
        return readUpdateManifest(Buffer.concat(chunks).toString('utf8'), this.options.publicKey, origin, this.options.platform,
          this.options.version, this.options.githubRepository)
      } catch (error) {
        if (this.controller?.signal.aborted) throw error
      } finally {
        clearTimeout(sourceTimeout)
        this.controller?.signal.removeEventListener('abort', abort)
      }
    }
    throw new Error(unavailable ? 'UPDATE_FEED_UNAVAILABLE' : 'UPDATE_CHECK_FAILED')
  }

  private feedUrls(origin: URL): string[] {
    const urls = [new URL('updates/latest.json', origin).href]
    if (this.options.githubRepository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.options.githubRepository)) {
      urls.push(`https://github.com/${this.options.githubRepository}/releases/latest/download/latest.json`)
    }
    return urls
  }

  private async downloadAsset(url: string, partial: string, asset: UpdateRelease['assets'][string]): Promise<void> {
    const source = new AbortController()
    const abort = () => source.abort()
    this.controller?.signal.addEventListener('abort', abort, { once: true })
    let stalled = setTimeout(abort, 15_000)
    try {
      const response = await (this.options.fetch ?? fetch)(url, { signal: source.signal, redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error('UPDATE_DOWNLOAD_FAILED')
      const hash = createHash('sha256'); let size = 0
      const file = await open(partial, 'wx', 0o600)
      try {
        for await (const chunk of response.body) {
          clearTimeout(stalled); stalled = setTimeout(abort, 15_000)
          size += chunk.length
          if (size > asset.size) throw new Error('UPDATE_SIZE_INVALID')
          hash.update(chunk); await file.writeFile(chunk)
          this.view.progress = Math.floor(size / asset.size * 100)
        }
        await file.sync()
      } finally { await file.close() }
      if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('UPDATE_DIGEST_INVALID')
    } finally {
      clearTimeout(stalled)
      this.controller?.signal.removeEventListener('abort', abort)
    }
  }
}

// 更新时的常驻交接（0.5.0）要带给助手的三样。
// 助手会在换 bundle 前把常驻守护停掉（bootout），停之前要把「客户本来是连着的」记成接续标记，
// 否则守护按正常关停把意图写成 shutdown，新版起来就不再连了（= 更新完断网）。
// **这一眼必须在这里看**：本函数跑的时候工具箱还活着、还连着；等助手起来时，工具箱自己的退出流程
// 可能已经把意图文件改成 shutdown 了，那时候再读就分不出「客户本来连着」还是「客户自己断开的」。
// 数据目录按与主进程同一条规则算（resolveTunnelDataDir），⛔ 在这里另写一份 join(userData, 'tunnel')。
// 单独抽成函数是为了能直接核对，⛔ 只能靠跑一次完整更新才知道这三样有没有带上。
export function residentHandoffFields(userData: string, env: NodeJS.ProcessEnv = process.env):
  { tunnelDataDir: string; residentLabel: string; tunnelResume: boolean } {
  const tunnelDataDir = resolveTunnelDataDir(env, userData)
  return { tunnelDataDir, residentLabel: RESIDENT_LABEL, tunnelResume: tunnelConnectedNow(tunnelDataDir) }
}

function tunnelConnectedNow(tunnelDataDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(physicalFs.readFileSync(join(tunnelDataDir, 'intent.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { desired?: unknown }).desired === 'connected'
  } catch { return false } // 没有意图文件 = 客户本来就没连着，更新完也不该自己连上
}

/** 新版起来之后，这一轮更新到底算不算成
 *  · connected  = 网络已连上，认这一版
 *  · abandoned  = 客户自己不要连接了（点了断开 / 退出账号），**也认**——那不是更新的锅
 *  · waiting    = 还在试，继续等 */
export type UpdateOutcome = 'connected' | 'abandoned' | 'waiting'

export interface AcknowledgeDeps {
  /** 通道当下算哪一种。⛔ 用 supervisor 的 surrendered 判：那个只管「守护起没起来」，
   *  而「守护起来了、连不上节点」压根不经过它，正是更新后最可能的那种失败。 */
  readonly outcome: () => UpdateOutcome
  /** 放弃这一版：退出自己，把台让给更新助手——它等不到回执、又看见进程走了，就会把旧版换回来。 */
  readonly giveUp: () => void
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly wait?: (ms: number) => Promise<void>
  readonly now?: () => number
}

/** 新版这边等多久才判「这一版连不上」。按 spawn 模式守护自己的退避梯子（2+10+30≈42 秒）留余量——
 *  ⛔ 抢在守护还在重试时就判死；也 ⛔ 等太久，助手那头还留着 30 秒给退出用。 */
export const UPDATE_CONNECT_TIMEOUT_MS = 60_000

/** 被回退过的版本记在这里，⛔ 让自动更新下一轮又装上去、又连不上、又回退，把客户卡在循环里。 */
export function rejectedVersionPath(directory: string): string { return join(directory, 'rejected.json') }

export async function readRejectedVersion(directory: string): Promise<{ version: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(rejectedVersionPath(directory), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? { version: parsed.version } : undefined
  } catch { return undefined }
}

export async function acknowledgeUpdate(directory: string, version: string, deps?: AcknowledgeDeps): Promise<void> {
  try {
    const pending = JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8')) as { version: string; requireConnected?: boolean }
    if (pending.version !== version) return
    // 更新前客户是连着的 ⇒ 「起来了」还不算数，要等网络真的连上才写回执。
    // 在此之前 ⛔ 修剪 previous-*.app —— 那是唯一的退路，提前剪掉就回不去了。
    if (pending.requireConnected === true && deps !== undefined) {
      const settled = await waitForConnectedOutcome(deps)
      if (settled === 'waiting') {
        // 到点没连上:记下这一版别再自动装,然后退出自己。助手等不到回执、看见进程走了，
        // 会用既有的两个 rename 把旧版换回来并拉起 —— ⛔ 在这里自己搬 bundle。
        await writeFile(rejectedVersionPath(directory), JSON.stringify({ version, at: (deps.now ?? Date.now)() }), { mode: 0o600 })
        deps.giveUp()
        return
      }
    }
    await writeFile(join(directory, 'acknowledgement.json'), JSON.stringify({ version, pid: process.pid }), { mode: 0o600 })
  } catch { /* No pending update on ordinary startup. */ return }
  // 新版启动已确认:只保留最近一份可回退备份,并清掉历次更新的 download-* 工作目录。
  try {
    const entries = await readdir(directory)
    const stampOf = (name: string): number => Number(/^previous-(\d+)\.app$/.exec(name)![1])
    const backups = entries.filter((name) => /^previous-\d+\.app$/.test(name)).sort((left, right) => stampOf(left) - stampOf(right))
    await Promise.all(backups.slice(0, -1).map((name) => rm(join(directory, name), { recursive: true, force: true })))
  } catch { /* 清理失败不影响更新确认。 */ }
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('download-'))
      .map((entry) => rm(join(directory, entry.name), { recursive: true, force: true })))
  } catch { /* 清理失败不影响更新确认。 */ }
}

/** 盯到「连上」或「客户自己不要连了」为止；到点仍在试就返回 waiting。 */
async function waitForConnectedOutcome(deps: AcknowledgeDeps): Promise<UpdateOutcome> {
  const now = deps.now ?? Date.now
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (deps.timeoutMs ?? UPDATE_CONNECT_TIMEOUT_MS)
  for (;;) {
    const outcome = deps.outcome()
    if (outcome !== 'waiting') return outcome
    if (now() >= deadline) return 'waiting'
    await wait(deps.pollMs ?? 500)
  }
}

async function pathExists(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of physicalFs.createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
