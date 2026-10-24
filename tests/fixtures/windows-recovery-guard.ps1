param([Parameter(Mandatory=$true)][string]$Guard)
$ErrorActionPreference = 'Stop'
$guardPath = (Resolve-Path -LiteralPath $Guard).Path
$root = Join-Path $env:TEMP ("Laixin guard 复测 " + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
$owner = $null
$worker = $null
$children = @()
$results = @()
$names = @('TRANSACTION','ERROR_PATH','STARTED_PATH','READY_PATH','OWNER_PID','OWNER_PATH','OWNER_STARTED','WORKER_PID','WORKER_PATH','WORKER_STARTED','POWERSHELL','LAUNCHER')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable("LAIXIN_RECOVERY_GUARD_$name") }
try {
  $arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"'
  $owner = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -PassThru
  $worker = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -PassThru
  $ownerState = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Id)"
  $workerState = Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.Id)"
  $ownerStart = $ownerState.CreationDate.ToUniversalTime().ToFileTimeUtc()
  $workerStart = $workerState.CreationDate.ToUniversalTime().ToFileTimeUtc()
  $cases = @(
    @{ name = 'valid'; ready = $true },
    @{ name = 'case-insensitive-owner-and-worker'; ready = $true; uppercase = $true },
    @{ name = 'wrong-owner-path'; error = 'UPDATE_RECOVERY_GUARD_PROCESS_PATH_MISMATCH'; ownerPath = 'C:\missing-owner.exe' },
    @{ name = 'wrong-worker-path'; error = 'UPDATE_RECOVERY_GUARD_PROCESS_PATH_MISMATCH'; workerPath = 'C:\missing-worker.exe' },
    @{ name = 'wrong-owner-start'; error = 'UPDATE_RECOVERY_GUARD_PROCESS_START_TIME_MISMATCH'; ownerOffset = 1000 },
    @{ name = 'wrong-worker-start'; error = 'UPDATE_RECOVERY_GUARD_PROCESS_START_TIME_MISMATCH'; workerOffset = 1000 }
  )
  foreach ($case in $cases) {
    $directory = Join-Path $root $case.name
    New-Item -ItemType Directory -Path $directory | Out-Null
    $launcher = Join-Path $directory 'consumer.ps1'
    [IO.File]::WriteAllText($launcher, 'param([switch]$Reboot,[string]$Transaction); [IO.File]::WriteAllText((Join-Path $PSScriptRoot "consumed.txt"),$Transaction); exit 0', (New-Object Text.UTF8Encoding($true)))
    $transaction = [Guid]::NewGuid().ToString()
    $errorPath = Join-Path $directory 'error.txt'
    $readyPath = Join-Path $directory 'ready.txt'
    $values = @{
      TRANSACTION = $transaction; ERROR_PATH = $errorPath; STARTED_PATH = (Join-Path $directory 'started.txt'); READY_PATH = $readyPath
      OWNER_PID = "$($owner.Id)"; OWNER_PATH = $(if ($case.ownerPath) { $case.ownerPath } elseif ($case.uppercase) { $ownerState.ExecutablePath.ToUpperInvariant() } else { $ownerState.ExecutablePath })
      OWNER_STARTED = ($ownerStart + [long]$case.ownerOffset).ToString()
      WORKER_PID = "$($worker.Id)"; WORKER_PATH = $(if ($case.workerPath) { $case.workerPath } elseif ($case.uppercase) { $workerState.ExecutablePath.ToUpperInvariant() } else { $workerState.ExecutablePath })
      WORKER_STARTED = ($workerStart + [long]$case.workerOffset).ToString()
      POWERSHELL = "$PSHOME\powershell.exe"; LAUNCHER = $launcher
    }
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable("LAIXIN_RECOVERY_GUARD_$name",$values[$name]) }
    $p = Start-Process -FilePath $guardPath -ArgumentList @('--laixin-recovery-guard',$transaction) -PassThru
    $children += @{ process = $p; directory = $directory; transaction = $transaction; readyExpected = [bool]$case.ready }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      if ((Test-Path -LiteralPath $readyPath) -or (Test-Path -LiteralPath $errorPath)) { break }
      $p.Refresh()
      if ($p.HasExited) { break }
      Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    $seenReady = $(if (Test-Path -LiteralPath $readyPath) { [IO.File]::ReadAllText($readyPath).Trim() -eq "$transaction`:$($p.Id)" } else { $false })
    $seenError = $(if (Test-Path -LiteralPath $errorPath) { [IO.File]::ReadAllText($errorPath).Trim() } else { '' })
    $passed = $(if ($case.ready) { $seenReady -and $seenError -eq '' } else { -not $seenReady -and $seenError -eq $case.error })
    $results += [ordered]@{ name = $case.name; ready = $seenReady; error = $seenError; passed = $passed }
  }
  Stop-Process -Id $owner.Id -Force
  [void]$owner.WaitForExit(3000)
  Start-Sleep -Milliseconds 250
  foreach ($child in @($children | Where-Object { $_.readyExpected })) {
    $child.process.Refresh()
    $results += [ordered]@{ name = "waits-for-worker-$($child.transaction)"; passed = (-not $child.process.HasExited) }
  }
  Stop-Process -Id $worker.Id -Force
  [void]$worker.WaitForExit(3000)
  foreach ($child in @($children | Where-Object { $_.readyExpected })) {
    $exited = $child.process.WaitForExit(10000)
    $child.process.Refresh()
    $consumed = Join-Path $child.directory 'consumed.txt'
    $passed = $exited -and $child.process.ExitCode -eq 0 -and (Test-Path -LiteralPath $consumed) -and [IO.File]::ReadAllText($consumed) -eq $child.transaction
    $results += [ordered]@{ name = "consumes-after-both-exit-$($child.transaction)"; passed = $passed }
  }
} finally {
  foreach ($child in $children) { $child.process.Refresh(); if (-not $child.process.HasExited) { Stop-Process -Id $child.process.Id -Force } }
  foreach ($process in @($owner,$worker)) { if ($process) { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } } }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable("LAIXIN_RECOVERY_GUARD_$name",$saved[$name]) }
  $results | ConvertTo-Json | Set-Content -LiteralPath "$guardPath.results.json" -Encoding UTF8
  $results | ConvertTo-Json
}
if (@($results | Where-Object { -not $_.passed }).Count -gt 0) { exit 1 }
