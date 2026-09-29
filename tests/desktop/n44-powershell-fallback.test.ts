import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { appendSettingEntry } from '../../sidecar/win/ledger.mjs'

const requireFromTest = createRequire(import.meta.url)
const helper = requireFromTest('../../resources/update-helper.cjs') as { proxyFallbackScript(tunnelDataDir: string): string }
const uninstall = fileURLToPath(new URL('../../resources/uninstall-task-cleanup.ps1', import.meta.url))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const mockCommands = String.raw`
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'using System; public static class LaixinUninstallWinInet { public static bool InternetSetOption(IntPtr h,int o,IntPtr b,int l) { return true; } } public static class LaixinWinInet { public static bool InternetSetOption(IntPtr h,int o,IntPtr b,int l) { return true; } }'
function Add-Type { param([string]$TypeDefinition) }
function Get-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath)
  Get-Content -LiteralPath $env:N44_REGISTRY_FILE -Raw | ConvertFrom-Json
}
function Set-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath,[string]$Name,[string]$Type,[int]$Value)
  $current=Get-Content -LiteralPath $env:N44_REGISTRY_FILE -Raw | ConvertFrom-Json
  $current.$Name=$Value
  $current | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $env:N44_REGISTRY_FILE
}
function Get-NetTCPConnection {
  [CmdletBinding()] param([string]$State)
  if($env:N44_LISTENER_PORT){[pscustomobject]@{LocalPort=[int]$env:N44_LISTENER_PORT;LocalAddress=$env:N44_LISTENER_ADDRESS}}
}
`

function runFallback(kind: 'uninstall' | 'update', options: {
  ledger?: 'owned' | 'other-session' | 'missing-session' | 'settled' | 'bad-entry'
  live?: boolean
  listenerAddress?: '127.0.0.1' | '0.0.0.0' | '::1' | '::'
  proxyServer?: string
  proxyEnable?: number
  pendingTerminal?: boolean
  recoveryMarker?: boolean
}) {
  const root = mkdtempSync(join(tmpdir(), 'n44-powershell-'))
  roots.push(root)
  const port = 51234
  const server = `127.0.0.1:${port}`
  const registryPath = join(root, 'registry.json')
  writeFileSync(registryPath, JSON.stringify({ ProxyEnable: options.proxyEnable ?? 1,
    ProxyServer: options.proxyServer ?? server }))
  if (options.ledger) {
    appendSettingEntry(root, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { type: 'REG_SZ', data: server }, sessionToken: 'n44', time: 1 })
    appendSettingEntry(root, { service: 'WinINET', item: 'ProxyEnable', originalValue: { type: 'REG_DWORD', data: '0' },
      writtenValue: { type: 'REG_DWORD', data: '1' }, sessionToken: 'n44', time: 2 })
    if (options.pendingTerminal) {
      appendSettingEntry(root, { service: 'TerminalEnvironment', item: 'HTTP_PROXY', originalValue: null,
        writtenValue: { value: server }, sessionToken: 'n44', time: 3 })
    }
    if (options.ledger !== 'owned') {
      const path = join(root, 'ledger.json')
      const entries = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
      if (options.ledger === 'other-session') entries[1].sessionToken = 'other'
      else if (options.ledger === 'missing-session') entries.forEach((entry) => { entry.sessionToken = '' })
      else if (options.ledger === 'settled') entries[1].status = 'restored'
      else entries.push({ corrupted: true })
      writeFileSync(path, JSON.stringify(entries))
    }
  }
  if (options.recoveryMarker) writeFileSync(join(root, 'ledger-recovery-required'), 'bad-ledger\n')
  const script = kind === 'uninstall' ? uninstall : join(root, 'update-fallback.ps1')
  if (kind === 'update') writeFileSync(script, helper.proxyFallbackScript(root))
  const wrapper = join(root, 'wrapper.ps1')
  const invoke = kind === 'uninstall'
    ? `& ${quote(script)} -ProxyFallbackOnly -TunnelDataDir ${quote(root)}`
    : `& ${quote(script)}`
  writeFileSync(wrapper, `${mockCommands}\n${invoke}\n`)
  const processResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, N44_REGISTRY_FILE: registryPath,
      N44_LISTENER_PORT: options.live ? String(port) : '',
      N44_LISTENER_ADDRESS: options.listenerAddress ?? '127.0.0.1' }
  })
  return { status: processResult.status, stderr: processResult.stderr,
    registry: JSON.parse(readFileSync(registryPath, 'utf8')) as { ProxyEnable: number; ProxyServer: string } }
}

describe.skipIf(process.platform !== 'win32')('N-44 Windows PowerShell 兜底隔离执行', () => {
  it.each(['uninstall', 'update'] as const)('%s：同会话账本认领随机死端口时只关闭来信开关', (kind) => {
    const result = runFallback(kind, { ledger: 'owned' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.registry).toEqual({ ProxyEnable: 0, ProxyServer: '127.0.0.1:51234' })
  })

  it.each(['uninstall', 'update'] as const)('%s：空账本、异会话或已结算时保留第三方代理', (kind) => {
    for (const ledger of [undefined, 'other-session', 'missing-session', 'settled', 'bad-entry'] as const) {
      const result = runFallback(kind, { ledger })
      expect(result.status).not.toBe(0)
      expect(result.registry.ProxyEnable).toBe(1)
    }
  })

  it.each(['uninstall', 'update'] as const)('%s：同端口已有监听者时保留设置', (kind) => {
    const result = runFallback(kind, { ledger: 'owned', live: true })
    expect(result.status).not.toBe(0)
    expect(result.registry.ProxyEnable).toBe(1)
  })

  it.each(['uninstall', 'update'] as const)('%s：IPv6 专用 ::1 不占 IPv4 死口，IPv4 wildcard 和双栈必须停手', (kind) => {
    const ipv6Only = runFallback(kind, { ledger: 'owned', live: true, listenerAddress: '::1' })
    expect(ipv6Only.status, ipv6Only.stderr).toBe(0)
    expect(ipv6Only.registry.ProxyEnable).toBe(0)
    for (const listenerAddress of ['0.0.0.0', '::'] as const) {
      const result = runFallback(kind, { ledger: 'owned', live: true, listenerAddress })
      expect(result.status).not.toBe(0)
      expect(result.registry.ProxyEnable).toBe(1)
    }
  })

  it.each(['uninstall', 'update'] as const)('%s：非标准本机代理、坏账本或未恢复终端层均不得放行', (kind) => {
    for (const options of [
      { ledger: 'owned', proxyServer: 'localhost:18080' },
      { ledger: 'owned', proxyServer: 'http=127.0.0.1:18080;https=127.0.0.1:18080' },
      { ledger: 'owned', proxyEnable: 0, pendingTerminal: true },
      { ledger: 'owned', recoveryMarker: true }
    ] as const) {
      const result = runFallback(kind, options)
      expect(result.status).not.toBe(0)
    }
  })
})
