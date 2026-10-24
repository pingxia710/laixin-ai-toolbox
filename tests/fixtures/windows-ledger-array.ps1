param([Parameter(Mandatory=$true)][string]$HelperFunction, [Parameter(Mandatory=$true)][string]$UninstallScript, [Parameter(Mandatory=$true)][string]$Result)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('Laixin ledger ' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
$helper = (Resolve-Path $HelperFunction).Path
$uninstall = (Resolve-Path $UninstallScript).Path
$intent = @{ id = 'intent-1'; kind = 'intent'; intent = 'user-disconnected'; time = 1 }
$server = @{ id = 'server'; kind = 'setting'; service = 'WinINET'; item = 'ProxyServer'; sessionToken = 'session'; time = 2; status = 'restored'; note = ''; originalValue = $null; writtenValue = @{ type = 'REG_SZ'; data = '127.0.0.1:18080' } }
$enable = @{ id = 'enable'; kind = 'setting'; service = 'WinINET'; item = 'ProxyEnable'; sessionToken = 'session'; time = 3; status = 'restored'; note = ''; originalValue = @{ type = 'REG_DWORD'; data = '0' }; writtenValue = @{ type = 'REG_DWORD'; data = '1' } }
$pendingServer = $server.Clone(); $pendingServer.status = 'applied'
$pendingEnable = $enable.Clone(); $pendingEnable.status = 'applied'
$terminal = $server.Clone(); $terminal.service = 'TerminalEnvironment'; $terminal.status = 'applied'
$invalid = $server.Clone(); $invalid.Remove('note')
$otherSession = $pendingEnable.Clone(); $otherSession.sessionToken = 'other-session'
$cases = @(
  @{ name = 'single-intent-disabled'; ledger = @($intent); code = 0 },
  @{ name = 'multiple-restored-disabled'; ledger = @($intent,$server,$enable); code = 0 },
  @{ name = 'multiple-restored-other-proxy'; ledger = @($intent,$server,$enable); enabled = 1; proxy = 'proxy.example:8080'; code = 0 },
  @{ name = 'empty'; ledger = @(); code = 3 },
  @{ name = 'malformed'; raw = '[broken'; code = 3 },
  @{ name = 'missing-note'; ledger = @($intent,$invalid); code = 3 },
  @{ name = 'pending-terminal'; ledger = @($intent,$terminal); code = 3 },
  @{ name = 'pending-with-disabled-proxy'; ledger = @($intent,$pendingServer,$pendingEnable); code = 3 },
  @{ name = 'owned-orphan-proxy'; ledger = @($intent,$pendingServer,$pendingEnable); enabled = 1; proxy = '127.0.0.1:18080'; code = 0; disable = $true },
  @{ name = 'different-session'; ledger = @($intent,$pendingServer,$otherSession); enabled = 1; proxy = '127.0.0.1:18080'; code = 3 },
  @{ name = 'unknown-loopback'; ledger = @($intent,$server,$enable); enabled = 1; proxy = '127.0.0.1:18080'; code = 3 },
  @{ name = 'recovery-required'; ledger = @($intent,$server,$enable); required = $true; code = 3 },
  @{ name = 'owned-proxy-live-listener'; ledger = @($intent,$pendingServer,$pendingEnable); enabled = 1; proxy = '127.0.0.1:18080'; listener = '127.0.0.1'; code = 3 }
)
$runner = Join-Path $root 'runner.ps1'
$runnerText = @'
param([string]$Config)
$ErrorActionPreference = 'Stop'
$c = ConvertFrom-Json ([IO.File]::ReadAllText($Config))
$global:fixtureSettings = [pscustomobject]@{ ProxyEnable = $c.enabled; ProxyServer = $c.proxy }
function Get-ItemProperty { param($LiteralPath,$ErrorAction); return $global:fixtureSettings }
function Set-ItemProperty { param($LiteralPath,$Name,$Type,$Value,$ErrorAction); if($Name -ne 'ProxyEnable' -or $Value -ne 0){throw 'UNEXPECTED_WRITE'}; $global:fixtureSettings.ProxyEnable = $Value; Write-Output 'FIXTURE_PROXY_DISABLED' }
function Get-NetTCPConnection { param($State,$ErrorAction); if($c.listener){[pscustomobject]@{LocalAddress=$c.listener;LocalPort=18080}} }
if ($c.source -eq 'helper') {
  . $c.path
  try { $disabled = Test-LaixinProxyFallback $c.directory $global:fixtureSettings; if($disabled){Write-Output 'FIXTURE_PROXY_DISABLED'}; exit 0 } catch { exit 3 }
}
Add-Type 'public static class LaixinUninstallWinInet { public static bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l) { return true; } }'
function Add-Type { param($TypeDefinition); if($TypeDefinition -notlike '*class LaixinUninstallWinInet*'){throw 'UNEXPECTED_TYPE'} }
& ([scriptblock]::Create([IO.File]::ReadAllText($c.path,[Text.Encoding]::UTF8))) -ProxyFallbackOnly -TunnelDataDir $c.directory
exit $LASTEXITCODE
'@
[IO.File]::WriteAllText($runner,$runnerText,(New-Object Text.UTF8Encoding($true)))
$results = @()
foreach ($case in $cases) {
  $directory = Join-Path $root $case.name
  New-Item -ItemType Directory -Path $directory | Out-Null
  $raw = $(if ($case.raw) { $case.raw } else { ConvertTo-Json -InputObject $case.ledger -Depth 5 })
  [IO.File]::WriteAllText((Join-Path $directory 'ledger.json'),$raw,(New-Object Text.UTF8Encoding($false)))
  if($case.required){[IO.File]::WriteAllText((Join-Path $directory 'ledger-recovery-required'),'required')}
  foreach ($source in @('helper','uninstall')) {
    $config = Join-Path $directory "$source.json"
    $value = @{source=$source;path=$(if($source -eq 'helper'){$helper}else{$uninstall});directory=$directory;enabled=[int]$case.enabled;proxy=$case.proxy;listener=$case.listener} | ConvertTo-Json
    [IO.File]::WriteAllText($config,$value,(New-Object Text.UTF8Encoding($false)))
    $output = & "$PSHOME\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Config $config 2>&1
    $code = $LASTEXITCODE
    $disabled = [string]$output -match 'FIXTURE_PROXY_DISABLED'
    $results += [ordered]@{ source = $source; case = $case.name; exitCode = $code; disabled = $disabled; passed = ($code -eq $case.code -and $disabled -eq [bool]$case.disable) }
  }
}
$results | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8
$results | ConvertTo-Json
if (@($results | Where-Object {-not $_.passed}).Count -gt 0) {exit 1}
