import { posix, win32 } from 'node:path'

export type ConfigurationTargetShell = 'codex' | 'claude' | 'hermes'
export type ConfigurationTargetScope = 'user' | 'project' | 'unknown'
export type ConfigurationTargetOverride = 'none' | 'project' | 'managed' | 'command-line' | 'unknown'
export type ConfigurationTargetReason =
  | 'project-config-overrides-user'
  /** Codex reads provider routing only from its user config; a project file is diagnostic-only. */
  | 'project-configuration-ignored'
  | 'managed-configuration'
  | 'command-line-config-override'
  | 'unreadable-configuration'
  /** The config file is a symlink. Distinct from unreadable: the customer must decide what to do with the link. */
  | 'symlinked-configuration'
  | 'unknown-launch-context'

/** A symlinked config file: where the link sits and where it really points. */
export interface SymlinkedConfiguration {
  readonly path: string
  readonly target: string
}

const symlinkMark = 'symlinkLocation'

/**
 * Marks a "config file is a symlink" failure so discovery can tell it apart from an ordinary
 * unreadable file. The error message stays AI_ACCESS_CONFIG_FILE_INVALID for existing callers;
 * the location rides along in-process, ⛔ presented as a bare "invalid" verdict.
 */
export function symlinkMarkedError(path: string, target: string): Error & { readonly [symlinkMark]: SymlinkedConfiguration } {
  return Object.assign(new Error('AI_ACCESS_CONFIG_FILE_INVALID'), { [symlinkMark]: { path, target } })
}

/** Reads the symlink location back off a marked error; anything else yields undefined. */
export function symlinkLocationOf(error: unknown): SymlinkedConfiguration | undefined {
  const location = (error as { readonly [symlinkMark]?: unknown } | undefined)?.[symlinkMark]
  if (typeof location !== 'object' || location === null) return undefined
  const path = (location as { readonly path?: unknown }).path
  const target = (location as { readonly target?: unknown }).target
  return typeof path === 'string' && typeof target === 'string' ? { path, target } : undefined
}

/** Minimal file view so discovery never creates or changes a customer configuration. */
export interface ConfigurationTargetFile {
  read(path: string): Promise<string | undefined>
}

/**
 * Private main-process storage for an explicitly selected project directory. It is deliberately
 * separate from AiAccessState: public status and renderer snapshots carry only target evidence.
 */
export interface ConfigurationTargetProjectStore {
  /** Legacy Codex project selections are intentionally ignored; only Claude has a project target. */
  selectedProjectDirectory(shell: Extract<ConfigurationTargetShell, 'codex' | 'claude'>): Promise<string | undefined>
  saveSelectedProjectDirectory(shell: Extract<ConfigurationTargetShell, 'codex' | 'claude'>, directory: string): Promise<void>
}

export interface ConfigurationTargetProjectStoreFile extends ConfigurationTargetFile {
  write(path: string, contents: string): Promise<void>
}

interface StoredProjectDirectories {
  readonly version: 1
  /** Do not re-persist legacy `codex` entries: Codex has no project-level provider target. */
  readonly directories: Readonly<Partial<Record<'claude', string>>>
}

/**
 * The caller supplies a 0600, symlink-safe file adapter. Stored paths remain in the main process
 * and are revalidated before use, so a corrupted private selection blocks writes rather than
 * falling back to a guessed user-level configuration.
 */
export function createProjectConfigurationTargetStore(
  file: ConfigurationTargetProjectStoreFile,
  path: string,
  platform: NodeJS.Platform
): ConfigurationTargetProjectStore {
  return {
    async selectedProjectDirectory(shell) {
      // A previous Toolbox version could persist this value. It has never been a valid Codex
      // provider-routing target, so ignore it before parsing the private selection file.
      if (shell === 'codex') return undefined
      return (await readStoredProjectDirectories(file, path, platform)).directories[shell]
    },
    async saveSelectedProjectDirectory(shell, directory) {
      if (shell === 'codex') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      if (!isAbsolutePath(directory, platform)) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID')
      const current = await readStoredProjectDirectories(file, path, platform)
      const next: StoredProjectDirectories = { version: 1, directories: { ...current.directories, claude: directory } }
      await file.write(path, `${JSON.stringify(next)}\n`)
    }
  }
}

/**
 * Callers may supply observed launch facts. Values are intentionally boolean/path-presence only:
 * command arguments and environment contents must never reach renderer state or logs.
 */
export interface ConfigurationExecutionContext {
  readonly source?: 'observed' | 'unknown'
  /** Main-process-only validated user target, such as `$CODEX_HOME/config.toml`. */
  readonly userConfigPath?: string
  /** A trusted local observer saw a launch argument that can select a different configuration. */
  readonly commandLine?: boolean
  readonly configPath?: string
  readonly configDirectory?: string
  readonly managed?: boolean
}

export interface ConfigurationTarget {
  readonly shell: ConfigurationTargetShell
  readonly scope: ConfigurationTargetScope
  /** Main-process-only path. Use configurationTargetEvidence before returning state to the renderer. */
  readonly path?: string
  readonly override: ConfigurationTargetOverride
  readonly writable: boolean
  readonly reason?: ConfigurationTargetReason
  /** Set only for a symlinked config: the link and its real target, so the customer can decide. */
  readonly symlink?: SymlinkedConfiguration
}

export interface ConfigurationTargetEvidence {
  readonly shell: ConfigurationTargetShell
  readonly scope: ConfigurationTargetScope
  readonly override: ConfigurationTargetOverride
  readonly writable: boolean
  readonly reason?: ConfigurationTargetReason
  /** Set only for a symlinked config: the link and its real target, so the customer can decide. */
  readonly symlink?: SymlinkedConfiguration
}

export interface ConfigurationTargetDiscovery {
  readonly effective: ConfigurationTarget
  readonly candidates: readonly ConfigurationTarget[]
}

export interface DiscoverConfigurationTargetsOptions {
  readonly shell: ConfigurationTargetShell
  readonly home?: string
  readonly projectDir?: string
  /** A validated shell-specific user config path, for example a configured Hermes home. */
  readonly userPath?: string
  readonly platform?: NodeJS.Platform
  readonly file: ConfigurationTargetFile
  readonly execution?: ConfigurationExecutionContext
}

/**
 * Finds the configuration source that can actually win for one shell. Claude's discovered project
 * configuration requires an explicit target selection. Codex does not read model_provider or
 * model_providers from a project `.codex/config.toml`, so its user configuration remains effective.
 */
export async function discoverConfigurationTargets(options: DiscoverConfigurationTargetsOptions): Promise<ConfigurationTargetDiscovery> {
  const execution = options.execution
  if (execution?.managed === true) return blocked(options.shell, 'managed', 'managed-configuration')
  if (execution?.commandLine === true || execution?.configPath !== undefined || execution?.configDirectory !== undefined) {
    return blocked(options.shell, 'command-line', 'command-line-config-override')
  }
  if (execution?.source === 'unknown' || options.home === undefined || options.home === '') {
    return blocked(options.shell, 'unknown', 'unknown-launch-context')
  }

  const paths = configurationPaths(options.shell, options.home, options.projectDir, options.platform, options.userPath)
  const user = target(options.shell, 'user', paths.user, 'none', true)
  const symlinkedOrUnreadable = (error: unknown): ConfigurationTargetDiscovery => {
    const symlink = symlinkLocationOf(error)
    return symlink !== undefined
      ? blocked(options.shell, 'unknown', 'symlinked-configuration', symlink)
      : blocked(options.shell, 'unknown', 'unreadable-configuration')
  }
  let existingProject: string | undefined
  if (options.shell === 'codex') {
    // Codex never uses provider routing from a project file. Its project configuration is only a
    // best-effort diagnostic, so an unreadable project must not prevent repair of the real user
    // target. The user file remains a mandatory readability probe.
    try { await options.file.read(paths.user) } catch (error) { return symlinkedOrUnreadable(error) }
    try {
      for (const path of paths.project) {
        if (await options.file.read(path) !== undefined) {
          existingProject = path
          break
        }
      }
    } catch { /* Diagnostic unavailable; user-level target is still valid. */ }
  } else {
    try {
      for (const path of paths.project) {
        if (await options.file.read(path) !== undefined) {
          existingProject = path
          break
        }
      }
      // Read the user target as a permission/readability probe even when it does not exist.
      await options.file.read(paths.user)
    } catch (error) {
      return symlinkedOrUnreadable(error)
    }
  }

  if (existingProject === undefined) return { effective: user, candidates: [user] }

  if (options.shell === 'codex') {
    // Keep the observation as a safe diagnostic fact only. Deliberately omit its local path so
    // neither a renderer nor a later caller can turn it into a write target.
    const effective = target(options.shell, 'user', paths.user, 'none', true, 'project-configuration-ignored')
    const diagnostic: ConfigurationTarget = {
      shell: options.shell,
      scope: 'project',
      override: 'none',
      writable: false,
      reason: 'project-configuration-ignored'
    }
    return { effective, candidates: [effective, diagnostic] }
  }

  const project = target(options.shell, 'project', existingProject, 'project', false, 'project-config-overrides-user')
  const deferredUser = target(options.shell, 'user', paths.user, 'project', false, 'project-config-overrides-user')
  return { effective: project, candidates: [project, deferredUser] }
}

/**
 * Converts a diagnostic target to an explicitly approved write target. Blocked and non-effective
 * target scopes stay blocked; callers must never manufacture writable targets from raw paths.
 */
export function selectConfigurationTarget(discovery: ConfigurationTargetDiscovery, scope: Extract<ConfigurationTargetScope, 'user' | 'project'>): ConfigurationTarget {
  if (discovery.effective.shell === 'codex' && scope === 'project') {
    throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  }
  if (discovery.effective.scope === 'unknown' || discovery.effective.writable === false && discovery.effective.override !== 'project') {
    throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  }
  if (discovery.effective.scope === 'project' && scope !== 'project') {
    throw new Error('AI_ACCESS_CONFIGURATION_TARGET_NOT_EFFECTIVE')
  }
  const candidate = discovery.candidates.find((item) => item.scope === scope)
  if (candidate === undefined || candidate.path === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  return { shell: candidate.shell, scope: candidate.scope, path: candidate.path, override: candidate.override, writable: true }
}

/** Safe renderer/status representation: no local path, command line, key, or environment value.
 * A symlinked config carries its link and real target on purpose: the customer decides what to do with the link. */
export function configurationTargetEvidence(target: ConfigurationTarget): ConfigurationTargetEvidence {
  const { shell, scope, override, writable, reason, symlink } = target
  return reason === undefined && symlink === undefined ? { shell, scope, override, writable }
    : {
        shell, scope, override, writable,
        ...(reason !== undefined ? { reason } : {}),
        ...(symlink !== undefined ? { symlink } : {})
      }
}

function blocked(shell: ConfigurationTargetShell,
  override: Extract<ConfigurationTargetOverride, 'managed' | 'command-line' | 'unknown'>,
  reason: ConfigurationTargetReason, symlink?: SymlinkedConfiguration): ConfigurationTargetDiscovery {
  const effective: ConfigurationTarget = { shell, scope: 'unknown', override, writable: false, reason,
    ...(symlink !== undefined ? { symlink } : {}) }
  return { effective, candidates: [effective] }
}

function target(
  shell: ConfigurationTargetShell,
  scope: Extract<ConfigurationTargetScope, 'user' | 'project'>,
  path: string,
  override: ConfigurationTargetOverride,
  writable: boolean,
  reason?: ConfigurationTargetReason
): ConfigurationTarget {
  return reason === undefined ? { shell, scope, path, override, writable } : { shell, scope, path, override, writable, reason }
}

function configurationPaths(shell: ConfigurationTargetShell, home: string, projectDir: string | undefined, platform: NodeJS.Platform | undefined, userPath: string | undefined): { user: string; project: readonly string[] } {
  const path = platform === 'win32' ? win32 : posix
  switch (shell) {
    case 'codex':
      return {
        user: userPath ?? path.join(home, '.codex', 'config.toml'),
        project: projectDir === undefined ? [] : [path.join(projectDir, '.codex', 'config.toml')]
      }
    case 'claude':
      return {
        user: userPath ?? path.join(home, '.claude', 'settings.json'),
        project: projectDir === undefined ? [] : [
          path.join(projectDir, '.claude', 'settings.local.json'),
          path.join(projectDir, '.claude', 'settings.json')
        ]
      }
    case 'hermes':
      return { user: userPath ?? path.join(home, '.hermes', '.env'), project: [] }
  }
}

async function readStoredProjectDirectories(
  file: ConfigurationTargetFile,
  path: string,
  platform: NodeJS.Platform
): Promise<StoredProjectDirectories> {
  const contents = await file.read(path)
  if (contents === undefined) return { version: 1, directories: {} }
  let value: unknown
  try { value = JSON.parse(contents) } catch { throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID') }
  if (!record(value) || value.version !== 1 || !record(value.directories)) {
    throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID')
  }
  const directories: Partial<Record<'claude', string>> = {}
  const directory = value.directories.claude
  if (directory !== undefined) {
    if (typeof directory !== 'string' || !isAbsolutePath(directory, platform)) {
      throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID')
    }
    directories.claude = directory
  }
  // Accept but ignore a legacy Codex entry, even if malformed. It must never make a current
  // Codex route block, select a project, or write a project file.
  for (const key of Object.keys(value.directories)) {
    if (key !== 'codex' && key !== 'claude') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SELECTION_INVALID')
  }
  return { version: 1, directories }
}

function isAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
