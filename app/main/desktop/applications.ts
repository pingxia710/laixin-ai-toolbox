import { execFile as execFileCallback, spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AiApplicationId, AiApplicationView } from '../../desktop-types'

const execFile = promisify(execFileCallback)
export type ReadCommand = (command: string, args: string[]) => Promise<string>
const readCommand: ReadCommand = async (command, args) => (await execFile(command, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 })).stdout.trim()
interface ApplicationTarget extends AiApplicationView { path?: string; storeId?: string }
const dispatchCommand = async (command: string, args: string[]): Promise<void> => {
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
}

export class ApplicationLauncher {
  constructor(private readonly home: string, private readonly platform: string,
    private readonly openPath: (path: string) => Promise<string>, private readonly read: ReadCommand = readCommand,
    private readonly dispatch = dispatchCommand) {}

  async list(): Promise<AiApplicationView[]> {
    return Promise.all((['codex', 'hermes'] as const).map(async (id) => {
      const { state, version } = await this.inspect(id)
      return { id, state, version }
    }))
  }

  async open(id: string): Promise<{ opened: boolean; message: string }> {
    if (id !== 'codex' && id !== 'hermes') throw new Error('AI_APPLICATION_INVALID')
    const target = await this.inspect(id)
    if (target.state !== 'installed') return { opened: false, message: target.state === 'missing' ? '未找到已安装的软件，请查看官方下载与版本信息。' : '暂时无法确认安装位置，请到下载与版本信息重新检测。' }
    try {
      if (target.storeId) await this.dispatch('explorer.exe', [`shell:AppsFolder\\${target.storeId}`])
      else if (!target.path || await this.openPath(target.path)) throw new Error('AI_OPEN_FAILED')
      return { opened: true, message: `正在打开 ${id === 'codex' ? 'Codex' : 'Hermes'}。` }
    } catch { return { opened: false, message: '软件未能打开，请重试或到下载与版本信息检查。' } }
  }

  private async inspect(id: AiApplicationId): Promise<ApplicationTarget> {
    try {
      if (this.platform === 'darwin') return await this.mac(id)
      if (this.platform === 'win32') return await this.windows(id)
      return { id, state: 'unavailable', version: '' }
    } catch { return { id, state: 'unavailable', version: '' } }
  }

  private async mac(id: AiApplicationId): Promise<ApplicationTarget> {
    const roots = ['/Applications', join(this.home, 'Applications')]
    const candidates = id === 'codex' ? roots.flatMap((root) => ['Codex.app', 'ChatGPT.app'].map((name) => join(root, name)))
      : ['mac-arm64', 'mac'].map((arch) => join(this.home, '.hermes', 'hermes-agent', 'apps', 'desktop', 'release', arch, 'Hermes.app'))
    for (const path of candidates) {
      if (!await exists(join(path, 'Contents', 'Info.plist'))) continue
      const plist = join(path, 'Contents', 'Info.plist')
      const field = (key: string) => this.read('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])
      const identity = await field('CFBundleIdentifier')
      if (id === 'codex' && identity !== 'com.openai.codex') continue
      const executable = await field('CFBundleExecutable')
      if (!executable || executable.includes('/') || executable === 'Hermes-Setup') continue
      if (id === 'hermes' && executable !== 'Hermes') continue
      await access(join(path, 'Contents', 'MacOS', executable), constants.X_OK)
      return { id, state: 'installed', version: await field('CFBundleShortVersionString'), path }
    }
    return { id, state: 'missing', version: '' }
  }

  private async windows(id: AiApplicationId): Promise<ApplicationTarget> {
    if (id === 'codex') {
      // Discover the launch ID from the installed official package, never accept an ID from the renderer.
      const output = await this.read('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; $p=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if($p){$m=Get-AppxPackageManifest -Package $p.PackageFullName; $a=@($m.Package.Applications.Application)[0]; [pscustomobject]@{Family=$p.PackageFamilyName; AppId=$a.Id; Version=$p.Version.ToString()} | ConvertTo-Json -Compress}"])
      if (!output) return { id, state: 'missing', version: '' }
      const value = JSON.parse(output) as { Family: string; AppId: string; Version: string }
      if (!/^OpenAI\.Codex_[a-z0-9]{13}$/i.test(value.Family) || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.AppId) || typeof value.Version !== 'string') throw new Error('AI_IDENTITY_INVALID')
      return { id, state: 'installed', version: value.Version, storeId: `${value.Family}!${value.AppId}` }
    }
    const root = join(this.home, '.hermes', 'hermes-agent', 'apps', 'desktop', 'release')
    for (const directory of ['win-unpacked', 'win-arm64-unpacked']) {
      const path = join(root, directory, 'Hermes.exe')
      if (!await exists(path)) continue
      // A fixed path and an exact product name distinguish the desktop from its setup program.
      const escaped = path.replace(/'/g, "''")
      const info = JSON.parse(await this.read('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; (Get-Item -LiteralPath '${escaped}').VersionInfo | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress`])) as { ProductName: string; ProductVersion: string }
      if (info.ProductName === 'Hermes') return { id, state: 'installed', version: info.ProductVersion ?? '', path }
    }
    return { id, state: 'missing', version: '' }
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
