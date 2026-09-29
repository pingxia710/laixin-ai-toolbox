import { execFile as execFileCallback } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { AiAccessShell } from './service'
import type { ConfigurationExecutionContext } from './configuration-target'

const execFile = promisify(execFileCallback)
const shells: readonly AiAccessShell[] = ['codex', 'claude', 'hermes']

export type ConfigurationExecutionObservation = Readonly<Partial<Record<AiAccessShell, ConfigurationExecutionContext>>>
type Presence = 'present' | 'absent' | 'unknown'

type RunCommand = (command: string, args: readonly string[], options?: { readonly timeoutMs?: number }) => Promise<string>

export interface ConfigurationExecutionObserverOptions {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** Test seam. Production never reads configuration contents; it only checks fixed policy locations. */
  readonly policyFilePresence?: (path: string) => Promise<Presence>
  /** Test seam. Command output is classified in-process and never returned or logged. */
  readonly run?: RunCommand
  /** Test seam. Production reads only bounded, regular local startup files and never executes them. */
  readonly readStartupFile?: (path: string) => Promise<string | undefined>
  /** Test seam for the Windows process-detail cache clock and the result time window. */
  readonly now?: () => number
  /**
   * API-11: a completed observation answers later calls that begin within this many milliseconds
   * of its completion; 0 (the default) keeps the previous observe-on-every-call behavior. The
   * window only widens the existing moment-in-time race of any single observation; a failed
   * observation is never cached, so the next call observes again and stays fail-closed.
   */
  readonly ttlMs?: number
}

/** Production time window for reusing one observation across status reads. */
export const configurationObservationTtlMs = 10_000

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** A process keeps its executable and command line for its whole life; only PID reuse can change them. */
const windowsProcessDetailTtlMs = 60_000

interface WindowsProcessDetail {
  readonly image: string
  readonly path?: string
  readonly commandLine?: string
  readonly at: number
}

/**
 * Observes only facts that can make a Toolbox configuration write ineffective. It deliberately
 * never reads policy/configuration contents or exposes process command lines. A policy or launch
 * inspection that cannot be completed blocks the affected target instead of falling back to a
 * guessed user directory.
 */
export function createConfigurationExecutionObserver(options: ConfigurationExecutionObserverOptions): () => Promise<ConfigurationExecutionObservation> {
  const policyFilePresence = options.policyFilePresence ?? defaultPolicyFilePresence
  const run = options.run ?? defaultRun
  const readStartupFile = options.readStartupFile ?? defaultStartupFileReader
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 0
  const windowsDetails = new Map<string, WindowsProcessDetail>()
  let inFlight: Promise<ConfigurationExecutionObservation> | undefined
  let cached: { readonly at: number; readonly value: ConfigurationExecutionObservation } | undefined
  return async () => {
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.value
    if (inFlight !== undefined) return inFlight
    const observation = (async () => {
      const [policies, startupRoots, processes] = await Promise.all([
        observeManagedPolicies(options.platform, policyFilePresence, run),
        observeStartupConfigurationRoots(options.platform, options.home, readStartupFile),
        observeProcessOverrides(options.platform, options.home, run, windowsDetails, now)
      ])
      const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
      for (const shell of shells) {
        const policy = policies[shell]
        if (policy === 'present') {
          result[shell] = { source: 'observed', managed: true }
          continue
        }
        if (policy === 'unknown') {
          result[shell] = { source: 'unknown' }
          continue
        }
        const process = processes[shell]
        if (process !== undefined) {
          result[shell] = process
          continue
        }
        const startupRoot = startupRoots[shell]
        if (startupRoot !== undefined) result[shell] = startupRoot
      }
      return result
    })()
    inFlight = observation
    try {
      const value = await observation
      cached = { at: now(), value }
      return value
    } finally { if (inFlight === observation) inFlight = undefined }
  }
}

async function observeManagedPolicies(
  platform: NodeJS.Platform,
  filePresence: (path: string) => Promise<Presence>,
  run: (command: string, args: readonly string[]) => Promise<string>
): Promise<Record<AiAccessShell, Presence>> {
  const result: Record<AiAccessShell, Presence> = { codex: 'absent', claude: 'absent', hermes: 'absent' }
  if (platform === 'darwin') {
    const domains = await managedMacProfileDomains(run)
    result.claude = await anyPresence([
      () => filePresence('/Library/Application Support/ClaudeCode/managed-settings.json'),
      () => Promise.resolve(domains.claude)
    ])
    result.codex = domains.codex
    return result
  }
  if (platform === 'linux') {
    result.claude = await filePresence('/etc/claude-code/managed-settings.json')
    result.codex = await anyPresence([
      () => filePresence('/etc/codex/managed_config.toml'),
      () => filePresence('/etc/codex/requirements.toml')
    ])
    return result
  }
  if (platform === 'win32') {
    result.claude = await anyPresence([
      () => filePresence(win32.join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json')),
      () => commandPresence(run, 'C:\\Windows\\System32\\reg.exe', ['QUERY', 'HKLM\\SOFTWARE\\Policies\\ClaudeCode']),
      () => commandPresence(run, 'C:\\Windows\\System32\\reg.exe', ['QUERY', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode'])
    ])
    result.codex = await anyPresence([
      () => filePresence(win32.join('C:\\ProgramData', 'OpenAI', 'Codex', 'managed_config.toml')),
      () => filePresence(win32.join('C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml'))
    ])
    return result
  }
  return { codex: 'unknown', claude: 'unknown', hermes: 'unknown' }
}

/**
 * `defaults read com.vendor.product` is deliberately not used here: it succeeds for ordinary
 * user preferences and is not proof of MDM. `profiles` exposes installed configuration profiles,
 * so only an actual profile carrying the documented preference domain blocks automatic writes.
 */
async function managedMacProfileDomains(
  run: (command: string, args: readonly string[]) => Promise<string>
): Promise<Pick<Record<AiAccessShell, Presence>, 'codex' | 'claude'>> {
  try {
    // The summary omits payload preference domains. XML is retained only long enough to search
    // for the two fixed vendor domains and is never returned, logged or persisted.
    const output = await run('/usr/bin/profiles', ['show', '-type', 'configuration', '-output', 'stdout-xml'])
    return {
      codex: output.includes('com.openai.codex') ? 'present' : 'absent',
      claude: output.includes('com.anthropic.claudecode') ? 'present' : 'absent'
    }
  } catch {
    return { codex: 'unknown', claude: 'unknown' }
  }
}

/**
 * Finder-launched Toolbox processes do not inherit a terminal's startup exports. Read the small,
 * fixed startup-file set without executing it, so a custom configuration root is neither missed
 * nor guessed from the Toolbox's own environment. Ambiguous syntax, conflicting roots, symlinks
 * and unreadable files become an unknown target rather than a write to the default directory.
 */
async function observeStartupConfigurationRoots(
  platform: NodeJS.Platform,
  home: string,
  read: (path: string) => Promise<string | undefined>
): Promise<ConfigurationExecutionObservation> {
  if (platform !== 'darwin' && platform !== 'linux') return {}
  const files = [
    join(home, '.zshenv'),
    join(home, '.zprofile'),
    join(home, '.zshrc'),
    join(home, '.bash_profile'),
    join(home, '.bashrc'),
    join(home, '.profile'),
    join(home, '.config', 'fish', 'config.fish')
  ]
  const assignments: Record<AiAccessShell, string[] | undefined> = {
    codex: [], claude: [], hermes: []
  }
  try {
    for (const path of files) {
      const contents = await read(path)
      if (contents === undefined) continue
      for (const assignment of startupRootAssignments(contents, home)) {
        const shell = assignment.name === 'CODEX_HOME' ? 'codex'
          : assignment.name === 'CLAUDE_CONFIG_DIR' ? 'claude' : 'hermes'
        if (assignment.value === undefined) assignments[shell] = undefined
        else if (assignments[shell] !== undefined) assignments[shell].push(assignment.value)
      }
    }
  } catch {
    return unknownAll()
  }
  const defaults: Record<AiAccessShell, string> = {
    codex: join(home, '.codex'),
    claude: join(home, '.claude'),
    hermes: join(home, '.hermes')
  }
  const names: Record<AiAccessShell, string> = {
    codex: 'config.toml', claude: 'settings.json', hermes: '.env'
  }
  const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
  for (const shell of shells) {
    const values = assignments[shell]
    if (values === undefined) {
      result[shell] = { source: 'unknown' }
      continue
    }
    const unique = [...new Set(values)]
    if (unique.length === 0 || unique.every(value => value === defaults[shell])) continue
    // A profile that can select more than one root has no single safe automatic target.
    if (unique.length !== 1) {
      result[shell] = { source: 'unknown' }
      continue
    }
    result[shell] = { source: 'observed', userConfigPath: join(unique[0], names[shell]) }
  }
  return result
}

interface StartupRootAssignment {
  readonly name: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR' | 'HERMES_HOME'
  /** An unrecognised expansion is deliberately represented as unknown rather than returned. */
  readonly value: string | undefined
}

function startupRootAssignments(contents: string, home: string): readonly StartupRootAssignment[] {
  const assignments: StartupRootAssignment[] = []
  let opaqueStartup = false
  let blockDepth = 0
  let groupDepth = 0
  let continued = false
  for (const rawLine of contents.replace(/\r\n?/g, '\n').split('\n')) {
    const { line, syntax, incompleteQuote } = startupLine(rawLine)
    if (line === '') continue
    // Loading another script can change any root; multiline literals cannot be read as
    // assignments. Ordinary PATH/prompt setup does not make every root uncertain.
    opaqueStartup ||= incompleteQuote || syntax.includes('<<') || /(?:^|[;&|({]\s*|\b(?:builtin|command|then|do|else|if|elif|while|until)\s+)(?:(?:source|eval)\b|\.\s+)/.test(syntax)
    const dynamicAssignment = blockDepth > 0 || groupDepth > 0 || continued || hasDynamicStartupSyntax(syntax)
    const shell = /^(?:export\s+)?(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\s*=\s*(.+?)\s*$/.exec(line)
    const fish = /^set\s+-gx\s+(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\s+(.+?)\s*$/.exec(line)
    const match = shell ?? fish
    const value = match !== null && !dynamicAssignment ? resolveStartupRoot(match[2], home) : undefined
    if (match === null || value === undefined) {
      for (const reference of line.matchAll(/\b(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\b/g)) {
        assignments.push({ name: reference[1] as StartupRootAssignment['name'], value: undefined })
      }
    } else {
      assignments.push({ name: match[1] as StartupRootAssignment['name'], value })
    }
    for (const token of syntax.matchAll(/(?:^|[;&|]\s*|\b(?:then|do|else)\s+)(if|for|while|until|case|select|begin|switch|function|fi|done|esac|end)\b/g)) {
      if (/^(?:fi|done|esac|end)$/.test(token[1])) blockDepth = Math.max(0, blockDepth - 1)
      else if (token[1] !== 'function' || !syntax.includes('{')) blockDepth += 1
    }
    // Quotes and variable expansions are absent from syntax, so prompt strings and ${PATH}
    // cannot create a fake group that would capture a later, unconditional root assignment.
    for (const character of syntax) {
      if (character === '{' || character === '(') groupDepth += 1
      else if (character === '}' || character === ')') groupDepth = Math.max(0, groupDepth - 1)
    }
    continued = syntax.endsWith('\\')
  }
  if (opaqueStartup) {
    return [
      ...assignments,
      { name: 'CODEX_HOME', value: undefined },
      { name: 'CLAUDE_CONFIG_DIR', value: undefined },
      { name: 'HERMES_HOME', value: undefined }
    ]
  }
  return assignments
}

/** Strip shell comments and hide quoted text only for syntax classification; never evaluate it. */
function startupLine(raw: string): { line: string; syntax: string; incompleteQuote: boolean } {
  let quote: string | undefined
  let syntax = ''
  let end = raw.length
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '\\' && quote !== "'") {
      syntax += quote === undefined ? '\\ ' : '  '
      index += 1
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      syntax += ' '
    } else if (character === '"' || character === "'") {
      quote = character
      syntax += ' '
    } else if (character === '#' && (index === 0 || /\s/.test(raw[index - 1]))) {
      end = index
      break
    } else syntax += character
  }
  return { line: raw.slice(0, end).trim(), syntax: syntax.replace(/\$\{[^}]*\}/g, '').trim(), incompleteQuote: quote !== undefined }
}

function hasDynamicStartupSyntax(line: string): boolean {
  const control = /^(?:if|for|while|until|case|select|function|begin|switch)\b/.test(line)
  return control || /[;&|<>(){}\\]/.test(line)
}

function resolveStartupRoot(raw: string, home: string): string | undefined {
  const trimmed = raw.trim()
  const quote = trimmed[0]
  const quoted = quote === '"' || quote === "'"
  if (quoted && (!trimmed.endsWith(quote) || trimmed.slice(1, -1).includes(quote))) return undefined
  const value = quoted ? trimmed.slice(1, -1) : trimmed
  // A bare shell token cannot contain whitespace. Quoted static paths may contain whitespace,
  // but neither form may carry an unexpanded variable or executable shell syntax.
  if (value === '' || !quoted && (/\s/.test(value) || /[*?\u005B\u005D]/.test(value))) return undefined
  const expanded = !quoted && (value === '~' || value.startsWith('~/')) ? join(home, value.slice(2))
    : quote !== "'" && (value === '$HOME' || value === '${HOME}') ? home
      : quote !== "'" && value.startsWith('$HOME/') ? join(home, value.slice(6))
        : quote !== "'" && value.startsWith('${HOME}/') ? join(home, value.slice(8)) : value
  if (/[$\\;`&|<>(){}]/.test(expanded)) return undefined
  if (!posix.isAbsolute(expanded)) return undefined
  return posix.normalize(expanded)
}

async function defaultStartupFileReader(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('AI_ACCESS_STARTUP_FILE_INVALID')
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function observeProcessOverrides(
  platform: NodeJS.Platform,
  home: string,
  run: RunCommand,
  windowsDetails: Map<string, WindowsProcessDetail>,
  now: () => number
): Promise<ConfigurationExecutionObservation> {
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const output = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='])
      const processes = output.split(/\r?\n/).map(posixProcess)
      const macDesktopRoots = platform === 'darwin' ? macCodexDesktopRoots(processes, home) : new Map<string, MacCodexDesktopApp>()
      const processByPid = new Map(processes.flatMap(process => process.pid === undefined ? [] : [[process.pid, process] as const]))
      const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
      for (const process of processes) {
        for (const shell of shells) {
          if (!knownClientInvocation(shell, process.command, home, platform)) continue
          // The GUI's own app-server and sandbox workers read or serve the normal user root after
          // a full app restart; they are not terminal clients. An official bundled binary with a
          // different command or parent remains fail-closed because it can carry an unobservable
          // per-session root, including one launched from a tool terminal inside the desktop app.
          if (platform === 'darwin' && shell === 'codex' &&
            knownMacCodexDesktopProcess(process, processByPid, macDesktopRoots)) continue
          // `ps` does not expose a process's inherited environment. A still-running native
          // client may therefore have an unobservable CODEX_HOME/CLAUDE_CONFIG_DIR/HERMES_HOME.
          // Ask for it to be closed before touching a root we cannot prove it will read.
          result[shell] = launchOverridesConfiguration(shell, process.command)
            ? { source: 'observed', commandLine: true }
            : { source: 'unknown' }
        }
      }
      return result
    } catch {
      return unknownAll()
    }
  }
  if (platform === 'win32') {
    const running: Partial<Record<AiAccessShell, readonly string[]>> = {}
    try {
      for (const shell of shells) {
        const output = await run('C:\\Windows\\System32\\tasklist.exe', ['/FI', `IMAGENAME eq ${processName(shell)}.exe`, '/FO', 'CSV', '/NH'])
        const ids = tasklistProcessIds(output, `${processName(shell)}.exe`)
        if (ids.length > 0) running[shell] = ids
      }
    } catch {
      return unknownAll()
    }
    if (Object.keys(running).length === 0) return {}
    // tasklist only has image names, and the desktop apps share them with the CLIs (Claude
    // Desktop is `claude.exe`, the Store Codex app is `Codex.exe`). Ask where each process lives
    // before treating it as a terminal client whose inherited environment we cannot see.
    const images = new Map<string, string>()
    for (const shell of shells) for (const id of running[shell] ?? []) images.set(id, `${processName(shell)}.exe`)
    const details = await windowsProcessDetails(images, run, windowsDetails, now)
    const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
    for (const shell of shells) {
      const ids = running[shell]
      if (ids === undefined) continue
      let context: ConfigurationExecutionContext | undefined
      for (const id of ids) {
        // Unreadable details keep the previous fail-closed answer for this shell. A PID missing from
        // a completed query has exited since tasklist ran.
        if (details !== undefined && !details.has(id)) continue
        const detail = details?.get(id)
        const kind = detail === undefined ? 'unrecognized' : classifyWindowsClientProcess(shell, detail.path, home)
        if (kind === 'desktop-app') continue
        if (kind === 'cli' && launchOverridesConfiguration(shell, detail?.commandLine ?? '')) {
          context = { source: 'observed', commandLine: true }
          break
        }
        context = { source: 'unknown' }
      }
      if (context !== undefined) result[shell] = context
    }
    return result
  }
  return unknownAll()
}

export type WindowsClientProcessKind = 'desktop-app' | 'cli' | 'unrecognized'

/**
 * Classifies a running Windows process by where its executable lives. Desktop apps are started by
 * the Windows shell (Start menu, taskbar, tray, protocol) and read the user's normal configuration
 * root, which the Toolbox observes from the same user environment; macOS applies the same
 * path-based rule to Claude.app. Terminal CLIs may carry an unobservable per-session environment.
 * Anything else stays unrecognized so callers keep the fail-closed answer.
 */
export function classifyWindowsClientProcess(shell: AiAccessShell, executablePath: string | undefined, home: string): WindowsClientProcessKind {
  if (executablePath === undefined || executablePath === '') return 'unrecognized'
  const path = normalizedWindowsPath(executablePath)
  const user = normalizedWindowsPath(home)
  const local = `${user}/appdata/local/`
  const roaming = `${user}/appdata/roaming/`
  // MSIX packages (Microsoft Store Codex, Claude Desktop) run from a WindowsApps volume folder.
  // `%LOCALAPPDATA%\Microsoft\WindowsApps` only holds execution aliases, never the real image.
  const packaged = /\/windowsapps\/[^/]+\//.test(path) && !path.startsWith(`${local}microsoft/windowsapps/`)
  if (shell === 'claude') {
    if (packaged || path.startsWith(`${local}anthropicclaude/`) ||
      path.startsWith(`${roaming}claude/claude-code/`) || path.startsWith(`${local}claude-3p/claude-code/`) ||
      path.startsWith(`${local}packages/claude_pzs8sxrjxfjjc/`)) return 'desktop-app'
    if (path === `${user}/.local/bin/claude.exe` || path.startsWith(`${user}/.local/share/claude/`) ||
      path.includes('/node_modules/@anthropic-ai/claude-code') || path.includes('/winget/packages/anthropic.claudecode')) return 'cli'
    return 'unrecognized'
  }
  if (shell === 'codex') {
    if (packaged) return 'desktop-app'
    if (path.includes('/node_modules/@openai/codex/') || path.includes('/winget/packages/openai.codex')) return 'cli'
    return 'unrecognized'
  }
  if (path.startsWith(`${user}/.hermes/hermes-agent/apps/desktop/release/`)) return 'desktop-app'
  if (path.startsWith(`${user}/.hermes/hermes-agent/venv/`) || path.startsWith(`${user}/.hermes/bin/`) ||
    path.startsWith(`${local}hermes/hermes-agent/venv/`)) return 'cli'
  return 'unrecognized'
}

function normalizedWindowsPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function tasklistProcessIds(output: string, image: string): readonly string[] {
  const ids: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d{1,10})"/.exec(line.trim())
    if (match !== null && match[1].toLowerCase() === image.toLowerCase()) ids.push(match[2])
  }
  return ids
}

/**
 * Executable path and command line for the listed PIDs, read through the fixed system PowerShell.
 * Details are cached per PID and image name: a live process never changes either value, so a tray
 * app does not spawn PowerShell on every status read. Returns undefined when the query cannot be
 * completed or its output is not exactly the expected shape.
 */
async function windowsProcessDetails(
  images: ReadonlyMap<string, string>,
  run: RunCommand,
  cache: Map<string, WindowsProcessDetail>,
  now: () => number
): Promise<ReadonlyMap<string, WindowsProcessDetail> | undefined> {
  const at = now()
  // A quit desktop app and a newly started CLI can share an image name and even a recycled PID.
  // Reuse details only while every image still has exactly the PID set we queried; any change
  // (a process ended or started) requeries that image instead of trusting an older answer.
  const currentSets = new Map<string, string>()
  for (const [id, image] of images) currentSets.set(image.toLowerCase(), [...(currentSets.get(image.toLowerCase())?.split(',') ?? []), id].sort().join(','))
  const cachedSets = new Map<string, string>()
  for (const [id, detail] of cache) cachedSets.set(detail.image.toLowerCase(), [...(cachedSets.get(detail.image.toLowerCase())?.split(',') ?? []), id].sort().join(','))
  for (const [id, detail] of cache) {
    const image = images.get(id)
    if (image === undefined || image.toLowerCase() !== detail.image.toLowerCase() || at - detail.at > windowsProcessDetailTtlMs ||
      cachedSets.get(image.toLowerCase()) !== currentSets.get(image.toLowerCase())) cache.delete(id)
  }
  const missing = [...images.keys()].filter(id => !cache.has(id))
  if (missing.length > 0) {
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
      `$items=@(Get-CimInstance -ClassName Win32_Process -Filter '${missing.map(id => `ProcessId=${id}`).join(' OR ')}' | ForEach-Object { [pscustomobject]@{ id=[string]$_.ProcessId; image=$_.Name; path=$_.ExecutablePath; line=$_.CommandLine } })`,
      'ConvertTo-Json -InputObject $items -Compress'
    ].join('; ')
    let parsed: unknown
    try {
      parsed = JSON.parse(await run(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 }))
    } catch {
      return undefined
    }
    if (!Array.isArray(parsed)) return undefined
    const fresh: Array<[string, WindowsProcessDetail]> = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return undefined
      const { id, image, path, line } = item as Record<string, unknown>
      if (typeof id !== 'string' || !missing.includes(id) || typeof image !== 'string' ||
        (path !== null && path !== undefined && typeof path !== 'string') ||
        (line !== null && line !== undefined && typeof line !== 'string')) return undefined
      // PID reused by another program between tasklist and this query: not the client we saw.
      if (image.toLowerCase() !== images.get(id)?.toLowerCase()) continue
      fresh.push([id, { image, ...(typeof path === 'string' ? { path } : {}), ...(typeof line === 'string' ? { commandLine: line } : {}), at }])
    }
    for (const [id, detail] of fresh) cache.set(id, detail)
  }
  return cache
}

function knownClientInvocation(shell: AiAccessShell, line: string, home: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const normalized = line.replace(/\\/g, '/')
  const homePath = home.replace(/\\/g, '/')
  if (shell === 'codex') {
    return /\/(?:Codex|ChatGPT)\.app\/Contents\/Resources\/(?:codex|codex-cli\/bin\/codex|codex-cli\/CodexCLI\.app\/Contents\/MacOS\/codex)(?:\s|$)/.test(normalized) ||
      (normalized.includes('/@openai/codex/') && normalized.includes('/vendor/') && /\/codex(?:\s|$)/.test(normalized)) ||
      normalized.includes(path.join(home, '.local', 'lib', 'node_modules').replace(/\\/g, '/')) && normalized.includes('/@openai/codex/')
  }
  if (shell === 'claude') {
    return normalized.includes(`${homePath}/.local/share/claude/versions/`) ||
      normalized.includes(`${homePath}/.local/bin/claude`)
  }
  return normalized.includes(`${homePath}/.hermes/hermes-agent/venv/`) || normalized.includes(`${homePath}/.hermes/bin/hermes`)
}

interface PosixProcess {
  readonly pid?: string
  readonly ppid?: string
  readonly command: string
}

function posixProcess(line: string): PosixProcess {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
  return match === null ? { command: line } : { pid: match[1], ppid: match[2], command: match[3] }
}

function macCodexDesktopApps(home: string) {
  return ['/Applications', posix.join(home, 'Applications')].flatMap(root => ['ChatGPT', 'Codex'].map(name => {
    const bundle = posix.join(root, `${name}.app`)
    const binaries = ['codex', 'codex-cli/bin/codex', 'codex-cli/CodexCLI.app/Contents/MacOS/codex']
      .map(relative => `${bundle}/Contents/Resources/${relative}`)
    return {
      bundle, executable: `${bundle}/Contents/MacOS/${name}`,
      appServers: binaries.map(binary => `${binary} -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`),
      sandboxes: binaries.map(binary => `${binary} sandbox`)
    }
  }))
}

type MacCodexDesktopApp = ReturnType<typeof macCodexDesktopApps>[number]

function macCodexDesktopRoots(processes: readonly PosixProcess[], home: string): Map<string, MacCodexDesktopApp> {
  const apps = macCodexDesktopApps(home)
  return new Map(processes.flatMap(process => {
    const app = apps.find(candidate => process.command === candidate.executable)
    return process.pid !== undefined && process.ppid === '1' && app !== undefined
      ? [[process.pid, app] as const] : []
  }))
}

function knownMacCodexDesktopProcess(
  process: PosixProcess,
  processByPid: ReadonlyMap<string, PosixProcess>,
  roots: ReadonlyMap<string, MacCodexDesktopApp>
): boolean {
  const command = process.command.trim()
  const apps = [...roots.values()]
  const appServer = apps.find(app => app.appServers.includes(command))
  if (appServer !== undefined) return process.ppid !== undefined && roots.get(process.ppid) === appServer
  const sandbox = apps.find(app => knownMacCodexDesktopSandbox(command, app))
  return sandbox !== undefined && macCodexDesktopSandboxParentChain(process, processByPid, roots, sandbox)
}

function knownMacCodexDesktopSandbox(command: string, app: MacCodexDesktopApp): boolean {
  if (app.sandboxes.some(sandbox => command === sandbox || command === `${sandbox} -c default_permissions=node_repl`)) return true
  const prefix = app.sandboxes.map(sandbox => `${sandbox} -c shell_environment_policy.inherit="all" -c default_permissions="node_repl" -c permissions.node_repl={`)
    .find(candidate => command.startsWith(candidate))
  const separator = '} -- '
  if (prefix === undefined) return false
  const separatorAt = command.lastIndexOf(separator)
  if (separatorAt < prefix.length) return false
  const worker = command.slice(separatorAt + separator.length)
  const node = `${app.bundle}/Contents/Resources/cua_node/bin/node`
  return worker === node || worker.startsWith(`${node} `)
}

function macCodexDesktopSandboxParentChain(
  process: PosixProcess,
  processByPid: ReadonlyMap<string, PosixProcess>,
  roots: ReadonlyMap<string, MacCodexDesktopApp>,
  app: MacCodexDesktopApp
): boolean {
  let parent = process.ppid
  const visited = new Set<string>()
  while (parent !== undefined && !visited.has(parent)) {
    visited.add(parent)
    const candidate = processByPid.get(parent)
    if (candidate === undefined) return false
    if (app.appServers.includes(candidate.command.trim())) {
      return candidate.ppid !== undefined && roots.get(candidate.ppid) === app
    }
    if (!knownMacCodexDesktopCodeModeHelper(candidate.command.trim(), app)) return false
    parent = candidate.ppid
  }
  return false
}

function knownMacCodexDesktopCodeModeHelper(command: string, app: MacCodexDesktopApp): boolean {
  const prefix = `${app.bundle}/Contents/Resources/cua_node/bin/`
  return command === `${prefix}node_repl` || command.startsWith(`${prefix}node_repl `) ||
    command === `${prefix}node` || command.startsWith(`${prefix}node `)
}

function launchOverridesConfiguration(shell: AiAccessShell, line: string): boolean {
  if (shell === 'codex') return hasArgument(line, '--config') || hasArgument(line, '-c') || hasArgument(line, '--profile')
  if (shell === 'claude') return hasArgument(line, '--settings') || hasArgument(line, '--setting-sources')
  return hasArgument(line, '--provider') || hasArgument(line, '--model') || hasArgument(line, '--base-url')
}

function hasArgument(line: string, argument: string): boolean {
  const expression = new RegExp(`(?:^|\\s)${escapeRegExp(argument)}(?:\\s|=|$)`)
  return expression.test(line)
}

function processName(shell: AiAccessShell): string {
  return shell === 'claude' ? 'claude' : shell
}

function unknownAll(): ConfigurationExecutionObservation {
  return Object.fromEntries(shells.map(shell => [shell, { source: 'unknown' }])) as ConfigurationExecutionObservation
}

async function anyPresence(checks: readonly (() => Promise<Presence>)[]): Promise<Presence> {
  let unknown = false
  for (const check of checks) {
    const result = await check()
    if (result === 'present') return 'present'
    unknown ||= result === 'unknown'
  }
  return unknown ? 'unknown' : 'absent'
}

async function commandPresence(run: (command: string, args: readonly string[]) => Promise<string>, command: string, args: readonly string[]): Promise<Presence> {
  try {
    await run(command, args)
    return 'present'
  } catch (error) {
    // `defaults read` and `reg QUERY` use exit 1 for an absent domain/key. Any other failure
    // (permission, missing trusted system tool, timeout) must block automatic configuration.
    return exitCode(error) === 1 ? 'absent' : 'unknown'
  }
}

async function defaultPolicyFilePresence(path: string): Promise<Presence> {
  try {
    await lstat(path)
    return 'present'
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? '')
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

async function defaultRun(command: string, args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<string> {
  const { stdout } = await execFile(command, [...args], { encoding: 'utf8', timeout: options?.timeoutMs ?? 2_000, maxBuffer: 256 * 1024, windowsHide: true })
  return stdout
}

function exitCode(error: unknown): number | undefined {
  const value = (error as { code?: unknown }).code
  return typeof value === 'number' ? value : undefined
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
