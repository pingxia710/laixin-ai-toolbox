param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$NodeHost,[Parameter(Mandatory=$true)][string]$Probe,[Parameter(Mandatory=$true)][string]$Result)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('LaixinStopTest-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
$savedNode = $env:ELECTRON_RUN_AS_NODE
$results = @()
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  foreach($case in @('exited-handle','live-correct','wrong-path','wrong-start')) {
    $child = Start-Process "$PSHOME\powershell.exe" -ArgumentList '-NoProfile -Command "Start-Sleep 60"' -PassThru
    try {
      $held = $child.Handle
      $state = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
      $entry = @{pid=$child.Id;path=$state.ExecutablePath;startFileTime=$state.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}
      if($case -eq 'wrong-path'){$entry.path='C:\not-owned.exe'}
      if($case -eq 'wrong-start'){$entry.startFileTime=([long]$entry.startFileTime + 1000).ToString()}
      $entryPath = Join-Path $root "$case.json"
      $encodedPath = Join-Path $root "$case.encoded"
      [IO.File]::WriteAllText($entryPath,($entry | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
      & $NodeHost $Probe $Helper $entryPath $encodedPath 2>&1 | Out-Host
      if($LASTEXITCODE -ne 0){throw 'GENERATOR_FAILED'}
      if($case -eq 'exited-handle'){$child.Kill();[void]$child.WaitForExit(3000)}
      & "$PSHOME\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([IO.File]::ReadAllText($encodedPath)) 2>&1 | Out-Host
      $code = $LASTEXITCODE
      $child.Refresh()
      $expectedExited = $case -in @('exited-handle','live-correct')
      $results += @{name=$case;exitCode=$code;childExited=$child.HasExited;passed=($code -eq 0 -and $child.HasExited -eq $expectedExited)}
    } finally {
      $child.Refresh()
      if(-not $child.HasExited){$child.Kill();[void]$child.WaitForExit(3000)}
      $child.Dispose()
    }
  }
} finally {$env:ELECTRON_RUN_AS_NODE=$savedNode}
$results | ConvertTo-Json | Set-Content $Result -Encoding UTF8
$results | ConvertTo-Json
if(@($results | Where-Object {-not $_.passed}).Count -gt 0){exit 1}
