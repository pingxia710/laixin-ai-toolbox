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

export interface ConfigurationExecutionObserverOptions {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** Test seam. Production never reads configuration contents; it only checks fixed policy locations. */
  readonly policyFilePresence?: (path: string) => Promise<Presence>
  /** Test seam. Command output is classified in-process and never returned or logged. */
  readonly run?: (command: string, args: readonly string[]) => Promise<string>
  /** Test seam. Production reads only bounded, regular local startup files and never executes them. */
  readonly readStartupFile?: (path: string) => Promise<string | undefined>
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
  let inFlight: Promise<ConfigurationExecutionObservation> | undefined
  return async () => {
    if (inFlight !== undefined) return inFlight
    const observation = (async () => {
      const [policies, startupRoots, processes] = await Promise.all([
        observeManagedPolicies(options.platform, policyFilePresence, run),
        observeStartupConfigurationRoots(options.platform, options.home, readStartupFile),
        observeProcessOverrides(options.platform, options.home, run)
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
    try { return await observation } finally { if (inFlight === observation) inFlight = undefined }
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
  let dynamicStartup = false
  for (const rawLine of contents.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // We do not execute startup files. A control group, shell composition, or dynamically run
    // command can change any root for one launch but not another, so no automatic target is safe.
    dynamicStartup ||= hasDynamicStartupSyntax(line)
    const shell = /^(?:export\s+)?(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\s*=\s*(.+?)\s*$/.exec(line)
    const fish = /^set\s+-gx\s+(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\s+(.+?)\s*$/.exec(line)
    const match = shell ?? fish
    if (match === null) {
      if (/\b(?:CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\b/.test(line)) {
        const name = /\b(CODEX_HOME|CLAUDE_CONFIG_DIR|HERMES_HOME)\b/.exec(line)?.[1] as StartupRootAssignment['name']
        assignments.push({ name, value: undefined })
      }
    } else {
      assignments.push({
        name: match[1] as StartupRootAssignment['name'],
        value: resolveStartupRoot(match[2], home)
      })
    }
  }
  if (dynamicStartup) {
    return [
      ...assignments,
      { name: 'CODEX_HOME', value: undefined },
      { name: 'CLAUDE_CONFIG_DIR', value: undefined },
      { name: 'HERMES_HOME', value: undefined }
    ]
  }
  return assignments
}

function hasDynamicStartupSyntax(line: string): boolean {
  const command = /(?:^|[;&|]\s*|\b(?:builtin|command)\s+)(?:source|eval)\b/.test(line)
    || /(?:^|[;&|]\s*|\b(?:builtin|command)\s+)\.\s+/.test(line)
  const control = /^(?:if|for|while|until|case|select|function|begin|switch)\b/.test(line)
  // `${HOME}` is the only brace expansion accepted by resolveStartupRoot below. Every other
  // brace, subshell, operator, redirection, or line continuation is a compound shell statement.
  const composition = /(?:&&|\|\||[|<>]|[()\\])/.test(line)
    || /[{}]/.test(line.replaceAll('${HOME}', ''))
  return command || control || composition
}

function resolveStartupRoot(raw: string, home: string): string | undefined {
  const trimmed = raw.trim()
  const quote = trimmed[0]
  const quoted = quote === '"' || quote === "'"
  if (quoted && !trimmed.endsWith(quote)) return undefined
  const value = quoted ? trimmed.slice(1, -1) : trimmed.replace(/\s+#.*$/, '')
  // A bare shell token cannot contain whitespace. Quoted static paths may contain whitespace,
  // but neither form may carry an unexpanded variable or executable shell syntax.
  if (value === '' || !quoted && (/\s/.test(value) || /[*?\u005B\u005D]/.test(value))) return undefined
  const expanded = value === '~' || value === '$HOME' || value === '${HOME}' ? home
    : value.startsWith('~/') ? join(home, value.slice(2))
      : value.startsWith('$HOME/') ? join(home, value.slice(6))
        : value.startsWith('${HOME}/') ? join(home, value.slice(8)) : value
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
  run: (command: string, args: readonly string[]) => Promise<string>
): Promise<ConfigurationExecutionObservation> {
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const output = await run('/bin/ps', ['-axww', '-o', 'command='])
      const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
      for (const line of output.split(/\r?\n/)) {
        for (const shell of shells) {
          if (!knownClientInvocation(shell, line, home, platform)) continue
          // `ps` does not expose a process's inherited environment. A still-running native
          // client may therefore have an unobservable CODEX_HOME/CLAUDE_CONFIG_DIR/HERMES_HOME.
          // Ask for it to be closed before touching a root we cannot prove it will read.
          result[shell] = launchOverridesConfiguration(shell, line)
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
    try {
      const result: Partial<Record<AiAccessShell, ConfigurationExecutionContext>> = {}
      for (const shell of shells) {
        const output = await run('C:\\Windows\\System32\\tasklist.exe', ['/FI', `IMAGENAME eq ${processName(shell)}.exe`, '/FO', 'CSV', '/NH'])
        // Windows tasklist does not expose a trustworthy command line. A running known client is
        // therefore an unknown launch context, not a claim that its default root will be used.
        if (new RegExp(`"${escapeRegExp(processName(shell))}\\.exe"`, 'i').test(output)) result[shell] = { source: 'unknown' }
      }
      return result
    } catch {
      return unknownAll()
    }
  }
  return unknownAll()
}

function knownClientInvocation(shell: AiAccessShell, line: string, home: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const normalized = line.replace(/\\/g, '/')
  const homePath = home.replace(/\\/g, '/')
  if (shell === 'codex') {
    return normalized.includes('/Codex.app/Contents/Resources/codex') ||
      normalized.includes('/ChatGPT.app/Contents/Resources/codex') ||
      (normalized.includes('/@openai/codex/') && normalized.includes('/vendor/') && /\/codex(?:\s|$)/.test(normalized)) ||
      normalized.includes(path.join(home, '.local', 'lib', 'node_modules').replace(/\\/g, '/')) && normalized.includes('/@openai/codex/')
  }
  if (shell === 'claude') {
    return normalized.includes(`${homePath}/.local/share/claude/versions/`) ||
      normalized.includes(`${homePath}/.local/bin/claude`)
  }
  return normalized.includes(`${homePath}/.hermes/hermes-agent/venv/`) || normalized.includes(`${homePath}/.hermes/bin/hermes`)
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

async function defaultRun(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(command, [...args], { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024, windowsHide: true })
  return stdout
}

function exitCode(error: unknown): number | undefined {
  const value = (error as { code?: unknown }).code
  return typeof value === 'number' ? value : undefined
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
