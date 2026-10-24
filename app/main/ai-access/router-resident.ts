import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const run = promisify(execFile)
const commandTimeoutMs = 8_000
const managedDefinitionMaxBytes = 128 * 1024
export const AI_ROUTER_ARGUMENT = '--laixin-ai-router'
export const AI_ROUTER_CLEANUP_ARGUMENT = '--laixin-ai-router-cleanup'
export const AI_ROUTER_LABEL = 'cn.laixin.toolbox.ai-router'
export const AI_ROUTER_TASK = `\\Laixin\\${AI_ROUTER_LABEL}`

export interface AiRouterResidentSpec {
  readonly executable: string
  readonly logDir: string
  /** Unpackaged tests also need the app entry path. Production is flag-only. */
  readonly appPath?: string
}

interface AiRouterWinTaskAction {
  readonly execute: string
  readonly arguments: string
  readonly workingDirectory: string
  readonly runLevel: string
}

const xml = (value: string): string => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
const args = (spec: AiRouterResidentSpec): readonly string[] => [...(spec.appPath ? [spec.appPath] : []), AI_ROUTER_ARGUMENT]
const winQuote = (value: string): string => value.replace(/'/g, "''")

function aiRouterWinTaskAction(spec: AiRouterResidentSpec): AiRouterWinTaskAction {
  return {
    execute: spec.executable,
    arguments: args(spec).map(value => `"${value.replace(/"/g, '""')}"`).join(' '),
    workingDirectory: spec.logDir,
    runLevel: 'LeastPrivilege'
  }
}

export function aiRouterMacPlist(spec: AiRouterResidentSpec): string {
  const entries = [spec.executable, ...args(spec)].map(value => `    <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AI_ROUTER_LABEL}</string>
  <key>ProgramArguments</key><array>
${entries}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(join(spec.logDir, 'ai-router.log'))}</string>
</dict></plist>
`
}

/** Task Scheduler parses Command and Arguments separately; spaces in Command need no cmd.exe wrapper. */
export function aiRouterWinTaskXml(spec: AiRouterResidentSpec): string {
  const action = aiRouterWinTaskAction(spec)
  // Windows can reject a LogonTrigger from a standard-user process. The per-user repeating trigger
  // preserves restart recovery without requiring elevation; IgnoreNew keeps a live router singular.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>${xml(AI_ROUTER_TASK)}</URI><Description>来信 AI 多模型路由</Description></RegistrationInfo>
  <Triggers><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(action.execute)}</Command><Arguments>${xml(action.arguments)}</Arguments><WorkingDirectory>${xml(action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>
`
}

async function bounded(file: string, argv: string[]): Promise<void> {
  await run(file, argv, { timeout: commandTimeoutMs, windowsHide: true })
}

async function readWindowsAiRouterTask(): Promise<boolean> {
  let stdout: string
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; $errors = @(); $tasks = @(Get-ScheduledTask -TaskName '${AI_ROUTER_LABEL}' -TaskPath '\\Laixin\\' -ErrorAction SilentlyContinue -ErrorVariable +errors); if ($tasks.Count -gt 1) { throw 'AI router task query ambiguous' }; if ($tasks.Count -eq 1) { [Console]::Out.Write('{"exists":true}'); exit 0 }; $unexpected = @($errors | Where-Object { $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound }); if ($unexpected.Count -gt 0) { throw $unexpected[0] }; [Console]::Out.Write('{"exists":false}')`],
    { timeout: commandTimeoutMs, windowsHide: true })
    stdout = typeof result === 'string' ? result : result.stdout
  } catch (error) { throw new Error('AI_ROUTER_RESIDENT_TASK_STATE_UNKNOWN', { cause: error }) }
  let value: unknown
  try { value = JSON.parse(stdout) } catch (error) { throw new Error('AI_ROUTER_RESIDENT_TASK_STATE_UNKNOWN', { cause: error }) }
  if (!value || typeof value !== 'object' || typeof (value as { exists?: unknown }).exists !== 'boolean') {
    throw new Error('AI_ROUTER_RESIDENT_TASK_STATE_UNKNOWN')
  }
  return (value as { exists: boolean }).exists
}

function isAccessDenied(error: unknown): boolean {
  return /access is denied|access denied|拒绝访问|0x80070005/i.test(String((error as Error).message))
}

async function readWindowsAiRouterTaskAction(): Promise<AiRouterWinTaskAction | undefined> {
  let stdout: string
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
      `$t = Get-ScheduledTask -TaskName '${winQuote(AI_ROUTER_LABEL)}' -TaskPath '\\Laixin\\' -ErrorAction Stop; ` +
      `if ($t.Actions.Count -ne 1) { exit 2 }; $a = $t.Actions[0]; ` +
      `ConvertTo-Json -Compress @{ execute = $a.Execute; arguments = $a.Arguments; workingDirectory = [string]$a.WorkingDirectory; runLevel = [string]$t.Principal.RunLevel }`],
    { timeout: commandTimeoutMs, windowsHide: true })
    stdout = typeof result === 'string' ? result : result.stdout
  } catch { return undefined }
  try {
    const value = JSON.parse(stdout) as Partial<AiRouterWinTaskAction>
    if (typeof value.execute !== 'string' || typeof value.arguments !== 'string' || typeof value.workingDirectory !== 'string' ||
      typeof value.runLevel !== 'string') return undefined
    return { execute: value.execute, arguments: value.arguments, workingDirectory: value.workingDirectory, runLevel: value.runLevel }
  } catch { return undefined }
}

function sameWindowsAiRouterTaskAction(actual: AiRouterWinTaskAction | undefined, expected: AiRouterWinTaskAction): boolean {
  return actual?.execute === expected.execute && actual.arguments === expected.arguments && actual.workingDirectory === expected.workingDirectory &&
    actual.runLevel === expected.runLevel
}

function missingResident(error: unknown): boolean {
  return /could not find|no such process|not found|service is not loaded/i.test(String((error as Error).message))
}

/** These two OS-owned definitions must never write through a link or a non-file endpoint. */
async function ensureSafeDirectory(path: string, create = true): Promise<boolean> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { await lstat(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AI_ROUTER_RESIDENT_PATH_INVALID', { cause: error })
      if (!create) return false
      await mkdir(current, { mode: 0o700 })
    }
    const info = await lstat(current)
    // macOS exposes /var, /tmp and /etc as immutable aliases into /private. They are outside
    // the per-user path we manage; every descendant remains checked individually.
    const systemAlias = process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current)
    if ((!info.isDirectory() && !systemAlias) || (info.isSymbolicLink() && !systemAlias)) throw new Error('AI_ROUTER_RESIDENT_PATH_INVALID')
  }
  return true
}

async function managedFileState(path: string): Promise<'missing' | 'regular'> {
  try {
    const info = await lstat(path)
    if (info.isFile() && !info.isSymbolicLink() && info.size <= managedDefinitionMaxBytes) return 'regular'
    throw new Error('AI_ROUTER_RESIDENT_PATH_INVALID')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readManagedFile(path: string): Promise<Buffer | undefined> {
  await ensureSafeDirectory(dirname(path))
  if (await managedFileState(path) === 'missing') return undefined
  return await readFile(path)
}

async function writeManagedFile(path: string, contents: string | Buffer): Promise<void> {
  if (Buffer.byteLength(contents) > managedDefinitionMaxBytes) throw new Error('AI_ROUTER_RESIDENT_PATH_INVALID')
  await ensureSafeDirectory(dirname(path))
  await managedFileState(path)
  const temporary = join(dirname(path), `.laixin-ai-router-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    await managedFileState(path)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeManagedFile(path: string): Promise<void> {
  if (!(await ensureSafeDirectory(dirname(path), false))) return
  if (await managedFileState(path) === 'regular') await rm(path)
}

export function aiRouterMacAgentPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${AI_ROUTER_LABEL}.plist`)
}

export async function installAiRouterResident(spec: AiRouterResidentSpec, platform = process.platform, home = homedir()): Promise<void> {
  await ensureSafeDirectory(spec.logDir)
  if (platform === 'darwin') {
    const path = aiRouterMacAgentPath(home)
    const content = aiRouterMacPlist(spec)
    const previous = await readManagedFile(path)
    const previousText = previous?.toString('utf8')
    if (previousText === content) {
      try { await bounded('launchctl', ['print', `gui/${String(process.getuid?.() ?? 0)}/${AI_ROUTER_LABEL}`]); return } catch { /* unloaded */ }
    }
    await writeManagedFile(path, content)
    try { await bounded('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}/${AI_ROUTER_LABEL}`]) }
    catch (error) {
      if (!missingResident(error)) {
        if (previous === undefined) await removeManagedFile(path)
        else await writeManagedFile(path, previous)
        throw error
      }
    }
    try { await bounded('launchctl', ['bootstrap', `gui/${String(process.getuid?.() ?? 0)}`, path]) }
    catch (error) {
      if (previous === undefined) await removeManagedFile(path)
      else {
        await writeManagedFile(path, previous)
        try { await bounded('launchctl', ['bootstrap', `gui/${String(process.getuid?.() ?? 0)}`, path]) }
        catch (rollbackError) { throw new Error('AI_ROUTER_RESIDENT_ROLLBACK_FAILED', { cause: rollbackError }) }
      }
      throw error
    }
    return
  }
  if (platform === 'win32') {
    const path = join(spec.logDir, 'ai-router-task.xml')
    await writeManagedFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(aiRouterWinTaskXml(spec), 'utf16le')]))
    try {
      try {
        await bounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$ErrorActionPreference = 'Stop'; Register-ScheduledTask -TaskName '${AI_ROUTER_LABEL}' -TaskPath '\\Laixin\\' -Xml ([IO.File]::ReadAllText('${winQuote(path)}')) -Force`])
        await bounded('schtasks.exe', ['/query', '/tn', AI_ROUTER_TASK])
      } catch (error) {
        if (!isAccessDenied(error)) throw error
        // A task created by an earlier elevated run cannot be replaced by a standard process. Reuse
        // it only when the complete launch action and least-privilege principal still match.
        if (sameWindowsAiRouterTaskAction(await readWindowsAiRouterTaskAction(), aiRouterWinTaskAction(spec))) return
        throw new Error('AI_ROUTER_RESIDENT_TASK_PERMISSION_DENIED', { cause: error })
      }
    } finally { await removeManagedFile(path) }
    return
  }
  throw new Error('AI_ROUTER_PLATFORM_UNSUPPORTED')
}

export async function wakeAiRouterResident(platform = process.platform): Promise<void> {
  if (platform === 'darwin') await bounded('launchctl', ['kickstart', `gui/${String(process.getuid?.() ?? 0)}/${AI_ROUTER_LABEL}`])
  else if (platform === 'win32') await bounded('schtasks.exe', ['/run', '/tn', AI_ROUTER_TASK])
  else throw new Error('AI_ROUTER_PLATFORM_UNSUPPORTED')
}

export async function removeAiRouterResident(platform = process.platform, home = homedir()): Promise<void> {
  if (platform === 'darwin') {
    await bounded('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}/${AI_ROUTER_LABEL}`]).catch(error => {
      if (!missingResident(error)) throw error
    })
    await removeManagedFile(aiRouterMacAgentPath(home))
  } else if (platform === 'win32') {
    let deletionError: unknown
    try { await bounded('schtasks.exe', ['/delete', '/tn', AI_ROUTER_TASK, '/f']) }
    catch (error) { deletionError = error }
    const stillPresent = await readWindowsAiRouterTask()
    if (!stillPresent) return
    if (deletionError !== undefined) throw deletionError
    throw new Error('AI_ROUTER_RESIDENT_TASK_STILL_PRESENT')
  }
}
