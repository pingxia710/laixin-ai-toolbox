param([Parameter(Mandatory=$true)][string]$Helper, [Parameter(Mandatory=$true)][string]$NodeHost, [Parameter(Mandatory=$true)][string]$Probe, [Parameter(Mandatory=$true)][string]$Result)
$ErrorActionPreference = 'Stop'
$taskName = 'LaixinXmlTest-' + [Guid]::NewGuid().ToString()
$directory = Join-Path $env:TEMP $taskName
New-Item -ItemType Directory -Path $directory | Out-Null
$registered = $false
$savedNode = $env:ELECTRON_RUN_AS_NODE
try {
  $action = New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument '-NoProfile -Command "Write-Output 中文任务路径"' -WorkingDirectory $directory
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Principal $principal | Out-Null
  $registered = $true
  Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
  $expected = Join-Path $directory 'expected.xml'
  [IO.File]::WriteAllText($expected,(Export-ScheduledTask -TaskName $taskName -TaskPath '\'),(New-Object Text.UTF8Encoding($false)))
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $NodeHost $Probe $Helper $taskName $expected $Result 2>&1 | Out-Host
  $code = $LASTEXITCODE
} finally {
  if ($registered) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
  $env:ELECTRON_RUN_AS_NODE = $savedNode
}
exit $code
