import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { unknownLocalEgressEvidence, type LocalEgressEvidence } from '../../shared/local-egress-evidence'

// 只读 Windows API；stdout 仅三个 0/1 位，不能输出网卡、路由或异常原文。
const script = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $adapters = @(Get-NetAdapter -Name * -IncludeHidden -ErrorAction Stop)',
  '  $routes = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop)',
  "  $up = @($adapters | Where-Object { $_.Status -eq 'Up' }).Count -gt 0",
  "  $v4 = @($routes | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' }).Count -gt 0",
  "  $v6 = @($routes | Where-Object { $_.DestinationPrefix -eq '::/0' }).Count -gt 0",
  "  [Console]::Out.WriteLine(('{0}{1}{2}' -f [int]$up, [int]$v4, [int]$v6))",
  '} catch { exit 1 }'
].join('\n')
const command = Buffer.from(script, 'utf16le').toString('base64')

type CommandResult = { readonly stdout: string; readonly stderr: string }
function runWindowsCommand(): Promise<CommandResult> {
  const configuredRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  const systemRoot = /^[A-Za-z]:[\\/]/.test(configuredRoot) && !/[\0\r\n]/.test(configuredRoot) &&
    !configuredRoot.split(/[\\/]/).some(part => part === '..' || part === '.') ? configuredRoot : 'C:\\Windows'
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command],
      { timeout: 2_500, maxBuffer: 256, windowsHide: true }, (error, stdout, stderr) => {
        if (error) { reject(new Error('LOCAL_EGRESS_UNAVAILABLE')); return }
        resolve({ stdout, stderr })
      })
  })
}

export async function collectLocalEgressEvidence(options: {
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly run?: () => Promise<CommandResult>
} = {}): Promise<LocalEgressEvidence> {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  if (platform !== 'win32') return unknownLocalEgressEvidence(platform, now())
  try {
    const result = await (options.run ?? runWindowsCommand)()
    const sampledAt = now()
    // 不保留原始 stdout/stderr；任何额外文本（包括名字、地址或报错）都变成未知。
    if (result.stderr !== '' || !/^[01]{3}\r?\n?$/.test(result.stdout)) return unknownLocalEgressEvidence(platform, sampledAt)
    const [up, v4, v6] = result.stdout
    return { platform: 'windows', sampledAt, interface: up === '1' ? 'up' : 'none',
      ipv4DefaultRoute: v4 === '1' ? 'present' : 'absent', ipv6DefaultRoute: v6 === '1' ? 'present' : 'absent' }
  } catch { return unknownLocalEgressEvidence(platform, now()) }
}
