param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Guard,[Parameter(Mandatory=$true)][string]$NodeHost,[Parameter(Mandatory=$true)][string]$Worker,[Parameter(Mandatory=$true)][string]$Result)
$ErrorActionPreference='Stop'
$root=Join-Path $env:TEMP ('LaixinGuardLifetime-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$rows=@()
$saved=$env:ELECTRON_RUN_AS_NODE
$utf8=New-Object Text.UTF8Encoding($false)
try {
 foreach($order in @('worker-first','owner-first')) {
  $directory=Join-Path $root $order
  New-Item -ItemType Directory -Path $directory | Out-Null
  $owner=$null;$workerProcess=$null;$guardProcess=$null
  try {
   $owner=Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"' -PassThru -WindowStyle Hidden
   $ownerHandle=$owner.Handle
   $identity=Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Id)"
   $launcher=Join-Path $directory 'consumer.ps1'
   [IO.File]::WriteAllText($launcher,'param([switch]$Reboot,[string]$Transaction);[IO.File]::WriteAllText((Join-Path $PSScriptRoot "consumed"),$Transaction)',$utf8)
   $spec=@{guardSourcePath=$Guard;guardPath=(Join-Path $directory 'windows-preflight-recovery-guard.exe');guardErrorPath=(Join-Path $directory 'error');guardStartPath=(Join-Path $directory 'started');readyPath=(Join-Path $directory 'ready');launcherPath=$launcher;powershell="$PSHOME\powershell.exe";transactionId=[Guid]::NewGuid().ToString();ownerPid=$owner.Id;ownerExecutable=$identity.ExecutablePath;ownerStarted=$identity.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();workerReady=(Join-Path $directory 'worker-ready.json');workerWait=($order -eq 'owner-first');workerRelease=(Join-Path $directory 'release')}
   $specPath=Join-Path $directory 'spec.json'
   [IO.File]::WriteAllText($specPath,($spec | ConvertTo-Json),$utf8)
   $env:ELECTRON_RUN_AS_NODE='1'
   $workerProcess=Start-Process -FilePath $NodeHost -ArgumentList @(('"'+$Worker+'"'),('"'+$Helper+'"'),('"'+$specPath+'"')) -PassThru -WindowStyle Hidden
   $workerHandle=$workerProcess.Handle
   $deadline=(Get-Date).AddSeconds(20)
   while(-not (Test-Path $spec.workerReady) -and (Get-Date) -lt $deadline -and -not $workerProcess.HasExited){Start-Sleep -Milliseconds 25}
   if(-not (Test-Path $spec.workerReady)){throw 'WORKER_NOT_READY'}
   $ready=[IO.File]::ReadAllText($spec.workerReady) | ConvertFrom-Json
   $guardProcess=Get-Process -Id $ready.guardPid -ErrorAction SilentlyContinue
   if($null -ne $guardProcess){$guardHandle=$guardProcess.Handle}
   if($order -eq 'worker-first') { if(-not $workerProcess.WaitForExit(5000)){throw 'WORKER_DID_NOT_EXIT'} }
   else { $owner.Kill();[void]$owner.WaitForExit(3000) }
   Start-Sleep -Milliseconds 300
   $survivedFirst=($null -ne $guardProcess -and -not $guardProcess.HasExited -and -not (Test-Path (Join-Path $directory 'consumed')))
   if($order -eq 'worker-first') { $owner.Kill();[void]$owner.WaitForExit(3000) }
   else { [IO.File]::WriteAllText($spec.workerRelease,'release',$utf8);if(-not $workerProcess.WaitForExit(5000)){throw 'WORKER_DID_NOT_EXIT'} }
   $consumed=$false
   if($null -ne $guardProcess){[void]$guardProcess.WaitForExit(10000)}
   $consumerPath=Join-Path $directory 'consumed'
   if(Test-Path $consumerPath){$consumed=([IO.File]::ReadAllText($consumerPath) -eq $spec.transactionId)}
   $rows += [ordered]@{order=$order;survivedFirstExit=$survivedFirst;consumedAfterBoth=$consumed;passed=($survivedFirst -and $consumed)}
  } finally {
   foreach($owned in @($workerProcess,$owner,$guardProcess)){if($null -ne $owned -and -not $owned.HasExited){$owned.Kill();[void]$owned.WaitForExit(3000)}}
  }
 }
} finally {
 $env:ELECTRON_RUN_AS_NODE=$saved
 [IO.File]::WriteAllText($Result,($rows | ConvertTo-Json),$utf8)
}
$rows | ConvertTo-Json
if(@($rows | Where-Object {-not $_.passed}).Count -gt 0){exit 1}
