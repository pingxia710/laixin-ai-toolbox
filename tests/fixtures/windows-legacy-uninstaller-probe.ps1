param(
  [Parameter(Mandatory=$true)][string]$Probe,
  [Parameter(Mandatory=$true)][string]$Stub,
  [Parameter(Mandatory=$true)][string]$InstalledDir,
  [Parameter(Mandatory=$true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($WorkDir)
$allowed = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LaixinAcceptance')) + '\'
if (-not $root.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'UNSAFE_FIXTURE_DIRECTORY' }
if (Test-Path -LiteralPath $root) { throw 'FIXTURE_DIRECTORY_ALREADY_EXISTS' }
$target = Join-Path $root 'target'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$appName = '来信AI工具箱统一版.exe'
$uninstallName = 'Uninstall 来信AI工具箱统一版.exe'
$sourceApp = Join-Path $InstalledDir $appName
$sourceUninstaller = Join-Path $InstalledDir $uninstallName
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceUninstaller).Hash
if ($sourceHash -ne '16B7E44083BEA50DFC90E8B0BE5498F163E785C04BC87F6293E1A260C5BC2E8E') { throw 'UNEXPECTED_SOURCE_UNINSTALLER' }
if (-not (Test-Path -LiteralPath $sourceApp)) { throw 'SOURCE_APP_MISSING' }
Get-ChildItem -LiteralPath $InstalledDir -File | Copy-Item -Destination $target
$targetUninstaller = Join-Path $target $uninstallName
$probeCopy = Join-Path $root 'probe.exe'
Copy-Item -LiteralPath $Probe -Destination $probeCopy
$expectedStubHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Stub).Hash
$resultPath = Join-Path $root 'result.ini'
$selectedPath = Join-Path $root 'selected.exe'
$cases = @(
  @{name='known'; registered=$target; uninstaller=$targetUninstaller; selected='compatible'},
  @{name='case-insensitive'; registered=$target.ToUpperInvariant(); uninstaller=$targetUninstaller; selected='compatible'},
  @{name='different-directory'; registered=(Join-Path $root 'other'); uninstaller=$targetUninstaller; selected='original'},
  @{name='different-uninstaller'; registered=$target; uninstaller=(Join-Path $root 'other.exe'); selected='original'},
  @{name='modified-uninstaller'; registered=$target; uninstaller=$targetUninstaller; selected='original'},
  @{name='missing-uninstaller'; registered=$target; uninstaller=$targetUninstaller; selected='original'},
  @{name='missing-app'; registered=$target; uninstaller=$targetUninstaller; selected='original'}
)
$results = @()
foreach ($case in $cases) {
  if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
  if (Test-Path -LiteralPath $selectedPath) { Remove-Item -LiteralPath $selectedPath }
  Copy-Item -LiteralPath $sourceUninstaller -Destination $targetUninstaller -Force
  if ($case.name -eq 'modified-uninstaller') {
    $stream = [IO.File]::Open($targetUninstaller, [IO.FileMode]::Append, [IO.FileAccess]::Write)
    try { $stream.WriteByte(1) } finally { $stream.Dispose() }
  }
  if ($case.name -eq 'missing-uninstaller') { Remove-Item -LiteralPath $targetUninstaller }
  $app = Join-Path $target $appName
  $renamedApp = Join-Path $target 'fixture-app-disabled.exe'
  if ($case.name -eq 'missing-app') { Move-Item -LiteralPath $app -Destination $renamedApp }
  $ini = "[case]`r`ntarget=$target`r`nregistered=$($case.registered)`r`nuninstaller=$($case.uninstaller)`r`n"
  [IO.File]::WriteAllText((Join-Path $root 'case.ini'), $ini, [Text.Encoding]::Unicode)
  $process = Start-Process -FilePath $probeCopy -PassThru -Wait
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) { throw "PROBE_FAILED:$($case.name)" }
  $result = Get-Content -LiteralPath $resultPath -Raw
  if ($result -notmatch "(?m)^selected=$($case.selected)\s*$" -or
      $result -notmatch '(?m)^seven=saved-seven\s*$' -or $result -notmatch '(?m)^eight=saved-eight\s*$' -or
      $result -notmatch '(?m)^environment=previous\s*$') { throw "UNEXPECTED_PROBE_RESULT:$($case.name):$result" }
  if ($case.selected -eq 'compatible' -and
      (Get-FileHash -Algorithm SHA256 -LiteralPath $selectedPath).Hash -ne $expectedStubHash) { throw 'WRONG_SELECTED_UNINSTALLER' }
  $results += [pscustomobject]@{ case=$case.name; selected=$case.selected; passed=$true }
  if ($case.name -eq 'missing-app') { Move-Item -LiteralPath $renamedApp -Destination $app }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceUninstaller).Hash -ne $sourceHash) { throw 'SOURCE_MODIFIED' }
[pscustomobject]@{ cases=$results; originalUninstallerUnchanged=$true } | ConvertTo-Json -Depth 4 -Compress
