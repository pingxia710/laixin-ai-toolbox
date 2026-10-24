param([Parameter(Mandatory=$true)][string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($job.platform -ne 'win' -or $job.parentPid -lt 1 -or $job.asarSha256 -notmatch '^[a-f0-9]{64}$' -or $job.assetSha256 -notmatch '^[a-f0-9]{64}$') { exit 1 }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinUpdateResultMove { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string target, uint flags); }'
function Write-Result($state, $message) {
  # PS5.1 的 Set-Content -Encoding UTF8 带 BOM；先在同目录无 BOM 写满并刷盘，再原子替换结果。
  $result = @{version=$job.version;state=$state;message=$message}
  if ($state -eq 'complete') {
    $result.previous = [string]$job.previous
    $result.notes = [string]$job.notes
  }
  $text = $result | ConvertTo-Json -Compress
  $temporary = $job.result + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text)
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (-not [LaixinUpdateResultMove]::MoveFileEx($temporary, $job.result, 9)) { throw 'UPDATE_RESULT_COMMIT_FAILED' }
  } catch {
    try { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop } catch { }
    throw
  }
}
function Invoke-WindowsPreflight {
  $helper = Join-Path $PSScriptRoot 'update-helper.cjs'
  if (-not (Test-Path -LiteralPath $helper)) { throw 'UPDATE_PREFLIGHT_HELPER_MISSING' }
  $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $previousOwnerPid = $env:LAIXIN_PREFLIGHT_OWNER_PID
  $previousOwnerExecutable = $env:LAIXIN_PREFLIGHT_OWNER_EXECUTABLE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:LAIXIN_PREFLIGHT_OWNER_PID = [string]$PID
    $env:LAIXIN_PREFLIGHT_OWNER_EXECUTABLE = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    # 路径作为 Start-Process 参数传递，不经 cmd；用户名里的 &/%/空格不能变成命令。
    $arguments = @('"' + $helper + '"', 'windows-preflight', 'update', '"' + $JobPath + '"')
    $preflight = Start-Process -FilePath $job.executable -ArgumentList $arguments -PassThru -WindowStyle Hidden
    # CJS 内是一个 165 秒总事务窗(含持久恢复闸与失败补偿)，外层给 185 秒，不能在合法串行预算中途杀掉它。
    if (-not $preflight.WaitForExit(185000)) {
      try { $preflight.Kill() } catch { }
      # 不允许本脚本先返回、留下仍可能改任务/注册表的 helper。Kill 后的有界窗口只用于正常收尸；
      # 极端情况下继续持有同一个 Process 句柄直到它真的退出。
      if (-not $preflight.WaitForExit(5000)) { [void]$preflight.WaitForExit() }
      throw 'UPDATE_PREFLIGHT_TIMEOUT'
    }
    if ($preflight.ExitCode -ne 0) { throw 'UPDATE_PREFLIGHT_FAILED' }
    $markerPath = Join-Path (Split-Path $job.result) 'windows-preflight-recovery.json'
    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marker.ownerPid -ne $PID -or [string]::IsNullOrEmpty([string]$marker.transactionId)) { throw 'UPDATE_PREFLIGHT_OWNER_MISMATCH' }
    return [string]$marker.transactionId
  } finally {
    if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
    if ($null -eq $previousOwnerPid) { Remove-Item Env:LAIXIN_PREFLIGHT_OWNER_PID -ErrorAction SilentlyContinue }
    else { $env:LAIXIN_PREFLIGHT_OWNER_PID = $previousOwnerPid }
    if ($null -eq $previousOwnerExecutable) { Remove-Item Env:LAIXIN_PREFLIGHT_OWNER_EXECUTABLE -ErrorAction SilentlyContinue }
    else { $env:LAIXIN_PREFLIGHT_OWNER_EXECUTABLE = $previousOwnerExecutable }
  }
}
function Invoke-WindowsPreflightCommit([string]$Transaction) {
  $directory = Split-Path $job.result
  $helper = Join-Path $directory 'windows-preflight-recovery.cjs'
  if (-not (Test-Path -LiteralPath $helper)) { throw 'UPDATE_PREFLIGHT_COMMIT_HELPER_MISSING' }
  $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $arguments = @('"' + $helper + '"', 'windows-preflight-commit', '"' + $directory + '"', [string]$PID, '"' + $Transaction + '"')
    $commit = Start-Process -FilePath $job.executable -ArgumentList $arguments -PassThru -WindowStyle Hidden
    # 提交命令自己的原生调用有超时和收尸。外层若先杀 Node，遗留的 PowerShell 子进程仍可能写
    # 注册表/提交记录并与恢复看守竞跑；这里一直持有更新者进程，直到整个提交子树自行收敛。
    [void]$commit.WaitForExit()
    if ($commit.ExitCode -ne 0) { throw 'UPDATE_PREFLIGHT_COMMIT_FAILED' }
  } finally {
    if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
  }
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
$installerStarted = $false
$started = $null
$preflightCommitted = $false
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
  # 只有包校验和完整备份都落盘后才停网络后台，缩短任何异常退出可能影响客户网络的窗口。
  # 前置闸会先持久化原任务状态并启动独立恢复看守，再停用任务/按精确路径停进程。
  $preflightTransaction = Invoke-WindowsPreflight
  # 本脚本自己也在被替换的安装目录里,但 PowerShell 先整文件解析再执行,NSIS 覆盖它不影响本次运行。
  # 这次 helper 已完成唯一一次前置闸。把安装目录标记交给新安装器 customInit 与旧卸载器
  # customUnInstall，避免后者只看见 Disabled 后重新拍错快照；标记只在 NSIS 子进程树内有效。
  $previousPreflightHandoff = $env:LAIXIN_PREFLIGHT_HANDOFF_TARGET
  $installer = $null
  try {
    $env:LAIXIN_PREFLIGHT_HANDOFF_TARGET = [IO.Path]::GetFullPath([string]$job.target).TrimEnd('\')
    $installer = Start-Process -FilePath $job.installer -ArgumentList @('/S', '--updated', "/D=$($job.target)") -PassThru
    $installerStarted = $true
    # NSIS 会同步等待旧卸载器，旧卸载器失败还会重试。这里不再设一个比合法嵌套路径更短的外层
    # 180 秒闸，更不能先写失败回执并退出、任由后台安装器继续改目录；本进程持有到 NSIS 真正退出。
    [void]$installer.WaitForExit()
  } finally {
    if ($null -eq $previousPreflightHandoff) { Remove-Item Env:LAIXIN_PREFLIGHT_HANDOFF_TARGET -ErrorAction SilentlyContinue }
    else { $env:LAIXIN_PREFLIGHT_HANDOFF_TARGET = $previousPreflightHandoff }
  }
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
  # 新版已启动并按 requireConnected 写回执后，才提交持久恢复事务。提交失败时保留 marker，
  # 独立看守会在本 PowerShell 退出后按原快照补偿，不能为清理文件牺牲客户网络。
  Invoke-WindowsPreflightCommit $preflightTransaction
  $preflightCommitted = $true
  # final result 在持久提交之后落盘；后续清理失败不能把已展示的成功改写成失败。
  Write-Result 'complete' '工具箱已更新，账号和配置已保留。'
  # 最终结果未能写出时必须保留回退材料；成功落盘后清理备份只是磁盘卫生，失败不改事务结果。
  try { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop } catch { }
  $backup = $null
  $backupReady = $false
  try { Remove-Item -LiteralPath (Join-Path (Split-Path $job.result) 'pending.json') -Force -ErrorAction Stop } catch { }
  exit 0
} catch {
  $reason = $_.Exception.Message
  $restored = $false
  if ($preflightCommitted) {
    # 任务/网络提交已确认，不能写「提交未确认」或回滚正在运行的新版。结果落盘失败时保留旧版备份。
    try { Write-Result 'error' '新版已启动，网络恢复已提交，但最终更新结果未能写入。原版本备份已保留，请联系来信客服协助。' } catch { }
    exit 1
  }
  if ($acknowledged -and $null -ne $started) {
    # 新版已确认启动却没有得到持久提交证明：不能把备份删掉或把此次更新报成完成，
    # 也不能在新版仍运行时强行挪安装目录。恢复看守会保留网络原快照供重启续行。
    Write-Result 'error' '新版已启动，但网络恢复提交未确认。原版本备份已保留，请联系来信客服协助。'
    exit 1
  }
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
  if ($backupReady -and $installerStarted -and (Test-Path -LiteralPath $backup)) {
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
  if (-not $installerStarted -or $restored) {
    if (Test-Path -LiteralPath $job.executable) { Start-Process -FilePath $job.executable -ArgumentList "--user-data-dir=`"$($job.userData)`"" }
  }
  exit 1
}
