// Runs as a separate Node process so the app can finish its normal network cleanup before replacement.
const physicalFs = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = physicalFs.promises;
const { createReadStream } = physicalFs;
const { createHash, randomUUID } = require('node:crypto');
const { dirname, join } = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { win32 } = require('node:path');
const { tmpdir } = require('node:os');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const cleanEnv = { ...process.env }; delete cleanEnv.ELECTRON_RUN_AS_NODE;
// 拿主程序当 node 跑的随包进程（守护、内核看门狗）的判据：参数里带 sidecar 目录下的 .mjs。
const RUNS_SIDECAR_SCRIPT = /(?:^|\s)\S*[/\\]sidecar[/\\]\S*\.mjs(?:\s|$)/;

const WINDOWS_PREFLIGHT_TIMEOUT_MS = 5_000;
const WINDOWS_RECOVERY_GUARD_READY_MS = 20_000;
const WINDOWS_NATIVE_CWD = process.platform === 'win32'
  ? win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32') : undefined;
// Worst successful uninstall path includes arming the durable recovery guard before any mutation.
// A late failure can then need
// task recreation/readback, proxy fallback and resident restart. Keep one transaction-wide budget;
// the PowerShell caller waits 185s, leaving a 20s process-termination margin outside this helper.
const WINDOWS_PREFLIGHT_WORK_MS = 90_000;
const WINDOWS_PREFLIGHT_TOTAL_MS = 165_000;
const WINDOWS_PROCESS_GRACE_MS = 1_500;
const WINDOWS_RECOVERY_MARKER = 'windows-preflight-recovery.json';
const WINDOWS_RECOVERY_HELPER = 'windows-preflight-recovery.cjs';
const WINDOWS_RECOVERY_LAUNCHER = 'windows-preflight-recovery.ps1';
const WINDOWS_RECOVERY_READY = 'windows-preflight-recovery.ready';
const WINDOWS_RECOVERY_COMMIT = 'windows-preflight-recovery.committed';
const WINDOWS_RECOVERY_ARMED = 'windows-preflight-recovery.armed';
const WINDOWS_RECOVERY_GUARD = 'windows-preflight-recovery-guard.exe';
const WINDOWS_RECOVERY_RUN = 'LaixinToolboxUpdateRecovery';
const WINDOWS_RECOVERY_LOCK = 'windows-preflight-recovery.lock';

async function acquireWindowsRecoveryMutex(recoveryDirectory) {
  if (process.platform !== 'win32') return async () => {};
  const directory = recoveryDirectory ?? join(process.env.LOCALAPPDATA ?? tmpdir(), 'LaixinToolbox', 'updates');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, WINDOWS_RECOVERY_LOCK);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$lockPath=${decodeBase64PowerShell(lockPath)};$stream=$null;` +
    `try {try {$stream=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} catch [IO.IOException] {exit 52};` +
    `[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[void][Console]::In.ReadLine()} finally {if($null -ne $stream){$stream.Dispose()}}`;
  const child = spawn(powershell, encodedPowerShell(script), {
    cwd: WINDOWS_NATIVE_CWD, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'ignore']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Windows releases the file handle on process termination. */ }
      finish(new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY'));
    }, WINDOWS_PREFLIGHT_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 100) finish(new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY'));
      else if (output.includes('LOCKED')) finish();
    });
    child.once('error', () => finish(new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY')));
    child.once('close', () => finish(new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY')));
  });
  if (child.exitCode !== null) throw new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY');
  let releasing = false;
  child.once('close', () => {
    // The worker cannot continue writing tasks/registry after losing its cross-session file lock.
    if (!releasing) process.exit(1);
  });
  return async () => {
    releasing = true;
    child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* OS releases the file handle. */ } },
        WINDOWS_PREFLIGHT_TIMEOUT_MS);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  };
}

async function withWindowsRecoveryMutex(action, acquire = acquireWindowsRecoveryMutex, recoveryDirectory) {
  const release = await acquire(recoveryDirectory);
  try { return await action(); } finally { await release(); }
}

function runNative(file, args, { timeoutMs = WINDOWS_PREFLIGHT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const stdoutChunks = [], stderrChunks = [];
    let stdoutLength = 0, stderrLength = 0, settled = false, timedOut = false, timer;
    const child = spawn(file, args, { cwd: WINDOWS_NATIVE_CWD, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: decodeNativeOutput(stdoutChunks), stderr: decodeNativeOutput(stderrChunks), ...result });
    };
    child.stdout?.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      const keep = Math.min(bytes.length, 1_000_000 - stdoutLength);
      if (keep > 0) { stdoutChunks.push(bytes.subarray(0, keep)); stdoutLength += keep; }
    });
    child.stderr?.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      const keep = Math.min(bytes.length, 1_000_000 - stderrLength);
      if (keep > 0) { stderrChunks.push(bytes.subarray(0, keep)); stderrLength += keep; }
    });
    child.once('error', error => finish({ code: null, error: error.code ?? 'SPAWN_FAILED', timedOut }));
    child.once('close', code => finish({ code, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      // ChildProcess.kill uses the process handle on Windows. Do not return while the timed-out native
      // helper is still running: it may otherwise mutate tasks/registry after this transaction compensates.
      // Resolution belongs exclusively to close/error, so every caller knows the same child handle is dead.
      try { child.kill('SIGKILL'); } catch { /* A concurrent close/error event remains the only completion signal. */ }
    }, timeoutMs);
  });
}

function decodeNativeOutput(chunks) {
  const bytes = Buffer.concat(chunks);
  const sampleLength = Math.min(bytes.length, 200);
  let oddNulls = 0;
  for (let index = 1; index < sampleLength; index += 2) if (bytes[index] === 0) oddNulls += 1;
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (sampleLength >= 4 && oddNulls >= Math.floor(sampleLength / 8));
  return bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

function assertNotTimedOut(result, code) {
  if (result.timedOut === true) throw new Error(code);
}

function taskDisabled(xml) {
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/i.exec(xml);
  return settings !== null && /<Enabled>\s*false\s*<\/Enabled>/i.test(settings[1]);
}

function disableTaskXml(xml) {
  let found = false;
  const disabled = xml.replace(/(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/i, (_match, open, body, close) => {
    found = true;
    const next = /<Enabled>\s*(?:true|false)\s*<\/Enabled>/i.test(body)
      ? body.replace(/<Enabled>\s*(?:true|false)\s*<\/Enabled>/i, '<Enabled>false</Enabled>')
      : `<Enabled>false</Enabled>${body}`;
    return `${open}${next}${close}`;
  });
  if (!found) throw new Error('UPDATE_RESIDENT_TASK_XML_INVALID');
  return disabled;
}

function deadlineTimeout(deadlineAt, now = Date.now) {
  const remaining = deadlineAt - now();
  if (remaining <= 0) throw new Error('UPDATE_PREFLIGHT_DEADLINE');
  return Math.min(WINDOWS_PREFLIGHT_TIMEOUT_MS, remaining);
}

async function boundedCommand(commands, file, args, deadlineAt, now = Date.now) {
  return commands(file, args, { timeoutMs: deadlineTimeout(deadlineAt, now) });
}

async function taskConfirmedMissing(task, commands, schtasks, deadlineAt, now) {
  const separator = task.lastIndexOf('\\');
  const taskPath = separator >= 0 ? task.slice(0, separator + 1) : '\\';
  const taskName = task.slice(separator + 1);
  const powershell = win32.join(win32.dirname(schtasks), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `# LAIXIN_TASK_EXISTENCE_QUERY\n` +
    `$taskPath=${decodeBase64PowerShell(taskPath)};$taskName=${decodeBase64PowerShell(taskName)};` +
    `try {$matches=@(Get-ScheduledTask -ErrorAction Stop | Where-Object ` +
    `{$_.TaskPath -eq $taskPath -and $_.TaskName -eq $taskName});` +
    `if($matches.Count -eq 0){exit 3};if($matches.Count -eq 1){exit 0};exit 2} catch {exit 2}`;
  const result = await boundedCommand(commands, powershell, encodedPowerShell(script), deadlineAt, now);
  assertNotTimedOut(result, 'UPDATE_RESIDENT_TASK_QUERY_TIMEOUT');
  return result.code === 3;
}

async function queryResidentTask(task, commands, schtasks, deadlineAt, now) {
  const query = await boundedCommand(commands, schtasks, ['/query', '/tn', task, '/xml', 'ONE'], deadlineAt, now);
  assertNotTimedOut(query, 'UPDATE_RESIDENT_TASK_QUERY_TIMEOUT');
  if (query.code !== 0) {
    if (await taskConfirmedMissing(task, commands, schtasks, deadlineAt, now)) return { task, state: 'missing', xml: '' };
    throw new Error('UPDATE_RESIDENT_TASK_STATE_UNKNOWN');
  }
  return { task, state: taskDisabled(query.stdout) ? 'disabled' : 'enabled', xml: query.stdout };
}

async function changeResidentTask(task, state, commands, schtasks, deadlineAt, now) {
  const action = await boundedCommand(commands, schtasks,
    ['/change', '/tn', task, state === 'enabled' ? '/enable' : '/disable'], deadlineAt, now);
  assertNotTimedOut(action, 'UPDATE_RESIDENT_TASK_TIMEOUT');
  const readback = await queryResidentTask(task, commands, schtasks, deadlineAt, now);
  if (action.code !== 0) throw new Error(`UPDATE_RESIDENT_TASK_${state === 'enabled' ? 'ENABLE' : 'DISABLE'}_FAILED`);
  if (readback.state !== state) throw new Error(`UPDATE_RESIDENT_TASK_STILL_${state === 'enabled' ? 'DISABLED' : 'ENABLED'}`);
}

async function deleteResidentTask(task, commands, schtasks, deadlineAt, now) {
  const action = await boundedCommand(commands, schtasks, ['/delete', '/tn', task, '/f'], deadlineAt, now);
  assertNotTimedOut(action, 'UPDATE_RESIDENT_TASK_TIMEOUT');
  const readback = await queryResidentTask(task, commands, schtasks, deadlineAt, now);
  if (readback.state !== 'missing') {
    throw new Error(action.code === 0 ? 'UPDATE_RESIDENT_TASK_STILL_PRESENT' : 'UPDATE_RESIDENT_TASK_DELETE_FAILED');
  }
}

async function recreateResidentTask(snapshot, commands, powershell, deadlineAt, now, temporaryDirectory) {
  const xmlPath = join(temporaryDirectory, `laixin-resident-${randomUUID()}.xml`);
  try {
    const disabledXml = disableTaskXml(snapshot.xml);
    await fs.writeFile(xmlPath, Buffer.from(`\uFEFF${disabledXml}`, 'utf16le'), { mode: 0o600 });
    const separator = snapshot.task.lastIndexOf('\\');
    const taskPath = separator >= 0 ? snapshot.task.slice(0, separator + 1) : '\\';
    const taskName = snapshot.task.slice(separator + 1);
    const script = `# LAIXIN_TASK_COMPENSATION_REGISTER\n` +
      `$xmlPath=${decodeBase64PowerShell(xmlPath)};` +
      `$taskPath=${decodeBase64PowerShell(taskPath)};` +
      `$taskName=${decodeBase64PowerShell(taskName)};` +
      `$xml=[IO.File]::ReadAllText($xmlPath,[Text.Encoding]::Unicode);` +
      `Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $xml -Force -ErrorAction Stop | Out-Null`;
    const created = await boundedCommand(commands, powershell, encodedPowerShell(script), deadlineAt, now);
    assertNotTimedOut(created, 'UPDATE_RESIDENT_TASK_RECREATE_TIMEOUT');
    if (created.code !== 0) throw new Error('UPDATE_RESIDENT_TASK_RECREATE_FAILED');
  } finally {
    await fs.rm(xmlPath, { force: true }).catch(() => undefined);
  }
}

function normalizeWindowsPath(path) {
  return typeof path === 'string' && path !== '' ? win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase() : '';
}

async function windowsProcesses(commands, powershell, deadlineAt, now) {
  // Base64 makes the PowerShell 5.1 -> native pipe boundary ASCII-only; otherwise a Chinese install path
  // can be emitted in the active OEM code page and be corrupted when Node decodes it as UTF-8.
  const script = "$ErrorActionPreference='Stop'; $json=@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{Name='StartFileTime';Expression={if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}}}) | ConvertTo-Json -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))";
  const result = await boundedCommand(commands, powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], deadlineAt, now);
  assertNotTimedOut(result, 'UPDATE_PROCESS_QUERY_TIMEOUT');
  if (result.code !== 0) throw new Error('UPDATE_PROCESS_QUERY_FAILED');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')); }
  catch { throw new Error('UPDATE_PROCESS_QUERY_INVALID'); }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter(entry => Number.isSafeInteger(Number(entry?.ProcessId)))
    .map(entry => ({
      pid: Number(entry.ProcessId),
      name: typeof entry?.Name === 'string' ? entry.Name : '',
      path: typeof entry?.ExecutablePath === 'string' ? entry.ExecutablePath : undefined,
      commandLine: typeof entry?.CommandLine === 'string' ? entry.CommandLine : '',
      startFileTime: typeof entry?.StartFileTime === 'string' ? entry.StartFileTime : ''
    }));
}

function isRecoveryGuardProcess(item, options) {
  const guard = options.recoveryGuard;
  if (guard === undefined || item.pid !== guard.pid || normalizeWindowsPath(item.path) !== normalizeWindowsPath(guard.executable)) return false;
  const commandLine = item.commandLine.toLowerCase();
  return commandLine.includes(String(guard.modeToken).toLowerCase()) &&
    commandLine.includes(String(guard.commandToken).toLowerCase()) &&
    commandLine.includes(String(guard.transactionId).toLowerCase());
}

function excludedManagedProcess(item, options) {
  // The current worker PID cannot be reused while this very process is executing. The detached guard uses
  // the managed executable as a Node host, so exclude only its exact PID + command + transaction identity.
  return item.pid === (options.currentPid ?? process.pid) || isRecoveryGuardProcess(item, options);
}

function managedProcesses(processes, options) {
  const expected = new Set([
    normalizeWindowsPath(options.executable),
    normalizeWindowsPath(win32.join(options.target, 'resources', 'xray', 'xray.exe'))
  ]);
  return processes.filter(item => !excludedManagedProcess(item, options) && expected.has(normalizeWindowsPath(item.path)));
}

function assertManagedIdentityKnown(processes, options) {
  const managedNames = new Set([win32.basename(options.executable).toLowerCase(), 'xray.exe']);
  if (processes.some(item => !excludedManagedProcess(item, options) && managedNames.has(item.name.toLowerCase()) &&
      (item.path === undefined || !/^\d{15,19}$/.test(item.startFileTime)))) {
    throw new Error('UPDATE_PROCESS_IDENTITY_UNKNOWN');
  }
}

function encodedPowerShell(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')];
}

function recoveryPaths(directory) {
  return {
    markerPath: join(directory, WINDOWS_RECOVERY_MARKER),
    helperPath: join(directory, WINDOWS_RECOVERY_HELPER),
    launcherPath: join(directory, WINDOWS_RECOVERY_LAUNCHER),
    readyPath: join(directory, WINDOWS_RECOVERY_READY),
    guardStartPath: join(directory, 'windows-preflight-recovery.guard-started'),
    commitPath: join(directory, WINDOWS_RECOVERY_COMMIT),
    armedPath: join(directory, WINDOWS_RECOVERY_ARMED),
    guardPath: join(directory, WINDOWS_RECOVERY_GUARD),
    guardErrorPath: join(directory, 'windows-preflight-recovery.guard-error')
  };
}

async function pathExists(path) {
  try { await fs.access(path); return true; } catch { return false; }
}

async function writeDurableJson(path, value) {
  await writeDurableFile(path, `${JSON.stringify(value)}\n`);
}

async function writeDurableFile(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await writeThroughRename(temporary, path); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

async function writeThroughRename(source, target) {
  if (process.platform !== 'win32') { await fs.rename(source, target); return; }
  let moveFile;
  let getLastError;
  try {
    const koffi = require(win32.join(win32.dirname(process.execPath), 'resources', 'sidecar', 'win', 'node_modules', 'koffi'));
    const kernel32 = koffi.load('kernel32.dll');
    moveFile = kernel32.func('bool __stdcall MoveFileExW(str16 source, str16 target, uint32 flags)');
    getLastError = kernel32.func('uint32 __stdcall GetLastError()');
  } catch { throw new Error('UPDATE_RECOVERY_NATIVE_RENAME_UNAVAILABLE'); }
  // LAIXIN_DURABLE_RENAME: same-directory atomic replace + write-through, without a PowerShell child.
  if (!moveFile(source, target, 9)) {
    const win32Error = getLastError();
    throw new Error(`UPDATE_RECOVERY_DURABLE_RENAME_FAILED:WIN32_${win32Error}`);
  }
}

function decodeBase64PowerShell(value) {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(value), 'utf8').toString('base64')}'))`;
}

function proxyOwnershipPowerShell() {
  return String.raw`function Test-LaixinProxyFallback([string]$TunnelDataDir,[object]$Settings) {
  # LAIXIN_PROXY_LEDGER_OWNERSHIP:只认可核的同会话账本；终端层等未结算面不能用关开关代替恢复。
  if([string]::IsNullOrWhiteSpace($TunnelDataDir)){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
  try {
    if(Test-Path -LiteralPath (Join-Path $TunnelDataDir 'ledger-recovery-required') -ErrorAction Stop){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    $raw=Get-Content -LiteralPath (Join-Path $TunnelDataDir 'ledger.json') -Raw -Encoding UTF8 -ErrorAction Stop
    if(-not $raw.TrimStart().StartsWith('[')){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    $ledger=@(ConvertFrom-Json -InputObject $raw -ErrorAction Stop)
    if($ledger.Count -eq 0){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    foreach($entry in $ledger){
      if($null -eq $entry -or [string]::IsNullOrWhiteSpace([string]$entry.id) -or $null -eq $entry.time){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
      if($entry.kind -eq 'setting'){
        if([string]::IsNullOrWhiteSpace([string]$entry.service) -or [string]::IsNullOrWhiteSpace([string]$entry.item) -or
          [string]::IsNullOrWhiteSpace([string]$entry.sessionToken) -or
          $entry.status -notin @('applied','restored','preserved','kept-modified','restore-failed') -or
          $entry.note -isnot [string] -or $entry.PSObject.Properties.Name -notcontains 'originalValue' -or
          $entry.PSObject.Properties.Name -notcontains 'writtenValue'){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
      } elseif($entry.kind -ne 'intent' -or $entry.intent -notin @('connected','user-disconnected','shutdown')){
        throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'
      }
    }
    $pending=@($ledger | Where-Object {$_.kind -eq 'setting' -and $_.status -in @('applied','kept-modified','restore-failed')})
    if(@($pending | Where-Object {$_.service -eq 'TerminalEnvironment'}).Count -gt 0){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    if([int]$Settings.ProxyEnable -ne 1){if($pending.Count -gt 0){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'};return $false}
    $match=[regex]::Match([string]$Settings.ProxyServer,'^127\.0\.0\.1:([1-9][0-9]{0,4})$')
    if(-not $match.Success){
      if($pending.Count -gt 0 -or [string]$Settings.ProxyServer -match '(?i)(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?):\d{1,5}'){
        throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'
      }
      return $false
    }
    $port=[int]$match.Groups[1].Value
    if($port -gt 65535 -or $pending.Count -ne 2){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    $server=@($pending | Where-Object {$_.service -eq 'WinINET' -and $_.item -eq 'ProxyServer'})
    $enable=@($pending | Where-Object {$_.service -eq 'WinINET' -and $_.item -eq 'ProxyEnable'})
    if($server.Count -ne 1 -or $enable.Count -ne 1){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    $server=$server[0];$enable=$enable[0]
    $owned=$server.sessionToken -ceq $enable.sessionToken -and
      $server.writtenValue.type -ceq 'REG_SZ' -and $server.writtenValue.data -ceq [string]$Settings.ProxyServer -and
      $enable.writtenValue.type -ceq 'REG_DWORD' -and [string]$enable.writtenValue.data -ceq '1' -and
      ($null -eq $enable.originalValue -or [string]$enable.originalValue.data -match '^(?:0|0x0+)$')
    if(-not $owned){throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq $port})
    # ::1-only 不占 WinINET 的 IPv4 回环入口；0.0.0.0 可服务，:: 或其他 IPv6 形态归属不明。
    if(@($listeners | Where-Object {$_.LocalAddress -in @('127.0.0.1','0.0.0.0') -or
      $_.LocalAddress -eq '::' -or ([string]$_.LocalAddress -like '*:*' -and $_.LocalAddress -ne '::1')}).Count -gt 0){
      throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'
    }
    return $true
  } catch {throw 'UPDATE_PROXY_OWNERSHIP_UNKNOWN'}
}`;
}

function recoveryLauncherScript(marker, readyPath, guardStartPath, launcherPath, powershell) {
  const runValue = recoveryRunCommand(launcherPath, powershell);
  return String.raw`param([switch]$Reboot,[string]$Transaction)
$ErrorActionPreference='Stop'
$markerPath=${decodeBase64PowerShell(marker.markerPath)}
$expectedTransaction=${decodeBase64PowerShell(marker.transactionId)}
$expectedLabel=${decodeBase64PowerShell(marker.residentLabel)}
$runValue=${decodeBase64PowerShell(runValue)}
$readyPath=${decodeBase64PowerShell(readyPath)}
$guardStartPath=${decodeBase64PowerShell(guardStartPath)}
$armedPath=Join-Path (Split-Path -LiteralPath $markerPath) '${WINDOWS_RECOVERY_ARMED}'
$commitPath=Join-Path (Split-Path -LiteralPath $markerPath) '${WINDOWS_RECOVERY_COMMIT}'
$lockPath=Join-Path (Split-Path -LiteralPath $markerPath) '${WINDOWS_RECOVERY_LOCK}'
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName='${WINDOWS_RECOVERY_RUN}'
if(-not $Reboot){exit 60}

Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinRecoveryRegistry { [DllImport("advapi32.dll")] public static extern int RegFlushKey(IntPtr key); }'
$lockStream=$null
try {
  $lockDeadline=(Get-Date).AddSeconds(30)
  do {
    try {$lockStream=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);break}
    catch [IO.IOException] {Start-Sleep -Milliseconds 100}
  } while ((Get-Date) -lt $lockDeadline)
  if($null -eq $lockStream){exit 72}

# LAIXIN_RECOVERY_NATIVE_COMPENSATE
function Read-RecoveryJson([string]$Path) {
  if(-not (Test-Path -LiteralPath $Path)){return $null}
  return ([IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8) | ConvertFrom-Json)
}
function Register-Recovery {
  if(-not (Test-Path -LiteralPath $runKey -ErrorAction Stop)){[void](New-Item -Path $runKey -Force -ErrorAction Stop)}
  [void](New-ItemProperty -LiteralPath $runKey -Name $runName -PropertyType String -Value $runValue -Force -ErrorAction Stop)
  $after=Get-ItemPropertyValue -LiteralPath $runKey -Name $runName -ErrorAction Stop
  if(-not [string]::Equals([string]$after,$runValue,[StringComparison]::Ordinal)){throw 'UPDATE_RECOVERY_REGISTER_FAILED'}
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try {if($null -eq $key -or [LaixinRecoveryRegistry]::RegFlushKey($key.Handle.DangerousGetHandle()) -ne 0){throw 'UPDATE_RECOVERY_REGISTER_FAILED'}} finally {if($null -ne $key){$key.Dispose()}}
}
function Unregister-Recovery {
  if(-not (Test-Path -LiteralPath $runKey -ErrorAction Stop)){return}
  $before=Get-ItemProperty -LiteralPath $runKey -ErrorAction Stop
  if($before.PSObject.Properties.Name -contains $runName){
    Remove-ItemProperty -LiteralPath $runKey -Name $runName -Force -ErrorAction Stop
  }
  $left=Get-ItemProperty -LiteralPath $runKey -ErrorAction Stop
  if($null -ne $left -and $left.PSObject.Properties.Name -contains $runName){throw 'UPDATE_RECOVERY_UNREGISTER_FAILED'}
}
function Write-RecoveryCommit {
  $commit=Read-RecoveryJson $commitPath
  if($null -ne $commit -and $commit.version -eq 1 -and $commit.transactionId -eq $expectedTransaction){return}
  $temporary=$commitPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  $json='{ "version":1,"transactionId":"'+$expectedTransaction+'"}'+[Environment]::NewLine
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($json)
  $stream=New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinRecoveryMoveFile { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string target, uint flags); }'
  if(-not [LaixinRecoveryMoveFile]::MoveFileEx($temporary,$commitPath,9)){throw 'UPDATE_RECOVERY_DURABLE_RENAME_FAILED'}
}
function Complete-Recovery {
  try {
    Unregister-Recovery
    Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $guardStartPath -Force -ErrorAction SilentlyContinue
    if(Test-Path -LiteralPath $armedPath){Remove-Item -LiteralPath $armedPath -Force -ErrorAction Stop}
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    # Keep the committed record across cleanup. If a deleted marker reappears after power loss,
    # the matching record still makes the next pass cleanup-only, never rollback.
  } catch {
    if(Test-Path -LiteralPath $markerPath){try {Register-Recovery} catch {}}
    throw
  }
}
function Get-RecoveryTask([string]$TaskPath,[string]$TaskName) {
  $matches=@(Get-ScheduledTask -ErrorAction Stop | Where-Object {$_.TaskPath -eq $TaskPath -and $_.TaskName -eq $TaskName})
  if($matches.Count -gt 1){throw 'UPDATE_RESIDENT_TASK_STATE_UNKNOWN'}
  if($matches.Count -eq 1){return $matches[0]}
  return $null
}
function Disabled-TaskXml([string]$Xml) {
  $options=[Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::Singleline
  $enabled='(<Settings(?:\s[^>]*)?>.*?<Enabled>)\s*(?:true|false)\s*</Enabled>'
  if([regex]::IsMatch($Xml,$enabled,$options)){return [regex]::Replace($Xml,$enabled,'$1false</Enabled>',$options)}
  $settings='(<Settings(?:\s[^>]*)?>)'
  if(-not [regex]::IsMatch($Xml,$settings,$options)){throw 'UPDATE_RESIDENT_TASK_XML_INVALID'}
  return [regex]::Replace($Xml,$settings,'$1<Enabled>false</Enabled>',$options)
}
function Assert-RecoveryTask([object]$Task,[bool]$Enabled) {
  if($null -eq $Task -or [bool]$Task.Settings.Enabled -ne $Enabled){throw 'UPDATE_RESIDENT_TASK_RESTORE_FAILED'}
}
${proxyOwnershipPowerShell()}
function Invoke-ProxyFallback([object]$Marker) {
  # LAIXIN_RECOVERY_PROXY_FALLBACK
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $settings=Get-ItemProperty -LiteralPath $key -ErrorAction Stop
  $mustDisable=Test-LaixinProxyFallback ([string]$Marker.tunnelDataDir) $settings
  if($mustDisable){
    Set-ItemProperty -LiteralPath $key -Name ProxyEnable -Type DWord -Value 0 -ErrorAction Stop
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinRecoveryWinInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }'
    [void][LaixinRecoveryWinInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)
    [void][LaixinRecoveryWinInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)
  }
  $after=Get-ItemProperty -LiteralPath $key -ErrorAction Stop
  if($mustDisable -and [int]$after.ProxyEnable -ne 0){throw 'UPDATE_PROXY_FALLBACK_FAILED'}
}
function Invoke-NativeRecovery([object]$Marker) {
  if($Marker.version -ne 1 -or -not [string]::Equals([string]$Marker.transactionId,$expectedTransaction,[StringComparison]::Ordinal) -or
     -not [string]::Equals([string]$Marker.residentLabel,$expectedLabel,[StringComparison]::Ordinal) -or @($Marker.tasks).Count -ne 2){
    throw 'UPDATE_RECOVERY_MARKER_INVALID'
  }
  $specs=@(
    [pscustomobject]@{Snapshot=$Marker.tasks[0];TaskPath='\Laixin\';TaskName=$expectedLabel},
    [pscustomobject]@{Snapshot=$Marker.tasks[1];TaskPath='\';TaskName=$expectedLabel}
  )
  if(-not [string]::Equals([string]$specs[0].Snapshot.task,'\Laixin\'+$expectedLabel,[StringComparison]::Ordinal) -or
     -not [string]::Equals([string]$specs[1].Snapshot.task,$expectedLabel,[StringComparison]::Ordinal)){
    throw 'UPDATE_RECOVERY_MARKER_INVALID'
  }
  foreach($spec in $specs){
    $state=[string]$spec.Snapshot.state
    if($state -notin @('missing','disabled','enabled') -or
       ($state -ne 'missing' -and [string]::IsNullOrEmpty([string]$spec.Snapshot.xml))){
      throw 'UPDATE_RECOVERY_MARKER_INVALID'
    }
  }
  $failures=@()
  # LAIXIN_RECOVERY_TASK_PREPARE
  foreach($spec in $specs){
    try {
      $state=[string]$spec.Snapshot.state
      $current=Get-RecoveryTask $spec.TaskPath $spec.TaskName
      if($state -eq 'missing'){
        if($null -ne $current){Unregister-ScheduledTask -InputObject $current -Confirm:$false -ErrorAction Stop}
        if($null -ne (Get-RecoveryTask $spec.TaskPath $spec.TaskName)){throw 'UPDATE_RESIDENT_TASK_STILL_PRESENT'}
        continue
      }
      if($null -eq $current){
        $disabled=Disabled-TaskXml ([string]$spec.Snapshot.xml)
        Register-ScheduledTask -TaskPath $spec.TaskPath -TaskName $spec.TaskName -Xml $disabled -Force -ErrorAction Stop | Out-Null
      } else {
        Disable-ScheduledTask -InputObject $current -ErrorAction Stop | Out-Null
      }
      Assert-RecoveryTask (Get-RecoveryTask $spec.TaskPath $spec.TaskName) $false
    } catch {
      $failures+='task-prepare:'+[string]$spec.Snapshot.task
    }
  }
  # LAIXIN_RECOVERY_PROXY_FALLBACK_STEP
  try {Invoke-ProxyFallback $Marker} catch {$failures+='proxy'}
  # LAIXIN_RECOVERY_TASK_FINISH
  $firstEnabled=$null
  foreach($spec in $specs){
    if($spec.Snapshot.state -eq 'missing'){continue}
    try {
      $current=Get-RecoveryTask $spec.TaskPath $spec.TaskName
      if($spec.Snapshot.state -eq 'enabled'){
        Enable-ScheduledTask -InputObject $current -ErrorAction Stop | Out-Null
        Assert-RecoveryTask (Get-RecoveryTask $spec.TaskPath $spec.TaskName) $true
        if($null -eq $firstEnabled){$firstEnabled=$spec}
      } else {Assert-RecoveryTask $current $false}
    } catch {
      $failures+='task-finish:'+[string]$spec.Snapshot.task
    }
  }
  if($null -ne $firstEnabled){
    try {
      Start-ScheduledTask -InputObject (Get-RecoveryTask $firstEnabled.TaskPath $firstEnabled.TaskName) -ErrorAction Stop
      $residentConfirmed=$false
      for($attempt=0;$attempt -lt 10;$attempt++){
        $resident=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
          $_.ExecutablePath -ieq [string]$Marker.executable -and
          $_.CommandLine -match '[/\\]sidecar[/\\]win[/\\]tunnel-daemon\.mjs'
        })
        if($resident.Count -gt 0){$residentConfirmed=$true;break}
        Start-Sleep -Milliseconds 200
      }
      if(-not $residentConfirmed){throw 'UPDATE_RESIDENT_UNCONFIRMED'}
    } catch {$failures+='resident-unconfirmed'}
  }
  if($failures.Count -ne 0){throw ('UPDATE_PREFLIGHT_RECOVERY_FAILED:'+($failures -join ','))}
}

try {
  if(-not (Test-Path -LiteralPath $markerPath)){Unregister-Recovery;exit 0}
  $marker=Read-RecoveryJson $markerPath
  if($null -eq $marker -or -not [string]::Equals([string]$marker.transactionId,$expectedTransaction,[StringComparison]::Ordinal)){throw 'UPDATE_RECOVERY_MARKER_INVALID'}
  $commit=Read-RecoveryJson $commitPath
  if($null -ne $commit -and $commit.version -eq 1 -and $commit.transactionId -eq $expectedTransaction){Complete-Recovery;exit 0}
  $armed=Read-RecoveryJson $armedPath
  if($null -eq $armed -or $armed.version -ne 1 -or $armed.transactionId -ne $expectedTransaction){Write-RecoveryCommit;Complete-Recovery;exit 0}
  Invoke-NativeRecovery $marker
  # LAIXIN_RECOVERY_COMMIT
  Write-RecoveryCommit
  Complete-Recovery
  exit 0
} catch {
  if(Test-Path -LiteralPath $markerPath){
    try {
      $current=Read-RecoveryJson $markerPath
      # A stale Run entry must never replace a newer transaction's reboot trigger.
      if($null -ne $current -and [string]::Equals([string]$current.transactionId,$expectedTransaction,[StringComparison]::Ordinal)){Register-Recovery}
    } catch {}
  }
  exit 70
}
} finally {if($null -ne $lockStream){$lockStream.Dispose()}}
`;
}

function recoveryRunCommand(launcherPath, powershell) {
  return `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcherPath}" -Reboot`;
}

function registerRecoveryScript(value) {
  return `# LAIXIN_RECOVERY_REGISTER\n` +
    `$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';` +
    `$name='${WINDOWS_RECOVERY_RUN}';$value=${decodeBase64PowerShell(value)};` +
    `if(-not (Test-Path -LiteralPath $key -ErrorAction Stop)){[void](New-Item -Path $key -Force -ErrorAction Stop)};` +
    `[void](New-ItemProperty -LiteralPath $key -Name $name -PropertyType String -Value $value -Force -ErrorAction Stop);` +
    `$after=Get-ItemPropertyValue -LiteralPath $key -Name $name -ErrorAction Stop;` +
    `if(-not [string]::Equals([string]$after,$value,[StringComparison]::Ordinal)){exit 41};` +
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinRecoveryRegistry { [DllImport("advapi32.dll")] public static extern int RegFlushKey(IntPtr key); }';` +
    `$handle=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run');` +
    `try {if($null -eq $handle -or [LaixinRecoveryRegistry]::RegFlushKey($handle.Handle.DangerousGetHandle()) -ne 0){exit 43}} finally {if($null -ne $handle){$handle.Dispose()}};`;
}

function unregisterRecoveryScript() {
  return `# LAIXIN_RECOVERY_UNREGISTER\n` +
    `$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';$name='${WINDOWS_RECOVERY_RUN}';` +
    `if(-not (Test-Path -LiteralPath $key -ErrorAction Stop)){exit 0};` +
    `$before=Get-ItemProperty -LiteralPath $key -ErrorAction Stop;` +
    `if($before.PSObject.Properties.Name -contains $name){Remove-ItemProperty -LiteralPath $key -Name $name -Force -ErrorAction Stop};` +
    `$left=Get-ItemProperty -LiteralPath $key -ErrorAction Stop;` +
    `if($null -ne $left -and $left.PSObject.Properties.Name -contains $name){exit 42};`;
}

async function setRecoveryRun(marker, launcherPath, commands, native, deadlineAt, now) {
  const value = recoveryRunCommand(launcherPath, native.powershell);
  if (value.length > 259) throw new Error('UPDATE_RECOVERY_COMMAND_TOO_LONG');
  const result = await boundedCommand(commands, native.powershell, encodedPowerShell(registerRecoveryScript(value)), deadlineAt, now);
  assertNotTimedOut(result, 'UPDATE_RECOVERY_REGISTER_TIMEOUT');
  if (result.code !== 0) throw new Error('UPDATE_RECOVERY_REGISTER_FAILED');
}

async function clearRecoveryRun(commands, native, deadlineAt, now) {
  const result = await boundedCommand(commands, native.powershell, encodedPowerShell(unregisterRecoveryScript()), deadlineAt, now);
  assertNotTimedOut(result, 'UPDATE_RECOVERY_UNREGISTER_TIMEOUT');
  if (result.code !== 0) throw new Error('UPDATE_RECOVERY_UNREGISTER_FAILED');
}

async function readRecoveryMarker(markerPath) {
  const stat = await fs.stat(markerPath);
  if (stat.size < 2 || stat.size > 3_000_000) throw new Error('UPDATE_RECOVERY_MARKER_INVALID');
  let marker;
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
  catch { throw new Error('UPDATE_RECOVERY_MARKER_INVALID'); }
  const target = normalizeWindowsPath(marker?.target);
  const executable = normalizeWindowsPath(marker?.executable);
  const expectedTasks = typeof marker?.residentLabel === 'string'
    ? [`\\Laixin\\${marker.residentLabel}`, marker.residentLabel] : [];
  const tasks = Array.isArray(marker?.tasks) ? marker.tasks : [];
  const tasksValid = tasks.length === expectedTasks.length && tasks.every((task, index) =>
    task?.task === expectedTasks[index] && ['missing', 'disabled', 'enabled'].includes(task?.state) &&
    (task.state === 'missing' ? task.xml === '' : typeof task.xml === 'string' && task.xml.length > 0));
  if (marker?.version !== 1 || typeof marker?.transactionId !== 'string' || marker.transactionId === '' ||
      !['update', 'uninstall'].includes(marker?.mode) || target === '' || executable === '' ||
      normalizeWindowsPath(win32.dirname(marker.executable)) !== target || !tasksValid ||
      !Number.isSafeInteger(marker?.ownerPid) || marker.ownerPid < 1 ||
      !Number.isSafeInteger(marker?.workerPid) || marker.workerPid < 1 ||
      normalizeWindowsPath(marker?.ownerExecutable) === '' ||
      normalizeWindowsPath(marker?.workerExecutable) !== executable ||
      !/^\d{15,19}$/.test(marker?.ownerStartFileTime) ||
      !/^\d{15,19}$/.test(marker?.workerStartFileTime)) {
    throw new Error('UPDATE_RECOVERY_MARKER_INVALID');
  }
  return { ...marker, markerPath, tasks };
}

async function writeRecoveryGuardFailure(guardErrorPath, code) {
  try { await fs.writeFile(guardErrorPath, code, { mode: 0o600 }); } catch { /* The caller still receives the failure code. */ }
}

function recoveryGuardFailure(code) {
  return new Error(`UPDATE_RECOVERY_GUARD_FAILED:${code}`);
}

async function defaultRecoveryGuardLauncher({ guardSourcePath, guardPath, guardErrorPath, guardStartPath, readyPath,
  launcherPath, powershell, marker, transactionId }, spawnImpl = spawn) {
  // Keep the long-running process native and outside the install directory. Holding the installed Electron
  // executable open here would make the guard itself prevent NSIS from deleting that executable.
  try { await fs.copyFile(guardSourcePath, guardPath); }
  catch {
    await writeRecoveryGuardFailure(guardErrorPath, 'UPDATE_RECOVERY_GUARD_NATIVE_UNAVAILABLE');
    throw recoveryGuardFailure('UPDATE_RECOVERY_GUARD_NATIVE_UNAVAILABLE');
  }
  let child;
  try {
    child = spawnImpl(guardPath, ['--laixin-recovery-guard', transactionId], {
      env: {
        ...cleanEnv,
        LAIXIN_RECOVERY_GUARD_TRANSACTION: transactionId,
        LAIXIN_RECOVERY_GUARD_ERROR_PATH: guardErrorPath,
        LAIXIN_RECOVERY_GUARD_STARTED_PATH: guardStartPath,
        LAIXIN_RECOVERY_GUARD_READY_PATH: readyPath,
        LAIXIN_RECOVERY_GUARD_OWNER_PID: String(marker.ownerPid),
        LAIXIN_RECOVERY_GUARD_OWNER_PATH: marker.ownerExecutable,
        LAIXIN_RECOVERY_GUARD_OWNER_STARTED: marker.ownerStartFileTime,
        LAIXIN_RECOVERY_GUARD_WORKER_PID: String(marker.workerPid),
        LAIXIN_RECOVERY_GUARD_WORKER_PATH: marker.workerExecutable,
        LAIXIN_RECOVERY_GUARD_WORKER_STARTED: marker.workerStartFileTime,
        LAIXIN_RECOVERY_GUARD_POWERSHELL: powershell,
        LAIXIN_RECOVERY_GUARD_LAUNCHER: launcherPath
      }, cwd: WINDOWS_NATIVE_CWD,
      detached: false, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: false
    });
  } catch {
    await writeRecoveryGuardFailure(guardErrorPath, 'UPDATE_RECOVERY_GUARD_LAUNCH_FAILED');
    throw recoveryGuardFailure('UPDATE_RECOVERY_GUARD_LAUNCH_FAILED');
  }
  const pid = await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const failed = () => {
      void writeRecoveryGuardFailure(guardErrorPath, 'UPDATE_RECOVERY_GUARD_LAUNCH_FAILED')
        .finally(() => finish(undefined, recoveryGuardFailure('UPDATE_RECOVERY_GUARD_LAUNCH_FAILED')));
    };
    child.once('spawn', () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) finish(child.pid);
      else failed();
    });
    child.once('error', failed);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* The failed launcher must not linger. */ }
      failed();
    }, WINDOWS_PREFLIGHT_TIMEOUT_MS);
  });
  child.unref();
  return pid;
}

async function waitForRecoveryGuard(readyPath, guardStartPath, guardErrorPath, transactionId, launchedPid) {
  const startedAt = Date.now();
  const deadline = startedAt + WINDOWS_RECOVERY_GUARD_READY_MS;
  let started = false;
  do {
    try {
      const record = (await fs.readFile(guardStartPath, 'utf8')).trim();
      const [seenTransaction, pidText] = record.split(':');
      if (seenTransaction !== transactionId) throw recoveryGuardFailure('UPDATE_RECOVERY_GUARD_START_TRANSACTION_MISMATCH');
      const startedPid = Number(pidText);
      if (!Number.isSafeInteger(startedPid) || startedPid < 1 || (launchedPid !== undefined && startedPid !== launchedPid)) {
        throw recoveryGuardFailure('UPDATE_RECOVERY_GUARD_START_PID_MISMATCH');
      }
      started = true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('UPDATE_RECOVERY_GUARD_FAILED:')) throw error;
    }
    try {
      const ready = (await fs.readFile(readyPath, 'utf8')).trim();
      const [seenTransaction, pidText] = ready.split(':');
      if (seenTransaction === transactionId) {
        const readyPid = Number(pidText);
        if (Number.isSafeInteger(readyPid) && readyPid > 0 &&
            (launchedPid === undefined || launchedPid === readyPid)) return readyPid;
        // Test launchers provide their own process identity; the production trampoline cannot.
        if (pidText === undefined && Number.isSafeInteger(launchedPid) && launchedPid > 0) return launchedPid;
      }
    } catch { /* Guard has not acknowledged the durable marker yet. */ }
    try {
      const reason = (await fs.readFile(guardErrorPath, 'utf8')).trim();
      if (/^UPDATE_RECOVERY_GUARD_[A-Z_]+$/.test(reason)) {
        throw new Error(`UPDATE_RECOVERY_GUARD_FAILED:${reason}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('UPDATE_RECOVERY_GUARD_FAILED:')) throw error;
    }
    await pause(50);
  } while (Date.now() < deadline);
  if (!started) throw recoveryGuardFailure('UPDATE_RECOVERY_GUARD_SCRIPT_NOT_STARTED');
  throw new Error(`UPDATE_RECOVERY_GUARD_TIMEOUT:WAITED_MS_${Date.now() - startedAt}`);
}

function sameHandleTerminationScript(processEntry) {
  const expected = Buffer.from(String(processEntry.path), 'utf8').toString('base64');
  const expectedStart = String(processEntry.startFileTime);
  // CIM CreationDate carries microseconds; GetProcessTimes carries 100ns FILETIME ticks.
  // A one-microsecond comparison tolerance preserves PID-reuse protection without false mismatch.
  return `# LAIXIN_SAME_HANDLE_TERMINATE LAIXIN_PID=${String(processEntry.pid)}\n` +
    `$pidToStop=${String(processEntry.pid)}; $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'));$expectedStart='${expectedStart}';\n` +
    `Add-Type -TypeDefinition @'\nusing System; using System.Text; using System.Runtime.InteropServices;\n` +
    `public static class LaixinNativeProcess {\n` +
    ` [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);\n` +
    ` [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);\n` +
    ` [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);\n` +
    ` [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);\n` +
    ` [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);\n` +
    ` [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);\n}\n'@;\n` +
    `$handle=[LaixinNativeProcess]::OpenProcess(0x101001,$false,[uint32]$pidToStop);\n` +
    `if($handle -eq [IntPtr]::Zero){$nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); if($nativeError -eq 87){exit 0}else{exit 21}};\n` +
    `$exitCode=0; try { $capacity=[uint32]32768; $path=New-Object Text.StringBuilder ([int]$capacity);\n` +
    ` if(-not [LaixinNativeProcess]::QueryFullProcessImageName($handle,0,$path,[ref]$capacity)){$exitCode=22}\n` +
    ` elseif(-not [string]::Equals([IO.Path]::GetFullPath($path.ToString()),[IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase)){$exitCode=0}\n` +
    ` else {$created=[long]0;$exited=[long]0;$kernel=[long]0;$user=[long]0;` +
    ` if(-not [LaixinNativeProcess]::GetProcessTimes($handle,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)){$exitCode=26}` +
    ` elseif([Math]::Abs($created - [long]$expectedStart) -gt 10){$exitCode=0}` +
    ` else {$wait=[LaixinNativeProcess]::WaitForSingleObject($handle,${String(WINDOWS_PROCESS_GRACE_MS)});\n` +
    `  if($wait -eq 0){$exitCode=0} elseif($wait -ne 258){$exitCode=23}\n` +
    `  elseif(-not [LaixinNativeProcess]::TerminateProcess($handle,1)){$exitCode=24}\n` +
    `  elseif([LaixinNativeProcess]::WaitForSingleObject($handle,2000) -ne 0){$exitCode=25}\n` +
    ` } } } finally {[void][LaixinNativeProcess]::CloseHandle($handle)}; exit $exitCode;`;
}

async function stopManagedProcess(processEntry, commands, powershell, deadlineAt, now) {
  // The helper waits on the already-opened process handle first. That gives the old daemon time to finish
  // its normal parent-disconnect cleanup; only after the bounded grace period is that same handle terminated.
  const stopped = await boundedCommand(commands, powershell, encodedPowerShell(sameHandleTerminationScript(processEntry)), deadlineAt, now);
  assertNotTimedOut(stopped, 'UPDATE_MANAGED_PROCESS_STOP_TIMEOUT');
  if (stopped.code !== 0) throw new Error('UPDATE_MANAGED_PROCESS_STOP_FAILED');
}

function proxyFallbackScript(tunnelDataDir) {
  return `${proxyOwnershipPowerShell()}\n# LAIXIN_PROXY_FALLBACK\n` +
    `$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';\n` +
    `$settings=Get-ItemProperty -LiteralPath $key -ErrorAction Stop;\n` +
    `$mustDisable=Test-LaixinProxyFallback (${decodeBase64PowerShell(tunnelDataDir ?? '')}) $settings;\n` +
    `if($mustDisable){Set-ItemProperty -LiteralPath $key -Name ProxyEnable -Type DWord -Value 0 -ErrorAction Stop;\n` +
    ` Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LaixinWinInet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }';\n` +
    ` [void][LaixinWinInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][LaixinWinInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)};\n` +
    `$after=Get-ItemProperty -LiteralPath $key -ErrorAction Stop; if($mustDisable -and [int]$after.ProxyEnable -ne 0){exit 31};`;
}

async function prepareTaskSnapshotForCompensation(snapshot, commands, native, deadlineAt, now, temporaryDirectory) {
  let current = await queryResidentTask(snapshot.task, commands, native.schtasks, deadlineAt, now);
  if (snapshot.state === 'missing') {
    if (current.state !== 'missing') await deleteResidentTask(snapshot.task, commands, native.schtasks, deadlineAt, now);
    return;
  }
  if (current.state === 'missing') {
    await recreateResidentTask(snapshot, commands, native.powershell, deadlineAt, now, temporaryDirectory);
    current = await queryResidentTask(snapshot.task, commands, native.schtasks, deadlineAt, now);
  }
  // Keep every recovered task disabled until direct-connect fallback is complete. Re-enabling first lets
  // its trigger race with the fallback and re-point WinINET immediately before we turn it off again.
  if (current.state !== 'disabled') await changeResidentTask(snapshot.task, 'disabled', commands, native.schtasks, deadlineAt, now);
}

async function finishTaskSnapshotCompensation(snapshot, commands, schtasks, deadlineAt, now) {
  if (snapshot.state === 'enabled') {
    await changeResidentTask(snapshot.task, 'enabled', commands, schtasks, deadlineAt, now);
    return;
  }
  const verified = await queryResidentTask(snapshot.task, commands, schtasks, deadlineAt, now);
  if (verified.state !== snapshot.state) throw new Error('UPDATE_RESIDENT_TASK_RESTORE_FAILED');
}

async function compensateWindowsPreflight(snapshots, options, commands, native, deadlineAt, now) {
  const failures = [];
  const attempt = async (label, action) => {
    try { await action(); } catch { failures.push(label); }
  };
  for (const snapshot of snapshots) {
    await attempt(`task-prepare:${snapshot.task}`, () => prepareTaskSnapshotForCompensation(snapshot, commands, native,
      deadlineAt, now, options.temporaryDirectory ?? process.env.TEMP ?? process.env.TMP ?? tmpdir()));
  }
  // A half-completed handoff must never strand WinINET on a loopback whose owner was just stopped.
  await attempt('proxy', async () => {
    const fallback = await boundedCommand(commands, native.powershell, encodedPowerShell(proxyFallbackScript(options.tunnelDataDir)), deadlineAt, now);
    assertNotTimedOut(fallback, 'UPDATE_PROXY_FALLBACK_TIMEOUT');
    if (fallback.code !== 0) throw new Error('UPDATE_PROXY_FALLBACK_FAILED');
  });
  for (const snapshot of snapshots) {
    await attempt(`task-finish:${snapshot.task}`, () => finishTaskSnapshotCompensation(snapshot, commands,
      native.schtasks, deadlineAt, now));
  }
  const enabled = snapshots.find(snapshot => snapshot.state === 'enabled');
  if (enabled) {
    await attempt('resident-unconfirmed', async () => {
      const run = await boundedCommand(commands, native.schtasks, ['/run', '/tn', enabled.task], deadlineAt, now);
      assertNotTimedOut(run, 'UPDATE_RESIDENT_TASK_RUN_TIMEOUT');
      if (run.code !== 0) throw new Error('UPDATE_RESIDENT_TASK_RUN_FAILED');
      let confirmed = false;
      for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
        const processes = await windowsProcesses(commands, native.powershell, deadlineAt, now);
        if (processes.some(item => normalizeWindowsPath(item.path) === normalizeWindowsPath(options.executable) &&
            /[/\\]sidecar[/\\]win[/\\]tunnel-daemon\.mjs/i.test(item.commandLine))) {
          confirmed = true;
          break;
        }
        if (attemptIndex < 4) await pause(200);
      }
      if (!confirmed) throw new Error('UPDATE_RESIDENT_UNCONFIRMED');
    });
  }
  return failures;
}

async function commitWindowsPreflight(recoveryDirectory, commands = runNative, expectedOwnerPid, expectedTransactionId,
    acquireRecoveryMutex) {
  if (!Number.isSafeInteger(expectedOwnerPid) || expectedOwnerPid < 1) {
    throw new Error('UPDATE_RECOVERY_OWNER_MISMATCH');
  }
  return withWindowsRecoveryMutex(
    () => commitWindowsPreflightLocked(recoveryDirectory, commands,
      { expectedOwnerPid, expectedTransactionId, verifyLiveOwner: true }), acquireRecoveryMutex, recoveryDirectory);
}

async function commitWindowsPreflightLocked(recoveryDirectory, commands, authorization = {}) {
  if (typeof recoveryDirectory !== 'string' || recoveryDirectory === '') throw new Error('INVALID_WINDOWS_RECOVERY_DIRECTORY');
  const paths = recoveryPaths(recoveryDirectory);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const native = {
    schtasks: win32.join(systemRoot, 'System32', 'schtasks.exe'),
    powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  };
  if (!await pathExists(paths.markerPath)) {
    if (authorization.expectedTransactionId !== undefined &&
        await recoveryCommitted(paths, { transactionId: authorization.expectedTransactionId })) return;
    throw new Error('UPDATE_RECOVERY_MARKER_MISSING');
  }
  const marker = await readRecoveryMarker(paths.markerPath);
  if (authorization.expectedOwnerPid !== undefined && marker.ownerPid !== authorization.expectedOwnerPid ||
      authorization.expectedTransactionId !== undefined && marker.transactionId !== authorization.expectedTransactionId) {
    throw new Error('UPDATE_RECOVERY_OWNER_MISMATCH');
  }
  if (authorization.verifyLiveOwner) {
    await assertLiveRecoveryOwner(marker, commands, native);
  }
  // This durable commit record turns recovery registration + marker removal into one logical transaction. If either
  // cleanup fails, both consumers see the matching commit and retry cleanup without rolling back a
  // version that has already acknowledged startup/network readiness.
  if (!await recoveryCommitted(paths, marker)) {
    await writeDurableJson(paths.commitPath, { version: 1, transactionId: marker.transactionId });
  }
  const deadline = Date.now() + 15_000;
  await clearRecoveryRun(commands, native, deadline, Date.now);
  await fs.rm(paths.readyPath, { force: true });
  await fs.rm(paths.guardStartPath, { force: true });
  await fs.rm(paths.armedPath, { force: true });
  await fs.rm(paths.guardErrorPath, { force: true });
  await fs.rm(paths.markerPath, { force: true });
}

async function assertLiveRecoveryOwner(marker, commands, native) {
  const now = Date.now;
  const processes = await windowsProcesses(commands, native.powershell, now() + 15_000, now);
  if (!processes.some(item => item.pid === marker.ownerPid &&
      normalizeWindowsPath(item.path) === normalizeWindowsPath(marker.ownerExecutable) &&
      item.startFileTime === marker.ownerStartFileTime)) {
    throw new Error('UPDATE_RECOVERY_OWNER_MISMATCH');
  }
}

async function commitWindowsPreflightCommand(recoveryDirectory, commands = runNative, expectedOwnerPid, expectedTransactionId) {
  try {
    await commitWindowsPreflight(recoveryDirectory, commands, expectedOwnerPid, expectedTransactionId);
  } catch (error) {
    const paths = recoveryPaths(recoveryDirectory);
    // Once the matching commit record is durable, cleanup-only consumers own any Run/marker residue.
    // Returning failure here would make NSIS abort after tasks were intentionally removed, even though
    // rolling the recovery transaction back is no longer correct. A missing marker means cleanup crossed
    // its atomic boundary already; a present marker is safe only when its matching commit is readable.
    if (!await pathExists(paths.markerPath)) {
      if (expectedTransactionId !== undefined &&
          await recoveryCommitted(paths, { transactionId: expectedTransactionId })) return;
      throw error;
    }
    let marker;
    try { marker = await readRecoveryMarker(paths.markerPath); } catch { throw error; }
    if (marker.ownerPid !== expectedOwnerPid ||
        expectedTransactionId !== undefined && marker.transactionId !== expectedTransactionId) throw error;
    const systemRoot = marker.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    await assertLiveRecoveryOwner(marker, commands, {
      powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    });
    if (!await recoveryCommitted(paths, marker)) throw error;
  }
}

async function recoveryCommitted(paths, marker) {
  try {
    const commit = JSON.parse(await fs.readFile(paths.commitPath, 'utf8'));
    return commit?.version === 1 && commit?.transactionId === marker.transactionId;
  } catch { return false; }
}

async function recoveryArmed(paths, marker) {
  try {
    const armed = JSON.parse(await fs.readFile(paths.armedPath, 'utf8'));
    return armed?.version === 1 && armed?.transactionId === marker.transactionId;
  } catch { return false; }
}

async function resumePriorWindowsPreflight(options, commands, native, deadlineAt, now) {
  const paths = recoveryPaths(options.recoveryDirectory);
  if (!await pathExists(paths.markerPath)) return;
  const marker = await readRecoveryMarker(paths.markerPath);
  if (normalizeWindowsPath(marker.target) !== normalizeWindowsPath(options.target) ||
      normalizeWindowsPath(marker.executable) !== normalizeWindowsPath(options.executable) ||
      marker.residentLabel !== options.residentLabel) {
    throw new Error('UPDATE_PREFLIGHT_RECOVERY_TARGET_MISMATCH');
  }
  if (!await recoveryCommitted(paths, marker) && await recoveryArmed(paths, marker)) {
    const processes = await windowsProcesses(commands, native.powershell, deadlineAt, now);
    const sameProcess = (pid, executable, startFileTime) => processes.some(item => item.pid === pid &&
      normalizeWindowsPath(item.path) === normalizeWindowsPath(executable) && item.startFileTime === startFileTime);
    if (sameProcess(marker.ownerPid, marker.ownerExecutable, marker.ownerStartFileTime) ||
        sameProcess(marker.workerPid, marker.workerExecutable, marker.workerStartFileTime)) {
      throw new Error('UPDATE_PREFLIGHT_RECOVERY_ACTIVE');
    }
    const guardCommand = marker.transactionId.toLowerCase();
    if (processes.some(item => normalizeWindowsPath(item.path) === normalizeWindowsPath(paths.guardPath) &&
        item.commandLine.toLowerCase().includes('--laixin-recovery-guard') &&
        item.commandLine.toLowerCase().includes(guardCommand))) {
      throw new Error('UPDATE_PREFLIGHT_RECOVERY_ACTIVE');
    }
  }
  // Commit residue is cleanup-only. A marker without the armed record was never allowed to mutate;
  // an abandoned armed transaction must compensate from its original snapshot before a new snapshot.
  await recoverWindowsPreflightLocked(paths.markerPath, commands, marker.transactionId);
  if (await pathExists(paths.markerPath)) throw new Error('UPDATE_PREFLIGHT_RECOVERY_ACTIVE');
}

async function verifyWindowsPreflightHandoff(target, executable, recoveryDirectory, commands = runNative) {
  const paths = recoveryPaths(recoveryDirectory);
  const marker = await readRecoveryMarker(paths.markerPath);
  if (normalizeWindowsPath(marker.target) !== normalizeWindowsPath(target) ||
      normalizeWindowsPath(marker.executable) !== normalizeWindowsPath(executable) ||
      !await recoveryArmed(paths, marker) || await recoveryCommitted(paths, marker) ||
      !alive(marker.ownerPid)) throw new Error('UPDATE_PREFLIGHT_HANDOFF_INVALID');
  const ready = (await fs.readFile(paths.readyPath, 'utf8')).trim();
  const [transactionId, guardPidText] = ready.split(':');
  const guardPid = Number(guardPidText);
  if (transactionId !== marker.transactionId || !Number.isSafeInteger(guardPid) || guardPid < 1) {
    throw new Error('UPDATE_PREFLIGHT_HANDOFF_INVALID');
  }
  const systemRoot = marker.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const native = {
    schtasks: win32.join(systemRoot, 'System32', 'schtasks.exe'),
    powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  };
  const now = Date.now;
  const deadline = now() + 15_000;
  const processes = await windowsProcesses(commands, native.powershell, deadline, now);
  const owner = processes.find(item => item.pid === marker.ownerPid);
  const guard = { pid: guardPid, executable: paths.guardPath, commandToken: '--laixin-recovery-guard',
    modeToken: WINDOWS_RECOVERY_GUARD, transactionId: marker.transactionId };
  const options = { target, executable, currentPid: process.pid, recoveryGuard: guard };
  assertManagedIdentityKnown(processes, options);
  if (normalizeWindowsPath(owner?.path) !== normalizeWindowsPath(marker.ownerExecutable) ||
      owner?.startFileTime !== marker.ownerStartFileTime ||
      !processes.some(item => isRecoveryGuardProcess(item, options)) ||
      managedProcesses(processes, options).length !== 0) throw new Error('UPDATE_PREFLIGHT_HANDOFF_INVALID');
  for (const task of marker.tasks) {
    const current = await queryResidentTask(task.task, commands, native.schtasks, deadline, now);
    if (current.state !== 'missing' && current.state !== 'disabled') {
      throw new Error('UPDATE_PREFLIGHT_HANDOFF_INVALID');
    }
  }
}

async function recoverWindowsPreflight(markerPath, commands = runNative, expectedTransactionId, acquireRecoveryMutex) {
  if (typeof expectedTransactionId !== 'string' || expectedTransactionId === '') {
    throw new Error('UPDATE_RECOVERY_TRANSACTION_MISMATCH');
  }
  return withWindowsRecoveryMutex(
    () => recoverWindowsPreflightLocked(markerPath, commands, expectedTransactionId), acquireRecoveryMutex, dirname(markerPath));
}

async function recoverWindowsPreflightLocked(markerPath, commands, expectedTransactionId) {
  const marker = await readRecoveryMarker(markerPath);
  if (marker.transactionId !== expectedTransactionId) throw new Error('UPDATE_RECOVERY_TRANSACTION_MISMATCH');
  const now = Date.now;
  const deadline = now() + WINDOWS_PREFLIGHT_TOTAL_MS;
  const systemRoot = marker.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const native = {
    schtasks: win32.join(systemRoot, 'System32', 'schtasks.exe'),
    powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  };
  const paths = recoveryPaths(dirname(markerPath));
  if (await recoveryCommitted(paths, marker)) {
    await clearRecoveryRun(commands, native, deadline, now);
    await fs.rm(paths.readyPath, { force: true });
    await fs.rm(paths.guardStartPath, { force: true });
    await fs.rm(paths.armedPath, { force: true });
    await fs.rm(paths.guardErrorPath, { force: true });
    await fs.rm(paths.markerPath, { force: true });
    return;
  }
  if (!await recoveryArmed(paths, marker)) {
    await commitWindowsPreflightLocked(dirname(markerPath), commands, { expectedTransactionId });
    return;
  }
  const failures = await compensateWindowsPreflight(marker.tasks, {
    mode: marker.mode,
    target: marker.target,
    executable: marker.executable,
    residentLabel: marker.residentLabel,
    tunnelDataDir: marker.tunnelDataDir,
    temporaryDirectory: dirname(markerPath)
  }, commands, native, deadline, now);
  if (failures.length > 0) {
    // Keep the persistent logon trigger installed when recovery itself fails. Reassert its exact value
    // so a transient task/registry denial can be retried at a later sign-in.
    try {
      await setRecoveryRun(marker, paths.launcherPath, commands, native, Date.now() + 15_000, Date.now);
    } catch { failures.push('rearm'); }
    throw new Error(`UPDATE_PREFLIGHT_RECOVERY_FAILED:${failures.join(',')}`);
  }
  // Persist the completed state before either cleanup operation. A crash/failure from here onward is
  // retried as cleanup-only and can never re-run task/proxy compensation against a newer live version.
  await writeDurableJson(paths.commitPath, { version: 1, transactionId: marker.transactionId });
  await clearRecoveryRun(commands, native, deadline, now);
  await fs.rm(paths.readyPath, { force: true });
  await fs.rm(paths.guardStartPath, { force: true });
  await fs.rm(paths.armedPath, { force: true });
  await fs.rm(paths.guardErrorPath, { force: true });
  await fs.rm(paths.markerPath, { force: true });
}

async function armWindowsPreflightRecovery(snapshots, options, commands, native, deadlineAt, now) {
  if (typeof options.recoveryDirectory !== 'string' || options.recoveryDirectory === '' ||
      !Number.isSafeInteger(options.ownerPid) || options.ownerPid < 1 ||
      normalizeWindowsPath(options.ownerExecutable) === '') {
    throw new Error('INVALID_WINDOWS_RECOVERY');
  }
  await fs.mkdir(options.recoveryDirectory, { recursive: true, mode: 0o700 });
  const paths = recoveryPaths(options.recoveryDirectory);
  if (await pathExists(paths.markerPath)) {
    throw new Error('UPDATE_PREFLIGHT_RECOVERY_ACTIVE');
  }
  await fs.rm(paths.armedPath, { force: true });
  await fs.rm(paths.readyPath, { force: true });
  await fs.rm(paths.guardStartPath, { force: true });
  await fs.rm(paths.guardErrorPath, { force: true });
  if (normalizeWindowsPath(__filename) !== normalizeWindowsPath(paths.helperPath)) {
    await fs.copyFile(__filename, paths.helperPath);
  }
  let identity;
  if (typeof options.recoveryIdentitySnapshot === 'function') {
    identity = await options.recoveryIdentitySnapshot();
  } else {
    const processes = await windowsProcesses(commands, native.powershell, deadlineAt, now);
    const owner = processes.find(item => item.pid === options.ownerPid &&
      normalizeWindowsPath(item.path) === normalizeWindowsPath(options.ownerExecutable));
    const worker = processes.find(item => item.pid === process.pid &&
      normalizeWindowsPath(item.path) === normalizeWindowsPath(options.executable));
    identity = { ownerStartFileTime: owner?.startFileTime, workerStartFileTime: worker?.startFileTime };
  }
  if (!/^\d{15,19}$/.test(identity?.ownerStartFileTime) || !/^\d{15,19}$/.test(identity?.workerStartFileTime)) {
    throw new Error('UPDATE_RECOVERY_OWNER_IDENTITY_UNKNOWN');
  }
  const transactionId = randomUUID();
  const marker = {
    version: 1,
    transactionId,
    mode: options.mode,
    target: options.target,
    executable: options.executable,
    residentLabel: options.residentLabel,
    tunnelDataDir: options.tunnelDataDir ?? '',
    ownerPid: options.ownerPid,
    ownerExecutable: options.ownerExecutable,
    ownerStartFileTime: identity.ownerStartFileTime,
    workerPid: process.pid,
    workerExecutable: options.executable,
    workerStartFileTime: identity.workerStartFileTime,
    systemRoot: options.systemRoot,
    markerPath: paths.markerPath,
    tasks: snapshots
  };
  await writeDurableFile(paths.launcherPath, recoveryLauncherScript(marker, paths.readyPath, paths.guardStartPath, paths.launcherPath, native.powershell));
  await writeDurableJson(paths.markerPath, marker);
  try {
    const customGuardLauncher = options.launchRecoveryGuard !== undefined;
    const launch = options.launchRecoveryGuard ?? defaultRecoveryGuardLauncher;
    const guardPid = await launch({
      powershell: native.powershell,
      guardSourcePath: win32.join(win32.dirname(options.executable), 'resources', 'windows-recovery-guard.exe'),
      guardPath: paths.guardPath,
      launcherPath: paths.launcherPath,
      readyPath: paths.readyPath,
      guardStartPath: paths.guardStartPath,
      guardErrorPath: paths.guardErrorPath,
      marker,
      transactionId
    });
    const confirmedGuardPid = await waitForRecoveryGuard(paths.readyPath, paths.guardStartPath, paths.guardErrorPath, transactionId, guardPid);
    await setRecoveryRun(marker, paths.launcherPath, commands, native, deadlineAt, now);
    await writeDurableJson(paths.armedPath, { version: 1, transactionId });
    const guard = customGuardLauncher
      ? { pid: confirmedGuardPid, executable: native.powershell, commandToken: paths.launcherPath,
          modeToken: '-guard', transactionId }
      : { pid: confirmedGuardPid, executable: paths.guardPath, commandToken: '--laixin-recovery-guard',
          modeToken: WINDOWS_RECOVERY_GUARD, transactionId };
    return { ...paths, guardPid: confirmedGuardPid, guard, transactionId };
  } catch (error) {
    try { await clearRecoveryRun(commands, native, deadlineAt, now); } catch { /* No mutation has happened yet. */ }
    await fs.rm(paths.markerPath, { force: true }).catch(() => undefined);
    await fs.rm(paths.readyPath, { force: true }).catch(() => undefined);
    await fs.rm(paths.guardStartPath, { force: true }).catch(() => undefined);
    await fs.rm(paths.armedPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function windowsPreflight(options, commands = runNative) {
  return withWindowsRecoveryMutex(
    () => windowsPreflightLocked(options, commands), options?.acquireRecoveryMutex, options?.recoveryDirectory);
}

async function windowsPreflightLocked(options, commands) {
  const target = normalizeWindowsPath(options?.target);
  const executable = normalizeWindowsPath(options?.executable);
  if (!['update', 'uninstall'].includes(options?.mode) || target === '' || executable === '' ||
      normalizeWindowsPath(win32.dirname(options.executable)) !== target ||
      typeof options?.residentLabel !== 'string' || options.residentLabel === '') {
    throw new Error('INVALID_WINDOWS_PREFLIGHT');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  const workDeadline = startedAt + WINDOWS_PREFLIGHT_WORK_MS;
  const totalDeadline = startedAt + WINDOWS_PREFLIGHT_TOTAL_MS;
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const schtasks = win32.join(systemRoot, 'System32', 'schtasks.exe');
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const native = { schtasks, powershell };
  if (options.recoveryDirectory !== undefined || options.ownerPid !== undefined) {
    if (typeof options.recoveryDirectory !== 'string' || options.recoveryDirectory === '') {
      throw new Error('INVALID_WINDOWS_RECOVERY');
    }
    await resumePriorWindowsPreflight(options, commands, native, workDeadline, now);
  }
  const snapshots = [];
  for (const task of [`\\Laixin\\${options.residentLabel}`, options.residentLabel]) {
    snapshots.push(await queryResidentTask(task, commands, schtasks, workDeadline, now));
  }
  let recovery;
  if (options.recoveryDirectory !== undefined || options.ownerPid !== undefined) {
    recovery = await armWindowsPreflightRecovery(snapshots, options, commands, native, workDeadline, now);
  }
  const guardedOptions = recovery === undefined
    ? options
    : { ...options, recoveryGuard: recovery.guard };
  let mutated = false;
  try {
    // Disable (do not delete) first in both modes. It closes the one-minute relaunch race while keeping
    // uninstall rollback possible until all managed processes are safely gone.
    for (const snapshot of snapshots) {
      if (snapshot.state === 'missing') continue;
      mutated = true;
      await changeResidentTask(snapshot.task, 'disabled', commands, schtasks, workDeadline, now);
    }
    const before = await windowsProcesses(commands, powershell, workDeadline, now);
    assertManagedIdentityKnown(before, guardedOptions);
    if (recovery !== undefined && !before.some(item => isRecoveryGuardProcess(item, guardedOptions))) {
      throw new Error('UPDATE_RECOVERY_GUARD_IDENTITY_LOST');
    }
    for (const processEntry of managedProcesses(before, guardedOptions)) {
      mutated = true;
      await stopManagedProcess(processEntry, commands, powershell, workDeadline, now);
    }
    const after = await windowsProcesses(commands, powershell, workDeadline, now);
    assertManagedIdentityKnown(after, guardedOptions);
    if (managedProcesses(after, guardedOptions).length > 0) throw new Error('UPDATE_MANAGED_PROCESS_STILL_RUNNING');
    if (options.mode === 'uninstall') {
      for (const snapshot of snapshots) {
        if (snapshot.state === 'missing') continue;
        mutated = true;
        await deleteResidentTask(snapshot.task, commands, schtasks, workDeadline, now);
      }
    }
  } catch (error) {
    const failures = mutated
      ? await compensateWindowsPreflight(snapshots, options, commands, native, totalDeadline, now)
      : [];
    if (failures.length === 0 && recovery !== undefined) {
      try { await commitWindowsPreflightLocked(options.recoveryDirectory, commands,
        { expectedOwnerPid: options.ownerPid, expectedTransactionId: recovery.transactionId }); }
      catch { failures.push('recovery-disarm'); }
    }
    if (failures.length > 0) {
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(`UPDATE_PREFLIGHT_COMPENSATION_FAILED:${original}:${failures.join(',')}`, { cause: error });
    }
    throw error;
  }
}

async function run(job, commands = exec) {
  if (!Number.isSafeInteger(job.parentPid) || job.parentPid < 1 || job.platform !== 'mac' ||
      !/^\d+\.\d+\.\d+(?:-unified\.\d+)?$/.test(job.version) || !/^[a-f0-9]{64}$/.test(job.asarSha256) || !/^[a-f0-9]{64}$/.test(job.assetSha256)) throw new Error('INVALID_UPDATE_JOB');
  const result = value => fs.writeFile(job.result, JSON.stringify({ version: job.version, ...value }), { mode: 0o600 });
  const launch = async () => {
    const args = ['-n', '-a', job.target, '--args', `--user-data-dir=${job.userData}`];
    await commands('/usr/bin/open', args, { env: cleanEnv, timeout: 15_000 });
  };
  const appRunning = async () => {
    const { stdout } = await commands('/bin/ps', ['-axo', 'pid=,command=']);
    return stdout.split('\n').some(line => {
      const match = /^\s*(\d+) (.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) return false;
      if (match[2] !== job.executable && !match[2].startsWith(job.executable + ' ')) return false;
      // 随包的守护与内核看门狗都是拿主程序当 node 跑的（ELECTRON_RUN_AS_NODE + sidecar 里的 .mjs），
      // 命令行前缀与主程序一模一样。常驻守护在界面退出后还活着，按前缀算就是「应用又被打开了」，
      // 每次更新都会停在 UPDATE_APP_REOPENED——装了常驻之后 mac 根本更新不了。这里把它们排掉：
      // 判据是参数里带着 sidecar 目录下的 .mjs，真正的应用进程 ⛔ 有这种参数。
      return !RUNS_SIDECAR_SCRIPT.test(match[2].slice(job.executable.length));
    });
  };
  await fs.rm(job.acknowledgement, { force: true });
  await fs.writeFile(job.ready, 'ready', { mode: 0o600 });
  const deadline = Date.now() + 30_000;
  while (alive(job.parentPid)) {
    if (Date.now() >= deadline) { await result({ state: 'error', message: '工具箱尚未完成退出，更新已取消。' }); return; }
    await pause(100);
  }
  let backup, next, swapped = false, stage = 'prepare';
  try {
    if ((await fs.stat(job.installer)).size !== job.assetSize || await digest(job.installer) !== job.assetSha256) throw new Error('UPDATE_ASSET_CHANGED');
    {
      const suffix = randomUUID();
      backup = join(dirname(job.target), `.laixin-previous-${suffix}.app`);
      next = join(dirname(job.target), `.laixin-next-${suffix}.app`);
      await commands('/usr/bin/ditto', [job.staged, next], { timeout: 120_000 });
      await commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', next], { timeout: 60_000 });
      if (await digest(join(next, 'Contents', 'Resources', 'app.asar')) !== job.asarSha256) throw new Error('UPDATE_STAGE_CHANGED');
      // 新包已验完、马上要换 bundle：这时候才停常驻守护，验不过的包 ⛔ 白白把客户的网停一次。
      await handOffResident(job, commands);
      if (await appRunning()) throw new Error('UPDATE_APP_REOPENED');
      stage = 'replace';
      await fs.rename(job.target, backup);
      try { await fs.rename(next, job.target); swapped = true; }
      catch (error) { await fs.rename(backup, job.target); throw error; }
    }
    stage = 'launch';
    await launch();
    stage = 'startup';
    // 等回执的上限由主进程按「更新前客户连着没有」定:没连着照旧 45 秒;连着的要容下
    // 「新版起来 → 装常驻 → 首连(守护自己还有 42 秒的退避梯子)」,再留时间给新版让台。
    const startupDeadline = Date.now() + (Number.isSafeInteger(job.startupTimeoutMs) && job.startupTimeoutMs > 0 ? job.startupTimeoutMs : 45_000);
    let started = false;
    while (Date.now() < startupDeadline) {
      try { started = JSON.parse(await fs.readFile(job.acknowledgement, 'utf8')).version === job.version; } catch { /* Startup has not acknowledged yet. */ }
      if (started) break;
      await pause(200);
    }
    if (!started) throw new Error('UPDATE_STARTUP_UNCONFIRMED');
    // Keep the previous application as a recoverable update backup, never touch user account/config data.
    if (backup) {
      const retained = join(dirname(job.result), `previous-${Date.now()}.app`);
      try { await fs.rename(backup, retained); backup = retained; } catch { /* The old app stays at its same-volume backup path. */ }
      await pruneOldBackups(dirname(job.result), backup);
    }
    await result({ state: 'complete', message: '工具箱已更新，账号和配置已保留。', backup: backup ?? '' });
    await fs.rm(join(dirname(job.result), 'pending.json'), { force: true });
  } catch {
    if (swapped && backup) {
      // A slow but running new app must not be moved underneath its process.
      // 新版「起来了但连不上」时会自己退出让台(它不写回执、先记下这一版别再自动装),
      // 而退出要几秒。⛔ 只看一眼就定:那会把本该回退的这一次判成「进程还在」,客户留在连不上的新版上。
      let running = true;
      try {
        const waitUntil = Date.now() + 10_000;
        do { running = await appRunning(); if (!running) break; await pause(250); } while (Date.now() < waitUntil);
      } catch { /* Unknown process state keeps both copies in place. */ }
      if (running) {
        await result({ state: 'error', message: '新版启动尚未确认，原程序副本已保留。', stage, backup });
        return;
      }
      try {
        await fs.rename(job.target, join(dirname(job.target), `.laixin-failed-${Date.now()}.app`));
        await fs.rename(backup, job.target);
      } catch { /* Preserve both copies for recovery if replacement is denied. */ }
    }
    await result({ state: 'error', message: '更新未完成，已保留原程序和账号配置，请重试。', stage, backup: backup ?? '' });
    try { await launch(); } catch { /* Result remains readable on the next manual launch. */ }
  }
}

// 更新时的常驻交接（0.5.0）。
//
// mac 是原地换 bundle：路径不变，所以 LaunchAgent 里的路径换完还是对的。真正会出事的是**跑着的那个守护**——
// 它是旧版的代码，换完 bundle 之后再去起内核，拿到的是新版的 xray-runner 与内核；两个版本混着跑，
// 而且客户更新完永远还用着旧守护（它不退出就永远不换代）。所以按派题里「更新前先停常驻」那条走：
//   1) 先把「客户本来是连着的」这件事记下来（resume-on-launch 标记，tunnel-service 认这个）——
//      因为下一步 bootout 会让守护按正常关停流程把意图写成 shutdown，不先记就变成「更新完不再连」；
//   2) launchctl bootout：给守护发 SIGTERM，它走完整还原后退出（0），系统 ⛔ 再拉起；
//   3) 换 bundle、起新版；新版启动时按 resume 标记接着连，并重新装上常驻。
// 全程 ⛔ 抛异常：常驻停不掉也要让更新继续（最坏是旧守护活到下次重启），⛔ 因为这一步把更新卡死。
async function handOffResident(job, commands) {
  const outcome = { resumeMarked: false, stopped: false };
  if (job.platform !== 'mac') return outcome;
  if (typeof job.tunnelDataDir === 'string' && job.tunnelDataDir !== '') {
    // 「客户本来是连着的」以工具箱退出前拍下的那一眼为准（job.tunnelResume）：等到这里，工具箱自己的
    // 退出流程可能已经把意图文件改成 shutdown 了。再读一次文件只是兜底（快照没拍到时还有一次机会）。
    let resume = job.tunnelResume === true;
    if (!resume) {
      try { resume = JSON.parse(await fs.readFile(join(job.tunnelDataDir, 'intent.json'), 'utf8')).desired === 'connected'; }
      catch { /* 没有意图文件 = 客户本来就没连着，更新完也不该自己连上。 */ }
    }
    if (resume) {
      try {
        await fs.writeFile(join(job.tunnelDataDir, 'resume-on-launch'), `${JSON.stringify({ at: Date.now() })}\n`, { mode: 0o600 });
        outcome.resumeMarked = true;
      } catch { /* 标记写不进去,最坏是客户更新完要自己点一次连接 ⛔ 因此把更新卡死。 */ }
    }
  }
  if (typeof job.residentLabel === 'string' && job.residentLabel !== '') {
    try {
      // bootout 会等服务真的停掉再返回（超时才 SIGKILL），所以这里不用再自己轮询守护进程。
      await commands('/usr/bin/launchctl', ['bootout', `gui/${String(process.getuid ? process.getuid() : 0)}/${job.residentLabel}`], { timeout: 40_000 });
      outcome.stopped = true;
    } catch { /* 没装常驻、或已经停了：bootout 一律报错，这里不是失败。 */ }
  }
  return outcome;
}

// 更新成功确认后只保留最近一份可回退备份,⛔ previous-*.app 随更新次数无限累积。
async function pruneOldBackups(directory, keep) {
  try {
    const entries = await fs.readdir(directory);
    const stampOf = name => Number(/^previous-(\d+)\.app$/.exec(name)[1]);
    const backups = entries.filter(name => /^previous-\d+\.app$/.test(name)).sort((left, right) => stampOf(left) - stampOf(right));
    for (const name of backups.slice(0, -1)) await fs.rm(join(directory, name), { recursive: true, force: true });
    void keep;
  } catch { /* 清理失败不影响本次更新结果。 */ }
}

async function main() {
  if (process.argv[2] === 'windows-preflight') {
    const mode = process.argv[3];
    const jobPath = process.argv[4];
    const source = jobPath
      ? JSON.parse(await fs.readFile(jobPath, 'utf8'))
      : {
          target: process.env.LAIXIN_PREFLIGHT_TARGET,
          executable: process.env.LAIXIN_PREFLIGHT_EXECUTABLE,
          residentLabel: process.env.LAIXIN_PREFLIGHT_RESIDENT_LABEL
        };
    const recoveryDirectory = jobPath
      ? dirname(source.result)
      : process.env.LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY;
    const ownerPid = Number(process.env.LAIXIN_PREFLIGHT_OWNER_PID);
    await windowsPreflight({ mode, target: source.target, executable: source.executable,
      residentLabel: source.residentLabel, recoveryDirectory, ownerPid,
      tunnelDataDir: jobPath ? source.tunnelDataDir : process.env.LAIXIN_PREFLIGHT_TUNNEL_DIRECTORY,
      ownerExecutable: process.env.LAIXIN_PREFLIGHT_OWNER_EXECUTABLE });
    return;
  }
  if (process.argv[2] === 'windows-preflight-recover') {
    await recoverWindowsPreflight(process.argv[3], runNative, process.argv[4]);
    return;
  }
  if (process.argv[2] === 'windows-preflight-handoff') {
    await verifyWindowsPreflightHandoff(process.argv[3], process.argv[4], process.argv[5]);
    return;
  }
  if (process.argv[2] === 'windows-preflight-commit') {
    await commitWindowsPreflightCommand(process.argv[3], runNative, Number(process.argv[4]), process.argv[5]);
    return;
  }
  await run(JSON.parse(await fs.readFile(process.argv[2], 'utf8')));
}

if (require.main === module) main().catch(async error => {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]+(?::|$)/.exec(message)?.[0]?.replace(/:$/, '') ??
    (error && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'UPDATE_HELPER_FAILED');
  const win32Error = /^UPDATE_RECOVERY_DURABLE_RENAME_FAILED:WIN32_(\d+)$/.exec(message)?.[1];
  const guardWaitMs = /^UPDATE_RECOVERY_GUARD_TIMEOUT:WAITED_MS_(\d+)$/.exec(message)?.[1];
  const guardReason = /^UPDATE_RECOVERY_GUARD_FAILED:(UPDATE_RECOVERY_GUARD_[A-Z_]+)$/.exec(message)?.[1];
  const line = `${new Date().toISOString()} ${code}${win32Error === undefined ? '' : ` WIN32_${win32Error}`}${guardWaitMs === undefined ? '' : ` WAITED_MS=${guardWaitMs}`}${guardReason === undefined ? '' : ` GUARD_REASON=${guardReason}`}\n`;
  try { process.stderr.write(line); } catch { /* The exit code still reaches the installer. */ }
  if (process.argv[2] === 'windows-preflight' && process.env.LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY) {
    try {
      const directory = process.env.LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(join(directory, 'windows-preflight-last-error.log'), line, { mode: 0o600 });
    } catch { /* Reporting failure must not mask the original preflight failure. */ }
  }
  process.exitCode = 1;
});
module.exports = { run, pruneOldBackups, handOffResident, windowsPreflight, recoverWindowsPreflight,
  commitWindowsPreflight, commitWindowsPreflightCommand, verifyWindowsPreflightHandoff,
  defaultRecoveryGuardLauncher, runNative, decodeNativeOutput, disableTaskXml, proxyFallbackScript };
