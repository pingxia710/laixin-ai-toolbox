param([Parameter(Mandatory=$true)][string]$Collector)
$ErrorActionPreference = 'Stop'
. $Collector
$secret = 'do-not-export-this-value'
$rows = @()
$rows += ConvertTo-LaixinProcessEvidence @{Image='C:\Apps\Uninstall 来信AI工具箱统一版.exe';ParentImage='C:\Windows\powershell.exe';CommandLine='"C:\Apps\Uninstall 来信AI工具箱统一版.exe" /S --updated --password do-not-export-this-value';ProcessId='0x10';ParentProcessId='0x09';Source='fixture';Time='fixture'}
if ($rows.Count -ne 1 -or -not $rows[0].updatedFlag -or -not $rows[0].silentFlag -or $rows[0].parentImageName -ne 'powershell.exe') { throw 'TARGET_PROCESS_FIELDS_FAILED' }
$unrelated = ConvertTo-LaixinProcessEvidence @{Image='C:\Windows\notepad.exe';CommandLine=$secret}
if ($null -ne $unrelated) { throw 'UNRELATED_PROCESS_LEAKED' }
$candidate = ConvertTo-LaixinProcessEvidence @{Image='C:\Temp\~nsuA.tmp\Un_A.exe'}
if ($candidate.match -ne 'nsis-candidate-only' -or $candidate.commandLineAvailable) { throw 'UNKNOWN_SOURCE_OVERCLAIMED' }
$directory = Join-Path $env:TEMP ('LaixinEvidenceTest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
  $path = Join-Path $directory 'job.json'
  @{version='0.6.9';previous='0.6.8';mode='update';ownerPid=42;ownerExecutable='C:\Users\private-name\powershell.exe';notes=$secret;userData=$secret;tasks=@(@{xml=$secret});accountToken=$secret} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
  $transaction = Read-LaixinTransactionEvidence $path
  if ($transaction.version -ne '0.6.9' -or $transaction.mode -ne 'update' -or $transaction.ownerImageName -ne 'powershell.exe') { throw 'TRANSACTION_FIELDS_FAILED' }
  $json = @($rows,$candidate,$transaction) | ConvertTo-Json -Depth 6
  if ($json.Contains($secret) -or $json.Contains('private-name') -or $json.Contains('CommandLine"') -or $json.Contains('accountToken')) { throw 'SENSITIVE_CONTENT_LEAKED' }
  [IO.File]::WriteAllText($path,'{broken')
  if ((Read-LaixinTransactionEvidence $path).status -ne 'unreadable-json') { throw 'MALFORMED_FILE_HIDDEN' }
  Write-Output 'PASS: target fields, unrelated exclusion, NSIS uncertainty, JSON allowlist, secret exclusion, malformed JSON'
} finally { Remove-Item -LiteralPath $directory -Recurse -Force }
