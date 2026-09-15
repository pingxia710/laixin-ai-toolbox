param([Parameter(Mandatory=$true)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($job.platform -ne 'win' -or $job.parentPid -lt 1 -or $job.asarSha256 -notmatch '^[a-f0-9]{64}$' -or $job.assetSha256 -notmatch '^[a-f0-9]{64}$') { exit 1 }
function Write-Result($state, $message) {
  @{version=$job.version;state=$state;message=$message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.result -Encoding UTF8
}
Remove-Item -LiteralPath $job.acknowledgement -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $job.ready -Value 'ready' -Encoding UTF8
$deadline = (Get-Date).AddSeconds(30)
while (Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue) {
  if ((Get-Date) -ge $deadline) { Write-Result 'error' '工具箱尚未完成退出，更新已取消。'; exit 1 }
  Start-Sleep -Milliseconds 100
}
$asar = Join-Path $job.target 'resources\app.asar'
$backup = $null
$backupReady = $false
$started = $null
try {
  if ((Get-Item -LiteralPath $job.installer).Length -ne $job.assetSize -or (Get-FileHash -LiteralPath $job.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.assetSha256) { throw 'UPDATE_ASSET_CHANGED' }
  # 覆盖前整目录备份:NSIS /S 换的是整个安装目录(resources\sidecar、resources\xray、主程序 exe/dll 全换),
  # 只备份 app.asar 会在失败时留下「旧 asar + 新内核 + 新主程序」的混合体,那不是任何一个发过的版本。
  # 与 mac 侧 update-helper.cjs 的整 .app 换名回滚对称;校验失败的新包 ⛔ 启动。
  $backup = Join-Path (Split-Path $job.target) ('.laixin-update-backup-' + [DateTime]::UtcNow.Ticks)
  Copy-Item -LiteralPath $job.target -Destination $backup -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $backup 'resources\app.asar'))) { throw 'UPDATE_BACKUP_INCOMPLETE' }
  # 备份没落全就抛在这里:安装目录此刻还没被动过,原程序完好。
  $backupReady = $true
  # 本脚本自己也在被替换的安装目录里,但 PowerShell 先整文件解析再执行,NSIS 覆盖它不影响本次运行。
  $installer = Start-Process -FilePath $job.installer -ArgumentList @('/S', '--updated', "/D=$($job.target)") -PassThru
  if (-not $installer.WaitForExit(180000)) { Write-Result 'error' '安装仍在进行，请等待安装结束后重新打开工具箱。'; exit 1 }
  if ($installer.ExitCode -ne 0) { throw 'UPDATE_INSTALL_FAILED' }
  if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.asarSha256) { throw 'UPDATE_ASAR_INVALID' }
  # 回退备份要活到「新版确实启动了」之后:先删备份再启动,新版一起不来就再没有退路,
  # 客户手上只剩一个打不开的工具箱。mac 侧 update-helper.cjs 也是等回执之后才处理备份。
  $started = Start-Process -FilePath $job.executable -ArgumentList "--user-data-dir=`"$($job.userData)`"" -PassThru
  # 等回执的上限由主进程按「更新前客户连着没有」定:没连着照旧 45 秒;连着的要容下
  # 「新版起来 → 首连(守护自己还有 42 秒的退避梯子)」,再留时间给新版自己退出让台。
  # 与 mac 侧 update-helper.cjs 同一个字段,⛔ 两端各写一个数。
  $startupMs = 45000
  # ⛔ 拿类型去判:ConvertFrom-Json 的数字可能是 Int64,按 Int32 判会失败、悄悄退回 45 秒。只判有值且为正。
  if ($null -ne $job.startupTimeoutMs -and $job.startupTimeoutMs -gt 0) { $startupMs = $job.startupTimeoutMs }
  $deadline = (Get-Date).AddMilliseconds($startupMs)
  $acknowledged = $false
  do {
    Start-Sleep -Milliseconds 200
    if (Test-Path -LiteralPath $job.acknowledgement) {
      $ack = Get-Content -LiteralPath $job.acknowledgement -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($ack.version -eq $job.version) { $acknowledged = $true }
    }
  } while (-not $acknowledged -and (Get-Date) -lt $deadline)
  if (-not $acknowledged) { throw 'UPDATE_STARTUP_UNCONFIRMED' }
  # 收到本次版本的启动回执 ⇒ 新版可用,到这里才删回退备份。
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  $backup = $null
  $backupReady = $false
  Write-Result 'complete' '工具箱已更新，账号和配置已保留。'
  Remove-Item -LiteralPath (Join-Path (Split-Path $job.result) 'pending.json') -Force
  exit 0
} catch {
  $reason = $_.Exception.Message
  $restored = $false
  if ($reason -eq 'UPDATE_STARTUP_UNCONFIRMED' -and $null -ne $started) {
    # 新版进程还活着 ⇒ 它正占着安装目录。把目录从一个跑着的进程底下挪走,换来的是个半死不活的状态;
    # 备份原样留在盘上交下一次启动或人工处理。与 mac 侧 update-helper.cjs 的 appRunning() 分支对称。
    # 新版「起来了但连不上」时会自己退出让台(它不写回执,先记下这一版别再自动装),而退出要几秒。
    # ⛔ 只看一眼就定:那会把本该回退的这一次判成「进程还在」,客户留在连不上的新版上。
    # 与 mac 侧 update-helper.cjs 的 appRunning() 轮询对称。
    $holding = $true
    $waitUntil = (Get-Date).AddSeconds(10)
    do {
      try { $holding = -not $started.HasExited } catch { $holding = $true }
      if (-not $holding) { break }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $waitUntil)
    if ($holding) {
      Write-Result 'error' '新版启动尚未确认，原版本备份已保留。请重新打开工具箱；仍然打不开请联系来信客服协助。'
      exit 1
    }
  }
  if ($backupReady -and (Test-Path -LiteralPath $backup)) {
    # 整目录还原:失败的安装目录先挪开,再把备份挪回原位。两步里任何一步失败都不删副本,
    # 让 .laixin-update-failed-* 与 .laixin-update-backup-* 都留在盘上交人工,⛔ 把客户留在无程序状态。
    try {
      $failed = Join-Path (Split-Path $job.target) ('.laixin-update-failed-' + [DateTime]::UtcNow.Ticks)
      if (Test-Path -LiteralPath $job.target) { Move-Item -LiteralPath $job.target -Destination $failed -Force }
      Move-Item -LiteralPath $backup -Destination $job.target -Force
      Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
      $restored = $true
    } catch { $restored = $false }
  } elseif ($null -ne $backup) {
    # 备份没做完 ⇒ 安装目录尚未被替换,原程序就在原位;半份备份清掉即可。
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($reason -eq 'UPDATE_ASAR_INVALID') {
    # 校验失败的包 ⛔ 启动;还原成功才允许回到旧版。
    if ($restored) {
      Write-Result 'error' '更新包校验未通过，已还原原版本，账号和配置已保留。请重新打开工具箱后重试。'
      Start-Process -FilePath $job.executable -ArgumentList "--user-data-dir=`"$($job.userData)`""
    } else {
      Write-Result 'error' '更新包校验未通过且未能还原原版本，请重新安装工具箱。账号和配置已保留。'
    }
    exit 1
  }
  Write-Result 'error' '更新未完成，原程序可用，账号和配置已保留，请重新打开工具箱后重试。'
  # 没动过安装目录(备份未完成)或已整目录还原,才允许拉起原程序;混合态 ⛔ 启动。
  if (-not $backupReady -or $restored) {
    if (Test-Path -LiteralPath $job.executable) { Start-Process -FilePath $job.executable -ArgumentList "--user-data-dir=`"$($job.userData)`"" }
  }
  exit 1
}
