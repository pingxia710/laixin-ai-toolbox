param([Parameter(Mandatory=$true)][string]$Probe)
$ErrorActionPreference = 'Stop'
$probePath = (Resolve-Path -LiteralPath $Probe).Path
$root = Split-Path -Parent $probePath
$target = Join-Path $root 'case-target'
$registered = Join-Path $root 'registered-target'
$base = 'HKCU:\Software\LaixinInstallerInitTest'
if ((Test-Path -LiteralPath $base) -or (Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $registered)) { throw 'PROBE_STATE_NOT_EMPTY' }
if ($env:LAIXIN_PREFLIGHT_HANDOFF_TARGET) { throw 'PROBE_HANDOFF_NOT_EMPTY' }
$cases = @(
  @{ name = 'fresh'; expected = 0 },
  @{ name = 'orphan-location'; expected = 0; location = $registered },
  @{ name = 'orphan-location-empty-target-dir'; expected = 0; location = $registered; targetDir = $true },
  @{ name = 'existing-exe-with-orphan-location'; expected = 1; location = $registered; exe = $true; evidence = 'TARGET_EXE' },
  @{ name = 'existing-registered-dir-without-exe'; expected = 1; location = $registered; registeredDir = $true; evidence = 'REGISTERED_DIRECTORY' },
  @{ name = 'current-uninstall-registration'; expected = 1; uninstall = 'Uninstall'; evidence = 'UNINSTALL_ENTRY' },
  @{ name = 'legacy-uninstall-registration'; expected = 1; uninstall = 'LegacyUninstall'; evidence = 'LEGACY_UNINSTALL_ENTRY' },
  @{ name = 'uninstall-registration-with-orphan-location'; expected = 1; uninstall = 'Uninstall'; location = $registered; evidence = 'UNINSTALL_ENTRY' }
)
$results = @()
try {
  foreach ($case in $cases) {
    try {
      if ($case.location) {
        New-Item -Path "$base\Install" -Force | Out-Null
        New-ItemProperty -Path "$base\Install" -Name InstallLocation -Value $case.location -PropertyType String | Out-Null
      }
      if ($case.registeredDir) { New-Item -ItemType Directory -Path $registered | Out-Null }
      if ($case.targetDir -or $case.exe) { New-Item -ItemType Directory -Path $target | Out-Null }
      if ($case.exe) { Set-Content -LiteralPath "$target\probe.exe" -Value 'existence sentinel' }
      if ($case.uninstall) {
        New-Item -Path "$base\$($case.uninstall)" -Force | Out-Null
        New-ItemProperty -Path "$base\$($case.uninstall)" -Name UninstallString -Value '"missing-uninstaller.exe"' -PropertyType String | Out-Null
      }
      $log = "$env:APPDATA\LaixinInstallerInitTest\updates\windows-preflight-last-error.log"
      $beforeLog = $(if (Test-Path -LiteralPath $log) { [IO.File]::ReadAllText($log) } else { '' })
      $p = Start-Process -FilePath $probePath -ArgumentList '/S' -PassThru
      if (-not $p.WaitForExit(15000)) { throw 'PROBE_TIMEOUT' }
      $p.Refresh()
      $afterLog = $(if (Test-Path -LiteralPath $log) { [IO.File]::ReadAllText($log) } else { '' })
      $logPassed = $(if ($case.evidence) {
        $afterLog.StartsWith($beforeLog) -and $afterLog.Substring($beforeLog.Length).Contains("INSTALLER_HANDOFF_REQUIRED STAGE=CUSTOM_INIT EXIT_CODE=1 EVIDENCE=|$($case.evidence)")
      } else { $afterLog -eq $beforeLog })
      $results += [ordered]@{ name = $case.name; expected = $case.expected; actual = $p.ExitCode; logPassed = $logPassed; passed = ($p.ExitCode -eq $case.expected -and $logPassed) }
    } finally {
      if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      if (Test-Path -LiteralPath $registered) { Remove-Item -LiteralPath $registered -Recurse -Force }
    }
  }
} finally {
  $results | ConvertTo-Json | Set-Content -LiteralPath "$probePath.results.json" -Encoding UTF8
  $results | ConvertTo-Json
}
if (@($results | Where-Object { -not $_.passed }).Count -gt 0) { exit 1 }
