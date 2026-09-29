param([switch]$ProxyFallbackOnly, [string]$TunnelDataDir)
$ErrorActionPreference = 'Stop'
[IO.Directory]::SetCurrentDirectory([Environment]::SystemDirectory)

if ($ProxyFallbackOnly) {
  # LAIXIN_UNINSTALL_PROXY_FALLBACK
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $settings = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
  # LAIXIN_PROXY_LEDGER_OWNERSHIP:守护没跑成时只凭完整账本认领，其他未结算设置不能被此开关兜底。
  if ([string]::IsNullOrWhiteSpace($TunnelDataDir)) { exit 3 }
  $ledgerPath = Join-Path $TunnelDataDir 'ledger.json'
  try {
    if (Test-Path -LiteralPath (Join-Path $TunnelDataDir 'ledger-recovery-required') -ErrorAction Stop) { exit 3 }
    $raw = Get-Content -LiteralPath $ledgerPath -Raw -Encoding UTF8 -ErrorAction Stop
    if (-not $raw.TrimStart().StartsWith('[')) { exit 3 }
    $ledger = @(ConvertFrom-Json -InputObject $raw -ErrorAction Stop)
    if ($ledger.Count -eq 0) { exit 3 }
    foreach ($entry in $ledger) {
      if ($null -eq $entry -or [string]::IsNullOrWhiteSpace([string]$entry.id) -or $null -eq $entry.time) { exit 3 }
      if ($entry.kind -eq 'setting') {
        if ([string]::IsNullOrWhiteSpace([string]$entry.service) -or
          [string]::IsNullOrWhiteSpace([string]$entry.item) -or
          [string]::IsNullOrWhiteSpace([string]$entry.sessionToken) -or
          $entry.status -notin @('applied','restored','preserved','kept-modified','restore-failed') -or
          $entry.note -isnot [string] -or
          $entry.PSObject.Properties.Name -notcontains 'originalValue' -or
          $entry.PSObject.Properties.Name -notcontains 'writtenValue') { exit 3 }
      } elseif ($entry.kind -ne 'intent' -or $entry.intent -notin @('connected','user-disconnected','shutdown')) { exit 3 }
    }
    $pending = @($ledger | Where-Object { $_.kind -eq 'setting' -and $_.status -in @('applied','kept-modified','restore-failed') })
    # TerminalEnvironment 等未结算面无法靠关闭 WinINET 开关恢复，必须保留程序与现场。
    if (@($pending | Where-Object { $_.service -eq 'TerminalEnvironment' }).Count -gt 0) { exit 3 }
    if ([int]$settings.ProxyEnable -ne 1) { if ($pending.Count -gt 0) { exit 3 }; exit 0 }
    $endpoint = [regex]::Match([string]$settings.ProxyServer, '^127\.0\.0\.1:([1-9][0-9]{0,4})$')
    if (-not $endpoint.Success) {
      if ($pending.Count -gt 0 -or [string]$settings.ProxyServer -match '(?i)(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?):\d{1,5}') { exit 3 }
      exit 0
    }
    $port = [int]$endpoint.Groups[1].Value
    if ($port -gt 65535 -or $pending.Count -ne 2) { exit 3 }
    $server = @($pending | Where-Object { $_.service -eq 'WinINET' -and $_.item -eq 'ProxyServer' })
    $enable = @($pending | Where-Object { $_.service -eq 'WinINET' -and $_.item -eq 'ProxyEnable' })
    if ($server.Count -ne 1 -or $enable.Count -ne 1) { exit 3 }
    $server = $server[0]
    $enable = $enable[0]
    $owned = $server.sessionToken -ceq $enable.sessionToken -and
      $server.writtenValue.type -ceq 'REG_SZ' -and $server.writtenValue.data -ceq [string]$settings.ProxyServer -and
      $enable.writtenValue.type -ceq 'REG_DWORD' -and [string]$enable.writtenValue.data -ceq '1' -and
      ($null -eq $enable.originalValue -or [string]$enable.originalValue.data -match '^(?:0|0x0+)$')
    if (-not $owned) { exit 3 }
    # WinINET 指向 IPv4 127.0.0.1：::1-only 不占该入口；0.0.0.0 能服务它，:: 等双栈不明须停手。
    # 监听查询失败也不能当作空端口。
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port })
    if (@($listeners | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') -or
      $_.LocalAddress -eq '::' -or ([string]$_.LocalAddress -like '*:*' -and $_.LocalAddress -ne '::1') }).Count -gt 0) { exit 3 }
  } catch { exit 3 }
  $mustDisable = $true
  if ($mustDisable) {
    Set-ItemProperty -LiteralPath $key -Name ProxyEnable -Type DWord -Value 0 -ErrorAction Stop
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinUninstallWinInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'
    [void][LaixinUninstallWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    [void][LaixinUninstallWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
  }
  $after = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
  if ($mustDisable -and [int]$after.ProxyEnable -ne 0) { exit 2 }
  exit 0
}

$label = 'cn.laixin.toolbox.tunnel'
$isLaixinTask = {
  $_.TaskName -eq $label -and ($_.TaskPath -eq '\' -or $_.TaskPath -eq '\Laixin\')
}

$matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object $isLaixinTask)
foreach ($task in $matches) {
  Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
}

$left = @(Get-ScheduledTask -ErrorAction Stop | Where-Object $isLaixinTask)
if ($left.Count -ne 0) { exit 1 }
exit 0
