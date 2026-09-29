import { execFile as execFileCallback } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

type ReadCommand = (command: string, args: string[]) => Promise<string>
const execFile = promisify(execFileCallback)
const readCommand: ReadCommand = async (command, args) => (await execFile(command, args, {
  encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true
})).stdout.trim()

export interface WindowsCodexPackage {
  readonly storeId: string
  readonly version: string
  readonly cliCandidates: readonly string[]
}

/** Shared by the application launcher and CLI discovery; only Windows' registered official package is queried. */
export async function readWindowsCodexPackage(read: ReadCommand = readCommand, env: NodeJS.ProcessEnv = process.env): Promise<WindowsCodexPackage | undefined> {
  const configuredRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.systemroot ?? 'C:\\Windows'
  const systemRoot = /^[A-Za-z]:[\\/]/.test(configuredRoot) && !/[\0\r\n]/.test(configuredRoot) &&
    !configuredRoot.split(/[\\/]/).some(part => part === '..' || part === '.') ? configuredRoot : 'C:\\Windows'
  const output = await read(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $p=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if($p){$m=Get-AppxPackageManifest -Package $p.PackageFullName; $a=@($m.Package.Applications.Application)[0]; [pscustomobject]@{Family=$p.PackageFamilyName; AppId=$a.Id; Version=$p.Version.ToString(); InstallLocation=$p.InstallLocation; Executable=$a.Executable} | ConvertTo-Json -Compress}"])
  if (!output.trim()) return undefined
  const parsed: unknown = JSON.parse(output)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('AI_IDENTITY_INVALID')
  const value = parsed as Record<string, unknown>
  if (value.Family !== 'OpenAI.Codex_2p2nqsd0c76g0' || typeof value.AppId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(value.AppId) || typeof value.Version !== 'string') throw new Error('AI_IDENTITY_INVALID')
  return { storeId: `${value.Family}!${value.AppId}`, version: value.Version, cliCandidates: packageCliCandidates(value) }
}

function packageCliCandidates(value: Record<string, unknown>): readonly string[] {
  if (typeof value.InstallLocation !== 'string' || typeof value.Executable !== 'string') return []
  const root = value.InstallLocation
  const application = value.Executable
  if (!/^[A-Za-z]:[\\/]/.test(root) || /[\0\r\n]/.test(root) || root.split(/[\\/]/).includes('..') ||
    !/^OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_(?:x64|arm64|x86)__2p2nqsd0c76g0$/i.test(win32.basename(root)) ||
    win32.isAbsolute(application) || application.split(/[\\/]/).some(part => !/^[A-Za-z0-9 _.-]+$/.test(part) || part === '..' || part === '.') ||
    win32.basename(application).toLowerCase() !== 'codex.exe') return []
  // The manifest points at the Electron application, not the native app-server CLI beside it.
  return [win32.join(root, win32.dirname(application), 'resources', 'codex.exe')]
}
