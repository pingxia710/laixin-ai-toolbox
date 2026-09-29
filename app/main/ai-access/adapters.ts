import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { modelProvider, providerModelWindow, type ApiServiceConnection, type ModelProviderId } from '../../shared/model-providers'
import { trustedHermesCommandCandidates, trustedHermesEnvironment, trustedHermesExecutable } from '../shells/inventory'
import {
  captureManagedTextFiles,
  claudeManagedSection,
  codexManagedSection,
  createApplicationIsolationLease,
  createClaudeModelApiConfig,
  createCodexModelApiConfig,
  createCodexIsolationLease,
  createHermesModelApiConfig,
  hasHermesManagedEnvBlock,
  hermesManagedEnvOwner,
  hermesManagedSection,
  inspectModelApiBackup,
  managedFingerprint,
  parseCodexIsolationLease,
  parseApplicationIsolationLease,
  removeHermesManagedEnvBlock,
  renderApplicationIsolationLease,
  renderCodexIsolationLease,
  restoreClaudeManagedSection,
  type ManagedTextFile
} from './deepseek-config'
import { replaceConfigurationTransaction, withConfigWriteLock } from './config-write-guard'
import {
  configurationTargetEvidence,
  discoverConfigurationTargets,
  selectConfigurationTarget,
  type ConfigurationExecutionContext,
  type ConfigurationTarget,
  type ConfigurationTargetEvidence,
  type ConfigurationTargetProjectStore,
  type ConfigurationTargetShell
} from './configuration-target'
import { baseUrlFromCodexToml } from './residual-address'
import { codexToolboxConnectionBlock, parseCodexTomlDocument } from './codex-toml-document'
import type { ConfigurationExecutionObservation } from './configuration-execution-observer'
import type { AiAccessAdapter, AiAccessShell, ExplicitConfigurationTargetScope } from './service'

const execFile = promisify(execFileCallback)

export interface DeepSeekAdapterOptions {
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly localAppData?: string
  readonly hermesHome?: string
  /** Main-process-private locator for an unfinished Hermes isolation lease; never sent through IPC. */
  readonly hermesIsolationRegistryPath?: string
  /** A caller may supply a real project root only when it obtained it from an explicit user choice. */
  readonly projectDir?: string
  /** Main-process private storage for a project directory the customer explicitly selected. */
  readonly projectTargetStore?: ConfigurationTargetProjectStore
  /** Sanitized observed launch configuration facts. Values remain in the main process. */
  readonly configurationExecution?: Readonly<Partial<Record<AiAccessShell, ConfigurationExecutionContext>>>
  /** Fresh local policy/launch observation before every read or write. Failures block the target. */
  readonly observeConfigurationExecution?: () => Promise<ConfigurationExecutionObservation>
  /** Private Toolbox record for the one Claude target that owns an unsettled isolation lease. */
  readonly claudeIsolationLeaseRegistryPath?: string
  readonly file: ManagedTextFile
  readonly findHermesCommand?: () => Promise<string | undefined>
  readonly runHermes?: (command: string, args: readonly string[], hermesHome?: string) => Promise<void>
  readonly readHermesConfig?: (command: string, key: HermesModelKey, hermesHome?: string) => Promise<string | undefined>
  /** Test-only source environment for the bounded Hermes launcher process. Production uses process.env. */
  readonly hermesExecutionEnvironment?: NodeJS.ProcessEnv
}

/**
 * Environment-provided configuration homes are shell-supported user roots, not project overrides.
 * Actual command-line and managed-policy overrides are represented separately by the execution
 * context and remain blocked. Raw paths never reach status.
 */
export function observedConfigurationExecution(
  home: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): Readonly<Partial<Record<AiAccessShell, ConfigurationExecutionContext>>> {
  const hermesDefault = resolveHermesHome(platform, home, environment.LOCALAPPDATA)
  const path = platform === 'win32' ? win32 : posix
  // CODEX_HOME is Codex's user-level config root, not a command-line project override.
  // Keep its path inside the main process so the adapter writes `${CODEX_HOME}/config.toml`.
  const codex = observedCodexHomeContext(environment.CODEX_HOME, path.join(home, '.codex'), platform)
  const claude = observedUserDirectoryContext(environment.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), 'settings.json', platform)
  const hermes = observedUserDirectoryContext(environment.HERMES_HOME, hermesDefault, '.env', platform)
  return {
    ...(codex === undefined ? {} : { codex }),
    ...(claude === undefined ? {} : { claude }),
    ...(hermes === undefined ? {} : { hermes })
  }
}

export type HermesModelKey = 'model.provider' | 'model.default' | 'model.base_url' | 'model.api_key' | 'model.api_mode' | 'model.context_length'
type HermesModelSettings = Readonly<Record<HermesModelKey, string | undefined>>
type HermesSettingsReader = (command: string) => Promise<HermesModelSettings>
const hermesModelKeys: readonly HermesModelKey[] = [
  'model.provider', 'model.default', 'model.base_url', 'model.api_key', 'model.api_mode', 'model.context_length'
]

/** Configures all three installed clients. The retained name keeps the existing composition entry stable. */
export function createDeepSeekAdapters(options: DeepSeekAdapterOptions): readonly AiAccessAdapter[] {
  const initialHermesConfigPath = options.configurationExecution?.hermes?.userConfigPath
  const hermesRoot = initialHermesConfigPath === undefined
    ? resolveHermesHome(options.platform, options.home, options.localAppData, options.hermesHome)
    : directoryOf(initialHermesConfigPath, options.platform)
  const hermesPath = initialHermesConfigPath ?? hermesEnvPath(options.platform, hermesRoot)
  const hermesIsolationRegistryPath = options.hermesIsolationRegistryPath ??
    joinPath(options.platform, options.home, '.laixin-hermes-isolation-targets.json')
  const codexTarget = createConfigurationTargetManager('codex', options, options.configurationExecution?.codex?.userConfigPath)
  const claudeTarget = createConfigurationTargetManager('claude', options, options.configurationExecution?.claude?.userConfigPath)
  // This record is an opaque identity pointer, never a raw Claude path. It lets crash recovery
  // fail closed when the current effective target no longer matches the captured lease target.
  const claudeIsolationLeaseRegistryPath = options.claudeIsolationLeaseRegistryPath ??
    joinPath(options.platform, options.home, '.laixin-ai-access', 'laixin-claude-isolation-target.json')
  const hermesTarget = createConfigurationTargetManager('hermes', options, hermesPath)
  const findHermesForTarget = (target: ConfigurationTarget) => options.findHermesCommand ??
    (() => findHermesCommand(options.platform, directoryOf(configurationPath(target), options.platform)))
  // Production discovery comes from Hermes' fixed virtualenv candidate. Recheck immediately before
  // every default child-process execution so a candidate swapped to a symlink after discovery
  // cannot run during a later port-rebind recovery. Explicit test/acceptance injectors own their
  // command validation and retain their existing controlled runner contract.
  const ensureHermesExecutable = async (command: string): Promise<void> => {
    // Fixture runners inject both operations and never spawn the returned string. A partial
    // override still reaches the default child-process path, so it must satisfy the same trusted
    // launcher validation as production.
    if (options.runHermes !== undefined && options.readHermesConfig !== undefined) return
    if (!await trustedHermesExecutable(command, options.platform)) {
      throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
    }
  }
  const hermesExecution = (target: ConfigurationTarget) => {
    const root = directoryOf(configurationPath(target), options.platform)
    const config = hermesConfigPath(options.platform, root)
    const runHermes = async (command: string, args: readonly string[]) => {
      if (options.runHermes !== undefined) return options.runHermes(command, args, root)
      await ensureHermesExecutable(command)
      return runHermesCommand(command, args, root, options.platform, options.hermesExecutionEnvironment)
    }
    const readHermesConfig = async (command: string, key: HermesModelKey) => {
      if (options.readHermesConfig !== undefined) return options.readHermesConfig(command, key, root)
      await ensureHermesExecutable(command)
      return readHermesConfigValue(command, key, root, options.platform, options.hermesExecutionEnvironment)
    }
    // Explicit capture/apply operations use config.yaml first, then a serial CLI fallback for
    // older installations. A new root is passed consistently to both the CLI and the file read.
    const readHermesSettings: HermesSettingsReader = async (command) =>
      (await readHermesConfigYamlSettings(options.file, config)) ?? readHermesModelSettings(command, readHermesConfig)
    return { config, runHermes, readHermesSettings }
  }

  const codexConfigForTarget = (provider: ModelProviderId, connection: ApiServiceConnection | undefined, target: ConfigurationTarget) =>
    createCodexModelApiConfig(provider, options.home, options.file, connection, target)
  const claudeConfigForTarget = (provider: ModelProviderId, connection: ApiServiceConnection | undefined, target: ConfigurationTarget) =>
    createClaudeModelApiConfig(provider, options.home, options.file, connection, target)
  const hermesIsolationFiles = async (target: ConfigurationTarget): Promise<HermesIsolationFiles> => {
    const execution = hermesExecution(target)
    const root = directoryOf(configurationPath(target), options.platform)
    const command = await findHermesForTarget(target)()
    if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
    return {
      file: options.file,
      lockPath: joinPath(options.platform, root, 'laixin-config.lock'),
      leasePath: joinPath(options.platform, root, 'laixin-hermes-isolation-lease.json'),
      targetIdentity: hermesIsolationTargetIdentity(options.platform, root),
      command,
      run: execution.runHermes,
      read: execution.readHermesSettings
    }
  }
  const hermesIsolationTarget = async (targetIdentity: string): Promise<ConfigurationTarget> => {
    const root = await readHermesIsolationTarget(options.file, hermesIsolationRegistryPath, options.platform, targetIdentity)
    return { shell: 'hermes', scope: 'user', path: hermesEnvPath(options.platform, root), override: 'none', writable: true }
  }
  const currentHermesIsolationTargetIdentity = async (): Promise<string> => {
    const target = await hermesTarget.forRead()
    return hermesIsolationTargetIdentity(options.platform, directoryOf(configurationPath(target), options.platform))
  }
  const codexConfig = async (provider: ModelProviderId, connection?: ApiServiceConnection) =>
    codexConfigForTarget(provider, connection, await codexTarget.forWrite())
  const claudeConfig = async (provider: ModelProviderId, connection?: ApiServiceConnection) =>
    claudeConfigForTarget(provider, connection, await claudeTarget.forWrite())

  return [{
    shell: 'codex',
    applyDeepSeek: async (key) => (await codexConfig('deepseek')).apply(key),
    applyProvider: async (provider, key) => (await codexConfig(provider)).apply(key),
    applyConnection: async (provider, connection) => (await codexConfig(provider, connection)).apply('local-token-unused'),
    applyIsolationConnection: async (provider, connection, expectedIsolationFingerprint, leaseId, expectedConfigurationTargetIdentity) => {
      const target = await codexTarget.forWrite()
      if (expectedConfigurationTargetIdentity !== undefined && configurationTargetIdentityFor(target) !== expectedConfigurationTargetIdentity) return 'stale'
      const config = codexConfigForTarget(provider, connection, target)
      if (config.applyIfIsolationFingerprint === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
      return config.applyIfIsolationFingerprint(expectedIsolationFingerprint, leaseId, 'local-token-unused', () => targetMatches(codexTarget, expectedConfigurationTargetIdentity))
    },
    captureConnection: async () => captureManagedTextFiles(options.file, codexManagedPaths(await codexTarget.forWrite(), options.platform)),
    captureIsolation: async (expectedConfigurationTargetIdentity) => {
      const target = await codexTarget.forWrite()
      if (expectedConfigurationTargetIdentity !== undefined && configurationTargetIdentityFor(target) !== expectedConfigurationTargetIdentity) {
        throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      }
      const path = configurationPath(target)
      const lockPath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-config.lock')
      const leasePath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-codex-isolation-lease.json')
      return withAdapterConfigWriteLock(options.file, lockPath, async () => {
        const [before, previousLease] = await Promise.all([options.file.read(path), options.file.read(leasePath)])
        if (before === undefined || previousLease !== undefined) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
        const block = codexToolboxConnectionBlock(before)
        const beforeIsolationFingerprint = managedFingerprint(block)!
        const lease = createCodexIsolationLease(block, beforeIsolationFingerprint)
        await replaceConfigurationTransaction(options.file, [{ path: leasePath, before: previousLease, after: renderCodexIsolationLease(lease) }], { backupAction: 'apply' })
        return {
          beforeFingerprint: managedFingerprint(codexManagedSection(before))!,
          beforeIsolationFingerprint,
          configurationTargetIdentity: configurationTargetIdentityFor(target),
          leaseId: lease.id,
          restoreIfOwned: async (expectedFingerprint?: string) => withAdapterConfigWriteLock(options.file, lockPath, async () => {
            const [current, rawLease] = await Promise.all([options.file.read(path), options.file.read(leasePath)])
            let currentLease
            try { currentLease = parseCodexIsolationLease(rawLease) } catch { return 'preserved-external' as const }
            if (currentLease.id !== lease.id || current === undefined || !sameCodexIsolationFingerprint(current, expectedFingerprint ?? beforeIsolationFingerprint)) return 'preserved-external' as const
            const candidate = parseCodexTomlDocument(current).replaceToolboxConnection(block)
            await replaceConfigurationTransaction(options.file, [{ path, before: current, after: candidate, validate: value => { if (value !== undefined) parseCodexTomlDocument(value) } }], { backupAction: 'restore' })
            return 'restored' as const
          })
        }
      })
    },
    readManagedFingerprint: async () => readCodexManagedFingerprint(options.file, await codexTarget.forRead()),
    readIsolationFingerprint: async () => {
      try {
        const contents = await options.file.read(configurationPath(await codexTarget.forRead()))
        return contents === undefined ? undefined : managedFingerprint(codexToolboxConnectionBlock(contents))
      } catch { return undefined }
    },
    recoverIsolationLease: async () => {
      const target = await codexTarget.forWrite()
      const path = configurationPath(target)
      const lockPath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-config.lock')
      const leasePath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-codex-isolation-lease.json')
      return withAdapterConfigWriteLock(options.file, lockPath, async () => {
        const [current, rawLease] = await Promise.all([options.file.read(path), options.file.read(leasePath)])
        if (rawLease === undefined) return 'none' as const
        const lease = parseCodexIsolationLease(rawLease)
        const currentFingerprint = current === undefined ? undefined : safeCodexIsolationFingerprint(current)
        const owned = currentFingerprint !== undefined && (currentFingerprint === lease.beforeFingerprint || currentFingerprint === lease.expectedFingerprint)
        if (!owned) {
          await replaceConfigurationTransaction(options.file, [{ path: leasePath, before: rawLease, after: undefined }], { backupAction: 'restore' })
          return 'preserved-external' as const
        }
        const restored = currentFingerprint === lease.beforeFingerprint ? current : parseCodexTomlDocument(current!).replaceToolboxConnection(lease.beforeBlock)
        await replaceConfigurationTransaction(options.file, [
          { path, before: current, after: restored, validate: value => { if (value !== undefined) parseCodexTomlDocument(value) } },
          { path: leasePath, before: rawLease, after: undefined }
        ], { backupAction: 'restore' })
        return 'restored' as const
      })
    },
    clearIsolationLease: async (leaseId) => {
      const target = await codexTarget.forWrite()
      const path = configurationPath(target)
      const lockPath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-config.lock')
      const leasePath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-codex-isolation-lease.json')
      await withAdapterConfigWriteLock(options.file, lockPath, async () => {
        const rawLease = await options.file.read(leasePath)
        if (rawLease === undefined) return
        const lease = parseCodexIsolationLease(rawLease)
        if (lease.id !== leaseId) return
        await replaceConfigurationTransaction(options.file, [{ path: leasePath, before: rawLease, after: undefined }], { backupAction: 'restore' })
      })
    },
    readCurrentBaseUrl: async () => {
      try {
        const contents = await options.file.read(configurationPath(await codexTarget.forRead()))
        return contents === undefined ? undefined : baseUrlFromCodexToml(contents)
      } catch { return undefined }
    },
    configurationTargetStatus: () => codexTarget.status(),
    configurationTargetIdentity: () => configurationTargetIdentity(codexTarget),
    deactivateToolboxConnection: async () => (await codexConfig('deepseek')).deactivateToolboxConnection(),
    restorePreviousConnection: async () => (await codexConfig('deepseek')).restorePreviousConnection(),
    officialAuthenticationStatus: async () => (await codexConfig('deepseek')).officialAuthenticationStatus!(),
    // The login child must use the same verified CODEX_HOME as the config/auth inspection. This
    // raw directory remains in the main process and is intentionally absent from status/IPC.
    codexOfficialLoginRoot: async () => directoryOf(configurationPath(await codexTarget.forRead()), options.platform),
    // Kept only for callers compiled against the old hook. It has the safe "解除工具箱路由" behavior.
    activateOfficial: async () => (await codexConfig('deepseek')).deactivateToolboxConnection()
  }, {
    shell: 'claude',
    applyDeepSeek: async (key) => (await claudeConfig('deepseek')).apply(key),
    applyProvider: async (provider, key) => (await claudeConfig(provider)).apply(key),
    applyConnection: async (provider, connection) => (await claudeConfig(provider, connection)).apply('local-token-unused'),
    applyIsolationConnection: async (provider, connection, expectedIsolationFingerprint, leaseId, expectedConfigurationTargetIdentity) => {
      const target = await claudeTarget.forWrite()
      if (expectedConfigurationTargetIdentity !== undefined && configurationTargetIdentityFor(target) !== expectedConfigurationTargetIdentity) return 'stale'
      const config = claudeConfigForTarget(provider, connection, target)
      if (config.applyIfIsolationFingerprint === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
      const targetIdentity = configurationTargetIdentityFor(target)
      return config.applyIfIsolationFingerprint(expectedIsolationFingerprint, leaseId, 'local-token-unused', async () => {
        if (!await targetMatches(claudeTarget, expectedConfigurationTargetIdentity)) return false
        try {
          const registry = parseClaudeIsolationLeaseTarget(await options.file.read(claudeIsolationLeaseRegistryPath))
          return registry?.leaseId === leaseId && registry.targetIdentity === targetIdentity
        } catch { return false }
      })
    },
    captureConnection: async () => captureManagedTextFiles(options.file, claudeManagedPaths(await claudeTarget.forWrite(), options.platform)),
    captureIsolation: async (expectedConfigurationTargetIdentity) => {
      const target = await claudeTarget.forWrite()
      if (expectedConfigurationTargetIdentity !== undefined && configurationTargetIdentityFor(target) !== expectedConfigurationTargetIdentity) {
        throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      }
      const path = configurationPath(target)
      const lockPath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-config.lock')
      const leasePath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-claude-isolation-lease.json')
      return withAdapterConfigWriteLock(options.file, lockPath, async () => {
        const [before, previousLease, previousRegistry] = await Promise.all([
          options.file.read(path), options.file.read(leasePath), options.file.read(claudeIsolationLeaseRegistryPath)
        ])
        if (before === undefined || previousLease !== undefined || previousRegistry !== undefined) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
        const block = claudeManagedSection(before)
        const beforeIsolationFingerprint = managedFingerprint(block)
        if (block === undefined || beforeIsolationFingerprint === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const lease = createApplicationIsolationLease(block, beforeIsolationFingerprint)
        const targetIdentity = configurationTargetIdentityFor(target)
        const registry = renderClaudeIsolationLeaseTarget({ leaseId: lease.id, targetIdentity })
        // The durable pointer is written first. A crash before the target sidecar exists is
        // settled only after this exact target is selected again; another target never guesses.
        await replaceConfigurationTransaction(options.file, [
          { path: claudeIsolationLeaseRegistryPath, before: previousRegistry, after: registry, validate: validateClaudeIsolationLeaseTarget },
          { path: leasePath, before: previousLease, after: renderApplicationIsolationLease(lease) }
        ], { backupAction: 'apply' })

        const capturedRegistryMatches = (rawRegistry: string | undefined): boolean => {
          try {
            const current = parseClaudeIsolationLeaseTarget(rawRegistry)
            return current?.leaseId === lease.id && current.targetIdentity === targetIdentity
          } catch { return false }
        }
        const clearCapturedLease = async () => withAdapterConfigWriteLock(options.file, lockPath, async () => {
          const [rawLease, rawRegistry] = await Promise.all([options.file.read(leasePath), options.file.read(claudeIsolationLeaseRegistryPath)])
          let ownsLease = false
          try { ownsLease = parseApplicationIsolationLease(rawLease).id === lease.id } catch { /* An unknown sidecar remains untouched. */ }
          const ownsRegistry = capturedRegistryMatches(rawRegistry)
          const changes = [
            ...(ownsLease ? [{ path: leasePath, before: rawLease, after: undefined }] : []),
            ...(ownsRegistry ? [{ path: claudeIsolationLeaseRegistryPath, before: rawRegistry, after: undefined }] : [])
          ]
          if (changes.length !== 0) await replaceConfigurationTransaction(options.file, changes, { backupAction: 'restore' })
        })
        return {
          beforeFingerprint: beforeIsolationFingerprint,
          beforeIsolationFingerprint,
          configurationTargetIdentity: targetIdentity,
          leaseId: lease.id,
          restoreIfOwned: async (expectedFingerprint?: string) => withAdapterConfigWriteLock(options.file, lockPath, async () => {
            const [current, rawLease, rawRegistry] = await Promise.all([
              options.file.read(path), options.file.read(leasePath), options.file.read(claudeIsolationLeaseRegistryPath)
            ])
            let ownsLease = false
            try { ownsLease = parseApplicationIsolationLease(rawLease).id === lease.id } catch { /* Preserve an unknown sidecar. */ }
            const ownsRegistry = capturedRegistryMatches(rawRegistry)
            const changes = [
              ...(ownsLease && current !== undefined && sameClaudeIsolationFingerprint(current, expectedFingerprint ?? beforeIsolationFingerprint)
                ? [{ path, before: current, after: restoreClaudeManagedSection(current, block), validate: (value: string | undefined) => { if (value !== undefined) JSON.parse(value) } }]
                : []),
              ...(ownsLease ? [{ path: leasePath, before: rawLease, after: undefined }] : []),
              ...(ownsRegistry ? [{ path: claudeIsolationLeaseRegistryPath, before: rawRegistry, after: undefined }] : [])
            ]
            if (changes.length !== 0) await replaceConfigurationTransaction(options.file, changes, { backupAction: 'restore' })
            return ownsLease && current !== undefined && sameClaudeIsolationFingerprint(current, expectedFingerprint ?? beforeIsolationFingerprint)
              ? 'restored' as const : 'preserved-external' as const
          }),
          clearIsolationLease: clearCapturedLease
        }
      })
    },
    readManagedFingerprint: async () => readClaudeManagedFingerprint(options.file, await claudeTarget.forRead()),
    readIsolationFingerprint: async () => {
      try { return managedFingerprint(claudeManagedSection(await options.file.read(configurationPath(await claudeTarget.forRead())))) } catch { return undefined }
    },
    recoverIsolationLease: async () => {
      const target = await claudeTarget.forWrite()
      const targetIdentity = configurationTargetIdentityFor(target)
      const path = configurationPath(target)
      const lockPath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-config.lock')
      const leasePath = joinPath(options.platform, directoryOf(path, options.platform), 'laixin-claude-isolation-lease.json')
      const rawRegistry = await options.file.read(claudeIsolationLeaseRegistryPath)
      if (rawRegistry !== undefined) {
        let registry: ClaudeIsolationLeaseTarget
        try { registry = parseClaudeIsolationLeaseTarget(rawRegistry)! } catch { throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED') }
        // Do not scan or open a recorded target path. The only allowed recovery target is the
        // current path after its opaque identity proves it is the captured one.
        if (registry.targetIdentity !== targetIdentity) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
      }
      return withAdapterConfigWriteLock(options.file, lockPath, async () => {
        // The target may have changed while waiting for this target's lock. Re-observe before
        // opening or settling any A file so recovery never acts on an outdated effective target.
        const lockedTarget = await claudeTarget.forWrite()
        if (configurationTargetIdentityFor(lockedTarget) !== targetIdentity) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
        const [current, rawLease, currentRegistry] = await Promise.all([
          options.file.read(path), options.file.read(leasePath), options.file.read(claudeIsolationLeaseRegistryPath)
        ])
        let registry: ClaudeIsolationLeaseTarget | undefined
        try { registry = parseClaudeIsolationLeaseTarget(currentRegistry) } catch { throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED') }
        if (registry !== undefined && registry.targetIdentity !== targetIdentity) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
        if (rawLease === undefined) {
          if (registry === undefined) return 'none' as const
          await replaceConfigurationTransaction(options.file, [{ path: claudeIsolationLeaseRegistryPath, before: currentRegistry, after: undefined }], { backupAction: 'restore' })
          return 'none' as const
        }
        let lease
        try { lease = parseApplicationIsolationLease(rawLease) } catch { throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED') }
        // A registry and sidecar that disagree are never jointly owned. Preserve the unknown
        // sidecar but settle the Toolbox registry so it cannot authorize a later write.
        if (registry !== undefined && registry.leaseId !== lease.id) {
          await replaceConfigurationTransaction(options.file, [{ path: claudeIsolationLeaseRegistryPath, before: currentRegistry, after: undefined }], { backupAction: 'restore' })
          return 'preserved-external' as const
        }
        const currentFingerprint = current === undefined ? undefined : safeClaudeIsolationFingerprint(current)
        const owned = currentFingerprint !== undefined && (currentFingerprint === lease.beforeFingerprint || currentFingerprint === lease.expectedFingerprint)
        if (!owned) {
          await replaceConfigurationTransaction(options.file, [
            { path: leasePath, before: rawLease, after: undefined },
            ...(registry === undefined ? [] : [{ path: claudeIsolationLeaseRegistryPath, before: currentRegistry, after: undefined }])
          ], { backupAction: 'restore' })
          return 'preserved-external' as const
        }
        const restored = currentFingerprint === lease.beforeFingerprint ? current : restoreClaudeManagedSection(current!, lease.beforeBlock)
        await replaceConfigurationTransaction(options.file, [
          { path, before: current, after: restored, validate: value => { if (value !== undefined) JSON.parse(value) } },
          { path: leasePath, before: rawLease, after: undefined },
          ...(registry === undefined ? [] : [{ path: claudeIsolationLeaseRegistryPath, before: currentRegistry, after: undefined }])
        ], { backupAction: 'restore' })
        return 'restored' as const
      })
    },
    readCurrentBaseUrl: async () => {
      try {
        const contents = await options.file.read(configurationPath(await claudeTarget.forRead()))
        if (contents === undefined) return undefined
        const parsed = JSON.parse(contents) as { env?: { ANTHROPIC_BASE_URL?: unknown } }
        return typeof parsed.env?.ANTHROPIC_BASE_URL === 'string' ? parsed.env.ANTHROPIC_BASE_URL : undefined
      } catch { return undefined }
    },
    configurationTargetStatus: () => claudeTarget.status(),
    configurationTargetIdentity: () => configurationTargetIdentity(claudeTarget),
    selectConfigurationTarget: (scope) => claudeTarget.select(scope),
    selectConfigurationProject: (projectDir) => claudeTarget.selectProject(projectDir),
    deactivateToolboxConnection: async () => (await claudeConfig('deepseek')).deactivateToolboxConnection(),
    restorePreviousConnection: async () => (await claudeConfig('deepseek')).restorePreviousConnection(),
    activateOfficial: async () => (await claudeConfig('deepseek')).deactivateToolboxConnection()
  }, {
    shell: 'hermes',
    applyDeepSeek: async (key) => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      await applyHermesProvider('deepseek', key, configurationPath(target), options.file, hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)), hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform)), findHermesForTarget(target), execution.runHermes, execution.readHermesSettings)
    },
    applyProvider: async (provider, key) => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      await applyHermesProvider(provider, key, configurationPath(target), options.file, hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)), hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform)), findHermesForTarget(target), execution.runHermes, execution.readHermesSettings)
    },
    applyConnection: async (provider, connection) => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      await applyHermesConnection(provider, connection, options.file, hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)), hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform)), findHermesForTarget(target), execution.runHermes, execution.readHermesSettings)
    },
    applyIsolationConnection: async (provider, connection, expectedIsolationFingerprint, leaseId, capturedTargetIdentity) => {
      if (capturedTargetIdentity === undefined || capturedTargetIdentity !== await currentHermesIsolationTargetIdentity()) return 'stale'
      return applyHermesIsolationConnection(await hermesIsolationFiles(await hermesIsolationTarget(capturedTargetIdentity)),
        provider, connection, expectedIsolationFingerprint, leaseId)
    },
    captureIsolation: async () => {
      const target = await hermesTarget.forWrite()
      const files = await hermesIsolationFiles(target)
      await retainHermesIsolationTarget(options.file, hermesIsolationRegistryPath, options.platform,
        directoryOf(configurationPath(target), options.platform))
      return captureHermesIsolation(files)
    },
    captureConnection: async () => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      return captureHermesConnection(findHermesForTarget(target), execution.runHermes, execution.readHermesSettings,
        options.file, hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)),
        hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform)))
    },
    deactivateToolboxConnection: async () => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      const command = await findHermesForTarget(target)()
      if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
      return deactivateHermesConnection({
        file: options.file, command, run: execution.runHermes, read: execution.readHermesSettings,
        envPath: hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)),
        backupPath: hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform))
      })
    },
    restorePreviousConnection: async () => {
      const target = await hermesTarget.forWrite()
      const execution = hermesExecution(target)
      const command = await findHermesForTarget(target)()
      if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
      return restoreHermesPreviousConnection({
        file: options.file, command, run: execution.runHermes, read: execution.readHermesSettings,
        envPath: hermesEnvPath(options.platform, directoryOf(configurationPath(target), options.platform)),
        backupPath: hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform))
      })
    },
    // 解除后的「恢复接入前配置」入口按这个可见性展示：没有可信恢复点就如实说明，⛔ 摆一个必然失败的按钮。
    recoveryPointStatus: async () => {
      const target = await hermesTarget.forRead()
      return inspectModelApiBackup(await options.file.read(hermesBackupPath(options.platform, directoryOf(configurationPath(target), options.platform)))).kind === 'valid'
    },
    configurationTargetStatus: () => hermesTarget.status(),
    configurationTargetIdentity: () => configurationTargetIdentity(hermesTarget),
    selectConfigurationTarget: (scope) => hermesTarget.select(scope),
    readCurrentBaseUrl: async () => {
      try {
        const execution = hermesExecution(await hermesTarget.forRead())
        const yaml = await readHermesConfigYamlSettings(options.file, execution.config)
        return yaml?.['model.base_url']
      } catch { return undefined }
    },
    readManagedFingerprint: async () => {
      const execution = hermesExecution(await hermesTarget.forRead())
      const yaml = await readHermesConfigYamlSettings(options.file, execution.config)
      // This runs on the ten-minute recovery poll. If Hermes' local document cannot be read,
      // report an unknown fingerprint rather than spawning six `config get` child processes.
      // The explicit apply/capture flows retain the serial CLI fallback below.
      if (yaml === undefined) throw new Error('AI_ACCESS_CONFIGURATION_FINGERPRINT_UNAVAILABLE')
      return managedFingerprint(hermesManagedSection(yaml))
    },
    readIsolationFingerprint: async (capturedTargetIdentity) => {
      const target = capturedTargetIdentity === undefined ? await hermesTarget.forRead() : await hermesIsolationTarget(capturedTargetIdentity)
      const execution = hermesExecution(target)
      const yaml = await readHermesConfigYamlSettings(options.file, execution.config)
      if (yaml === undefined) throw new Error('AI_ACCESS_CONFIGURATION_FINGERPRINT_UNAVAILABLE')
      return hermesSettingsFingerprint(yaml)
    },
    isolationTargetIdentity: currentHermesIsolationTargetIdentity,
    recoverIsolationLease: async () => {
      const targets = await readHermesIsolationTargets(options.file, hermesIsolationRegistryPath, options.platform)
      if (targets.length === 0) return 'none'
      let outcome: 'none' | 'restored' | 'preserved-external' = 'none'
      for (const target of targets) {
        const result = await recoverHermesIsolationLease(await hermesIsolationFiles(await hermesIsolationTarget(target.identity)))
        await removeHermesIsolationTarget(options.file, hermesIsolationRegistryPath, options.platform, target.identity)
        if (result === 'preserved-external') outcome = 'preserved-external'
        else if (result === 'restored' && outcome === 'none') outcome = 'restored'
      }
      return outcome
    },
    clearIsolationLease: async (leaseId, capturedTargetIdentity) => {
      if (capturedTargetIdentity === undefined) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
      await clearHermesIsolationLease(await hermesIsolationFiles(await hermesIsolationTarget(capturedTargetIdentity)), leaseId)
      await removeHermesIsolationTarget(options.file, hermesIsolationRegistryPath, options.platform, capturedTargetIdentity)
    }
  }]
}

function codexManagedPaths(target: ConfigurationTarget, platform: NodeJS.Platform): readonly string[] {
  const directory = directoryOf(configurationPath(target), platform)
  return [
    configurationPath(target),
    joinPath(platform, directory, 'laixin-models.json'),
    joinPath(platform, directory, 'laixin-model-api-backup.json')
  ]
}

function claudeManagedPaths(target: ConfigurationTarget, platform: NodeJS.Platform): readonly string[] {
  const path = configurationPath(target)
  return [path, joinPath(platform, directoryOf(path, platform), 'laixin-model-api-backup.json')]
}

interface ConfigurationTargetManager {
  status(): Promise<ConfigurationTargetEvidence>
  select(scope: ExplicitConfigurationTargetScope): Promise<ConfigurationTargetEvidence>
  selectProject(projectDir: string): Promise<ConfigurationTargetEvidence>
  forWrite(): Promise<ConfigurationTarget>
  forRead(): Promise<ConfigurationTarget>
}

/**
 * Owns the unredacted target path only for this live adapter instance. Claude retains its chosen
 * project scope; Codex always resolves its user-level configuration and only reports project files
 * as diagnostics.
 */
function createConfigurationTargetManager(
  shell: ConfigurationTargetShell,
  options: DeepSeekAdapterOptions,
  userPath?: string
): ConfigurationTargetManager {
  const supportsProjectTarget = shell === 'claude'
  const initialProjectIsValid = options.projectDir === undefined || isAbsoluteDirectory(options.projectDir, options.platform)
  let projectDir = initialProjectIsValid ? options.projectDir : undefined
  let requiresProjectTarget = supportsProjectTarget && projectDir !== undefined
  let projectSelectionInvalid = supportsProjectTarget && !initialProjectIsValid
  let loadedPrivateProjectDirectory = false
  let selectedScope: ExplicitConfigurationTargetScope | undefined

  const selectedProjectDirectory = async (): Promise<string | undefined> => {
    if (projectDir !== undefined || loadedPrivateProjectDirectory || options.projectTargetStore === undefined || !supportsProjectTarget) return projectDir
    loadedPrivateProjectDirectory = true
    try {
      const stored = await options.projectTargetStore.selectedProjectDirectory(shell)
      if (stored !== undefined && !isAbsoluteDirectory(stored, options.platform)) {
        projectSelectionInvalid = true
        return undefined
      }
      projectDir = stored
      requiresProjectTarget = stored !== undefined
      // A stored directory can only be written after selectProject validated an existing project
      // config and persisted it. Restore that explicit decision for a port-rebind transaction.
      if (stored !== undefined) selectedScope = 'project'
      return projectDir
    } catch {
      projectSelectionInvalid = true
      return undefined
    }
  }

  const discover = async () => {
    const projectDirectory = await selectedProjectDirectory()
    const execution: ConfigurationExecutionContext | undefined = projectSelectionInvalid
      ? { source: 'unknown' }
      : await currentConfigurationExecution(options, shell)
    const targetOptions = {
      shell,
      home: options.home,
      projectDir: projectDirectory,
      // A freshly observed root wins only after currentConfigurationExecution verified that it
      // does not conflict with the Toolbox process's own root. The raw directory stays here in
      // the main process and never enters status evidence.
      userPath: execution?.userConfigPath ?? userPath,
      platform: options.platform,
      file: options.file
    }
    const discovered = await discoverConfigurationTargets({
      ...targetOptions,
      execution
    })
    // Once the customer chose a project, loss of that exact project config must not make a
    // recovery poll fall through to ~/.codex or ~/.claude. It remains an unknown target until
    // the customer selects a valid project again.
    return requiresProjectTarget && discovered.effective.scope !== 'project'
      ? discoverConfigurationTargets({ ...targetOptions, execution: { source: 'unknown' } })
      : discovered
  }

  const selected = async (scope: ExplicitConfigurationTargetScope): Promise<ConfigurationTarget> => {
    if (!supportsProjectTarget && scope === 'project') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    return selectConfigurationTarget(await discover(), scope)
  }

  return {
    async status() {
      return configurationTargetEvidence((await discover()).effective)
    },
    async select(scope) {
      const target = await selected(scope)
      selectedScope = scope
      return configurationTargetEvidence(target)
    },
    async selectProject(nextProjectDir) {
      if (!supportsProjectTarget || !isAbsoluteDirectory(nextProjectDir, options.platform)) {
        throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      }
      const previousProjectDir = projectDir
      const previousRequiresProjectTarget = requiresProjectTarget
      const previousSelectionInvalid = projectSelectionInvalid
      const previousLoadedPrivateProjectDirectory = loadedPrivateProjectDirectory
      projectDir = nextProjectDir
      requiresProjectTarget = true
      projectSelectionInvalid = false
      loadedPrivateProjectDirectory = true
      try {
        const target = await selected('project')
        await options.projectTargetStore?.saveSelectedProjectDirectory(shell, nextProjectDir)
        selectedScope = 'project'
        return configurationTargetEvidence(target)
      } catch (error) {
        projectDir = previousProjectDir
        requiresProjectTarget = previousRequiresProjectTarget
        projectSelectionInvalid = previousSelectionInvalid
        loadedPrivateProjectDirectory = previousLoadedPrivateProjectDirectory
        throw error
      }
    },
    async forWrite() {
      const discovery = await discover()
      const target = selectedScope === undefined ? discovery.effective : selectConfigurationTarget(discovery, selectedScope)
      if (!target.writable || target.path === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      return target
    },
    async forRead() {
      const discovery = await discover()
      if (selectedScope !== undefined) {
        return selectConfigurationTarget(discovery, selectedScope)
      }
      if (discovery.effective.path === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
      return discovery.effective
    }
  }
}

async function currentConfigurationExecution(
  options: DeepSeekAdapterOptions,
  shell: AiAccessShell
): Promise<ConfigurationExecutionContext | undefined> {
  const initial = options.configurationExecution?.[shell]
  if (options.observeConfigurationExecution === undefined) return initial
  try {
    const observed = (await options.observeConfigurationExecution())[shell]
    if (observed === undefined) return initial
    // Finder and terminal can expose different roots. Never choose one silently: a mismatch
    // would make a successful write appear to configure the client while it reads another file.
    if (initial?.userConfigPath !== undefined && observed.userConfigPath !== undefined &&
      !sameConfigurationPath(initial.userConfigPath, observed.userConfigPath, options.platform)) {
      return { source: 'unknown' }
    }
    return { ...initial, ...observed }
  } catch {
    // An observer failure leaves us unable to know whether a management or launch override wins.
    // Preserve the private user-root path for no caller, but make target selection fail closed.
    return { ...initial, source: 'unknown' }
  }
}

function sameConfigurationPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  return path.normalize(left) === path.normalize(right)
}

function isAbsoluteDirectory(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

function observedUserDirectoryContext(
  value: string | undefined,
  defaultDirectory: string,
  filename: string,
  platform: NodeJS.Platform
): ConfigurationExecutionContext | undefined {
  if (value === undefined || value === '') return undefined
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(value)) return { source: 'unknown' }
  return path.normalize(value) === path.normalize(defaultDirectory)
    ? undefined
    : { source: 'observed', userConfigPath: path.join(value, filename) }
}

function observedCodexHomeContext(value: string | undefined, defaultDirectory: string, platform: NodeJS.Platform): ConfigurationExecutionContext | undefined {
  if (value === undefined || value === '') return undefined
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(value)) return { source: 'unknown' }
  if (path.normalize(value) === path.normalize(defaultDirectory)) return undefined
  return { source: 'observed', userConfigPath: path.join(value, 'config.toml') }
}

function configurationPath(target: ConfigurationTarget): string {
  if (target.path === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  return target.path
}

/** The raw target path stays in the adapter; consumers receive only this opaque, per-target identity. */
async function configurationTargetIdentity(target: { forRead(): Promise<ConfigurationTarget> }): Promise<string | undefined> {
  try {
    const current = await target.forRead()
    return configurationTargetIdentityFor(current)
  } catch { return undefined }
}

function configurationTargetIdentityFor(target: ConfigurationTarget): string {
  if (target.path === undefined) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  return createHash('sha256').update(JSON.stringify([target.shell, target.scope, target.path])).digest('hex')
}

async function targetMatches(target: { forWrite(): Promise<ConfigurationTarget> }, expected: string | undefined): Promise<boolean> {
  if (expected === undefined) return true
  try { return configurationTargetIdentityFor(await target.forWrite()) === expected } catch { return false }
}

async function readCodexManagedFingerprint(file: ManagedTextFile, target: ConfigurationTarget): Promise<string | undefined> {
  return managedFingerprint(codexManagedSection(await file.read(configurationPath(target))))
}

function sameCodexIsolationFingerprint(contents: string, expected: string): boolean {
  return safeCodexIsolationFingerprint(contents) === expected
}

function safeCodexIsolationFingerprint(contents: string): string | undefined {
  try { return managedFingerprint(codexToolboxConnectionBlock(contents)) } catch { return undefined }
}

function sameClaudeIsolationFingerprint(contents: string, expected: string): boolean {
  return safeClaudeIsolationFingerprint(contents) === expected
}

function safeClaudeIsolationFingerprint(contents: string): string | undefined {
  return managedFingerprint(claudeManagedSection(contents))
}

/** Private, opaque pointer to the one Claude target with an unsettled Toolbox lease. */
interface ClaudeIsolationLeaseTarget {
  readonly version: 1
  readonly leaseId: string
  readonly targetIdentity: string
}

function renderClaudeIsolationLeaseTarget(target: Omit<ClaudeIsolationLeaseTarget, 'version'>): string {
  return JSON.stringify({ version: 1, ...target })
}

function validateClaudeIsolationLeaseTarget(contents: string | undefined): void {
  parseClaudeIsolationLeaseTarget(contents)
}

function parseClaudeIsolationLeaseTarget(raw: string | undefined): ClaudeIsolationLeaseTarget | undefined {
  if (raw === undefined) return undefined
  const value = JSON.parse(raw) as Record<string, unknown>
  if (value.version !== 1 || typeof value.leaseId !== 'string' || typeof value.targetIdentity !== 'string' ||
    Object.keys(value).length !== 3 || !/^[a-f0-9]{32}$/.test(value.leaseId) || !/^[a-f0-9]{64}$/.test(value.targetIdentity)) {
    throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
  }
  return { version: 1, leaseId: value.leaseId, targetIdentity: value.targetIdentity }
}

function withAdapterConfigWriteLock<T>(file: ManagedTextFile, lockPath: string, task: () => Promise<T>): Promise<T> {
  return file.withConfigWriteLock === undefined ? withConfigWriteLock(lockPath, task) : file.withConfigWriteLock(lockPath, task)
}

async function readClaudeManagedFingerprint(file: ManagedTextFile, target: ConfigurationTarget): Promise<string | undefined> {
  return managedFingerprint(claudeManagedSection(await file.read(configurationPath(target))))
}

async function captureHermesConnection(
  findCommand: () => Promise<string | undefined>,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader,
  file: ManagedTextFile,
  envPath: string,
  backupPath: string
): Promise<() => Promise<void>> {
  const command = await findCommand()
  if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
  const previous = await read(command)
  // 事务回滚边界不只六个模型值：本 PR 新增的恢复点文件和受影响的 .env 一起快照复原，
  // ⛔ 中途失败后留下半新半旧的恢复点让下次恢复拿到错值。
  const [env, backup] = await Promise.all([file.read(envPath), file.read(backupPath)])
  return async () => {
    await syncHermesModelSettings(command, previous, run, read)
    await replaceConfigurationTransaction(file, [
      { path: envPath, before: await file.read(envPath), after: env },
      { path: backupPath, before: await file.read(backupPath), after: backup }
    ])
    await assertHermesSettings(command, read, previous)
  }
}

function hermesBackupPath(platform: NodeJS.Platform, root: string): string {
  return joinPath(platform, root, 'laixin-model-api-backup.json')
}

/**
 * Persists the pre-activation model settings once, before the first toolbox takeover.
 * Later switches (换 Key、重开) keep that first recovery point so explicit recovery can always
 * return to the customer's own pre-toolbox configuration, surviving restarts — the
 * transaction-time capture closure above is never treated as a durable recovery point.
 * A config that is ALREADY a toolbox route with no historical backup is an old install:
 * ⛔ 冒充接入前配置——把工具箱自己的路由存进恢复点，解除后就永远回不到客户原值。
 */
async function captureHermesRecoveryPoint(file: ManagedTextFile, envPath: string, backupPath: string, previous: HermesModelSettings): Promise<boolean> {
  // 已是工具箱路由（旧安装）就不冒充接入前配置；已有恢复点不覆盖。
  if (isToolboxHermesRoute(previous) || hasHermesManagedEnvBlock(await file.read(envPath))) return false
  const existing = inspectModelApiBackup(await file.read(backupPath))
  if (existing.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  if (existing.kind === 'valid') return false
  await replaceConfigurationTransaction(file, [{
    path: backupPath,
    before: await file.read(backupPath),
    after: `${JSON.stringify({ version: 1, original: JSON.stringify(previous) })}\n`
  }])
  return true
}

function parseHermesBackupSettings(original: string | null): HermesModelSettings {
  // `null` records "the customer had nothing configured before takeover"; restoring empty matches that state.
  if (original === null) return unsetHermesSettings()
  let parsed: unknown
  try { parsed = JSON.parse(original) } catch (error) {
    throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT', { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  const entries = parsed as Record<string, unknown>
  if (Object.keys(entries).some((name) => !hermesModelKeys.includes(name as HermesModelKey))) {
    throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  }
  const values: Partial<Record<HermesModelKey, string | undefined>> = {}
  for (const key of hermesModelKeys) {
    const value = entries[key]
    if (value !== undefined && typeof value !== 'string') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
    values[key] = value
  }
  return values as HermesModelSettings
}

function unsetHermesSettings(): HermesModelSettings {
  return Object.fromEntries(hermesModelKeys.map((key) => [key, undefined])) as HermesModelSettings
}

const toolboxHermesRoute = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/hermes\/(deepseek|zhipu-api|zhipu|kimi|moonshot)\/v1$/

/** Gateway-era routes carry the toolbox loopback URL; direct-era routes carry the .env managed block. */
function isToolboxHermesRoute(settings: HermesModelSettings): boolean {
  return settings['model.provider'] === 'custom' && toolboxHermesRoute.test(settings['model.base_url'] ?? '')
}

/** The six keys still exactly match what a direct-path takeover by this provider would have written. */
function matchesDirectHermesTakeover(current: HermesModelSettings, provider: ModelProviderId): boolean {
  const definition = modelProvider(provider).hermes
  const expected = directHermesSettings(provider, definition.provider, definition.model)
  return hermesModelKeys.every((key) => current[key] === expected[key])
}

interface HermesConnectionFiles {
  readonly file: ManagedTextFile
  readonly command: string
  readonly run: (command: string, args: readonly string[]) => Promise<void>
  readonly read: HermesSettingsReader
  readonly envPath: string
  readonly backupPath: string
}

/**
 * N-58 keeps its lease separate from Hermes' pre-Toolbox recovery point. The durable record
 * contains only opaque identities and six-field digests: customer Keys, models, protocol values
 * and endpoint text remain in Hermes' existing configuration/state rather than becoming lease data.
 */
interface HermesIsolationLease {
  readonly version: 1
  readonly id: string
  readonly targetIdentity: string
  readonly beforeFingerprint: string
  readonly expectedFingerprint?: string
}

interface HermesIsolationFiles {
  readonly file: ManagedTextFile
  readonly lockPath: string
  readonly leasePath: string
  readonly targetIdentity: string
  readonly command: string
  readonly run: (command: string, args: readonly string[]) => Promise<void>
  readonly read: HermesSettingsReader
}

/** Main-process-only locator for an unfinished lease whose HERMES_HOME later changed. */
interface HermesIsolationTargetRecord {
  readonly identity: string
  readonly root: string
}
interface HermesIsolationTargetRegistry {
  readonly version: 1
  readonly targets: readonly HermesIsolationTargetRecord[]
}

function hermesIsolationTargetIdentity(platform: NodeJS.Platform, root: string): string {
  return createHash('sha256').update(`${platform}:${root}`).digest('hex')
}

function isAbsoluteHermesRoot(platform: NodeJS.Platform, root: string): boolean {
  return platform === 'win32' ? win32.isAbsolute(root) : posix.isAbsolute(root)
}

function parseHermesIsolationTargets(contents: string | undefined, platform: NodeJS.Platform): HermesIsolationTargetRegistry {
  if (contents === undefined) return { version: 1, targets: [] }
  let value: unknown
  try { value = JSON.parse(contents) } catch { throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.targets) || !Object.keys(record).every(key => key === 'version' || key === 'targets')) {
    throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
  }
  const targets: HermesIsolationTargetRecord[] = []
  for (const item of record.targets) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
    const target = item as Record<string, unknown>
    if (typeof target.identity !== 'string' || !/^[0-9a-f]{64}$/.test(target.identity) ||
        typeof target.root !== 'string' || !isAbsoluteHermesRoot(platform, target.root) ||
        target.identity !== hermesIsolationTargetIdentity(platform, target.root) ||
        !Object.keys(target).every(key => key === 'identity' || key === 'root')) {
      throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
    }
    if (targets.some(existing => existing.identity === target.identity)) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
    targets.push({ identity: target.identity, root: target.root })
  }
  return { version: 1, targets }
}

function renderHermesIsolationTargets(targets: readonly HermesIsolationTargetRecord[]): string {
  return `${JSON.stringify({ version: 1, targets })}\n`
}

async function readHermesIsolationTargets(file: ManagedTextFile, registryPath: string, platform: NodeJS.Platform): Promise<readonly HermesIsolationTargetRecord[]> {
  return parseHermesIsolationTargets(await file.read(registryPath), platform).targets
}

async function readHermesIsolationTarget(file: ManagedTextFile, registryPath: string, platform: NodeJS.Platform, identity: string): Promise<string> {
  const target = (await readHermesIsolationTargets(file, registryPath, platform)).find(item => item.identity === identity)
  if (target === undefined) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
  return target.root
}

async function retainHermesIsolationTarget(file: ManagedTextFile, registryPath: string, platform: NodeJS.Platform, root: string): Promise<void> {
  if (!isAbsoluteHermesRoot(platform, root)) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
  const identity = hermesIsolationTargetIdentity(platform, root)
  await withAdapterConfigWriteLock(file, `${registryPath}.lock`, async () => {
    const before = await file.read(registryPath)
    const registry = parseHermesIsolationTargets(before, platform)
    if (registry.targets.some(target => target.identity === identity)) return
    const after = renderHermesIsolationTargets([...registry.targets, { identity, root }])
    await replaceConfigurationTransaction(file, [{ path: registryPath, before, after }], { backupAction: 'apply' })
  })
}

async function removeHermesIsolationTarget(file: ManagedTextFile, registryPath: string, platform: NodeJS.Platform, identity: string): Promise<void> {
  await withAdapterConfigWriteLock(file, `${registryPath}.lock`, async () => {
    const before = await file.read(registryPath)
    const registry = parseHermesIsolationTargets(before, platform)
    const targets = registry.targets.filter(target => target.identity !== identity)
    if (targets.length === registry.targets.length) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
    await replaceConfigurationTransaction(file, [{ path: registryPath, before,
      after: targets.length === 0 ? undefined : renderHermesIsolationTargets(targets) }], { backupAction: 'restore' })
  })
}

function hermesSettingsFingerprint(settings: HermesModelSettings): string {
  return createHash('sha256').update(JSON.stringify(hermesModelKeys.map(key => [key, settings[key]]))).digest('hex')
}

function sameHermesSettings(left: HermesModelSettings, right: HermesModelSettings): boolean {
  return hermesModelKeys.every(key => left[key] === right[key])
}

function renderHermesIsolationLease(lease: HermesIsolationLease): string {
  return `${JSON.stringify(lease)}\n`
}

function parseHermesIsolationLease(contents: string | undefined): HermesIsolationLease {
  let value: unknown
  try { value = contents === undefined ? undefined : JSON.parse(contents) } catch { throw new Error('AI_ACCESS_HERMES_ISOLATION_LEASE_CORRUPT') }
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI_ACCESS_HERMES_ISOLATION_LEASE_CORRUPT')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.id) ||
      typeof record.targetIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(record.targetIdentity) ||
      typeof record.beforeFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.beforeFingerprint) ||
      (record.expectedFingerprint !== undefined && (typeof record.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.expectedFingerprint))) ||
      !Object.keys(record).every(key => ['version', 'id', 'targetIdentity', 'beforeFingerprint', 'expectedFingerprint'].includes(key))) {
    throw new Error('AI_ACCESS_HERMES_ISOLATION_LEASE_CORRUPT')
  }
  return record as unknown as HermesIsolationLease
}

async function captureHermesIsolation(input: HermesIsolationFiles): Promise<{
  readonly beforeFingerprint: string
  readonly beforeIsolationFingerprint: string
  readonly leaseId: string
  readonly targetIdentity: string
  readonly restoreIfOwned: (expectedFingerprint?: string) => Promise<'restored' | 'preserved-external'>
}> {
  return withAdapterConfigWriteLock(input.file, input.lockPath, async () => {
    const [previous, rawLease] = await Promise.all([input.read(input.command), input.file.read(input.leasePath)])
    if (rawLease !== undefined) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
    const beforeIsolationFingerprint = hermesSettingsFingerprint(previous)
    const beforeFingerprint = managedFingerprint(hermesManagedSection(previous))
    if (beforeFingerprint === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    const lease: HermesIsolationLease = {
      version: 1,
      id: randomUUID(),
      targetIdentity: input.targetIdentity,
      beforeFingerprint: beforeIsolationFingerprint
    }
    await replaceConfigurationTransaction(input.file, [{ path: input.leasePath, before: rawLease, after: renderHermesIsolationLease(lease) }], { backupAction: 'apply' })
    return {
      beforeFingerprint,
      beforeIsolationFingerprint,
      leaseId: lease.id,
      targetIdentity: input.targetIdentity,
      restoreIfOwned: async (expectedFingerprint) => withAdapterConfigWriteLock(input.file, input.lockPath, async () => {
        const raw = await input.file.read(input.leasePath)
        let currentLease: HermesIsolationLease
        try { currentLease = parseHermesIsolationLease(raw) } catch { return 'preserved-external' as const }
        if (currentLease.id !== lease.id || currentLease.targetIdentity !== input.targetIdentity) return 'preserved-external' as const
        const current = await input.read(input.command)
        const expected = expectedFingerprint ?? lease.beforeFingerprint
        if (hermesSettingsFingerprint(current) !== expected) return 'preserved-external' as const
        // N-58 writes the already-active local-gateway six-field binding. A failed in-process
        // update is reversed before this callback; a matching readback means there is nothing to
        // recreate, and the controller may safely clear only this lease.
        return 'restored' as const
      })
    }
  })
}

async function applyHermesIsolationConnection(
  input: HermesIsolationFiles,
  provider: ModelProviderId,
  connection: ApiServiceConnection,
  capturedFingerprint: string,
  leaseId: string
): Promise<'stale' | { readonly outcome: 'applied'; readonly managedFingerprint: string; readonly isolationFingerprint: string }> {
  if (!new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{1,5}/hermes/${provider}/v1$`).test(connection.baseUrl)) {
    throw new Error('AI_ACCESS_CONNECTION_INVALID')
  }
  return withAdapterConfigWriteLock(input.file, input.lockPath, async () => {
    const [rawLease, current] = await Promise.all([input.file.read(input.leasePath), input.read(input.command)])
    const lease = parseHermesIsolationLease(rawLease)
    const expected = localHermesSettings(provider, connection)
    if (lease.id !== leaseId || lease.targetIdentity !== input.targetIdentity || lease.beforeFingerprint !== capturedFingerprint ||
        lease.expectedFingerprint !== undefined || hermesSettingsFingerprint(current) !== capturedFingerprint || !sameHermesSettings(current, expected)) {
      return 'stale'
    }
    const expectedFingerprint = hermesSettingsFingerprint(expected)
    const managedFingerprintAfterWrite = managedFingerprint(hermesManagedSection(expected))
    if (managedFingerprintAfterWrite === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    await replaceConfigurationTransaction(input.file, [{
      path: input.leasePath,
      before: rawLease,
      after: renderHermesIsolationLease({ ...lease, expectedFingerprint })
    }], { backupAction: 'apply' })
    await syncHermesModelSettingsWithRollback(input.command, expected, current, input.run, input.read)
    await assertHermesSettings(input.command, input.read, expected)
    return { outcome: 'applied', managedFingerprint: managedFingerprintAfterWrite, isolationFingerprint: expectedFingerprint }
  })
}

async function recoverHermesIsolationLease(input: HermesIsolationFiles): Promise<'none' | 'restored' | 'preserved-external'> {
  return withAdapterConfigWriteLock(input.file, input.lockPath, async () => {
    const rawLease = await input.file.read(input.leasePath)
    if (rawLease === undefined) return 'none' as const
    const lease = parseHermesIsolationLease(rawLease)
    const current = await input.read(input.command)
    const currentFingerprint = hermesSettingsFingerprint(current)
    const owned = lease.targetIdentity === input.targetIdentity &&
      (currentFingerprint === lease.beforeFingerprint || currentFingerprint === lease.expectedFingerprint)
    await replaceConfigurationTransaction(input.file, [{ path: input.leasePath, before: rawLease, after: undefined }], { backupAction: 'restore' })
    // Startup recovery never recreates a session or writes six fields. A nonmatching customer
    // final value is left intact; a matching value was already the pre-isolation binding.
    return owned ? 'restored' as const : 'preserved-external' as const
  })
}

async function clearHermesIsolationLease(input: HermesIsolationFiles, leaseId: string): Promise<void> {
  await withAdapterConfigWriteLock(input.file, input.lockPath, async () => {
    const rawLease = await input.file.read(input.leasePath)
    if (rawLease === undefined) return
    const lease = parseHermesIsolationLease(rawLease)
    // A different durable lease is not ours to discard. Keep its target locator so startup can
    // settle it at the exact captured root instead of silently losing the recovery path.
    if (lease.id !== leaseId) throw new Error('AI_ACCESS_ISOLATION_RECOVERY_REQUIRED')
    if (lease.targetIdentity !== input.targetIdentity) throw new Error('AI_ACCESS_HERMES_ISOLATION_TARGET_UNKNOWN')
    await replaceConfigurationTransaction(input.file, [{ path: input.leasePath, before: rawLease, after: undefined }], { backupAction: 'restore' })
  })
}

/**
 * 解除工具箱接管（两步语义的第一步）：只撤销工具箱自己写入的管理——六个受管设置清空、
 * 旧直连 .env 托管块移除、客户自己的 .env 变量保留。恢复点 ⛔ 在这一步消费或冒充恢复；
 * 显式恢复（restoreHermesPreviousConnection）是独立的第二步。
 * 恢复点损坏、配置已被外部改写为非工具箱形态都如实拒绝；客户自己的设置 ⛔ 盲写覆盖。
 */
async function deactivateHermesConnection(input: HermesConnectionFiles): Promise<void> {
  const { file, command, run, read, envPath, backupPath } = input
  const current = await read(command)
  const backup = inspectModelApiBackup(await file.read(backupPath))
  if (backup.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  const envContents = await file.read(envPath)
  const envOwner = hermesManagedEnvOwner(envContents)
  const deactivateValues = unsetHermesSettings()
  const routePresent = isToolboxHermesRoute(current)
  if (!routePresent && envOwner === undefined) {
    // 已不处于工具箱接管：解除后的干净形态幂等成功；其他形态属于外部配置，⛔ 当成可解除对象改写。
    if (backup.kind !== 'valid' || !hermesModelKeys.every((key) => current[key] === undefined)) {
      throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    }
    return
  }
  // 六个模型键只有在 config.yaml 仍是工具箱写下的形态时才归我们清空：
  // 旧直连客户后来手工改过（.env 块还在但键值已变）就只移除自己的托管块，⛔ 清空客户新配置。
  const keysOwned = routePresent || (envOwner !== undefined && matchesDirectHermesTakeover(current, envOwner))
  try {
    if (keysOwned) {
      await syncHermesModelSettings(command, deactivateValues, run, read)
    }
    await removeHermesManagedEnvBlock(file, envPath, 'deactivate')
    if (keysOwned) {
      await assertHermesSettings(command, read, deactivateValues)
    }
  } catch (error) {
    if (keysOwned) {
      try { await syncHermesModelSettings(command, current, run, read) } catch (rollbackError) {
        throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
      }
    }
    throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: error })
  }
  // 恢复点保留：显式恢复（第二步）在客户确认后找回接入前配置并消费它。
}

/**
 * 显式恢复接入前连接（两步语义的第二步）：只认仍然存在的可信恢复点；缺失或客户已手工
 * 改配置时如实拒绝，⛔ 把猜出来的值或外部改写盖掉冒充恢复成功。恢复点消费在同一个失败
 * 边界内：消费失败时配置回滚到恢复前状态，恢复点保留供重试。
 * `original === null` 记录的是「接管前什么都没有」，恢复为全空与原状态一致。
 */
async function restoreHermesPreviousConnection(input: HermesConnectionFiles): Promise<void> {
  const { file, command, run, read, envPath, backupPath } = input
  const current = await read(command)
  const backup = inspectModelApiBackup(await file.read(backupPath))
  if (backup.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
  if (backup.kind === 'missing') throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  const restoreValues = parseHermesBackupSettings(backup.original)
  const deactivatedForm = hermesModelKeys.every((key) => current[key] === undefined)
  if (!deactivatedForm && !isToolboxHermesRoute(current)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  try {
    await syncHermesModelSettings(command, restoreValues, run, read)
    await removeHermesManagedEnvBlock(file, envPath, 'restore')
    await assertHermesSettings(command, read, restoreValues)
    await replaceConfigurationTransaction(file, [{ path: backupPath, before: await file.read(backupPath), after: undefined }], { backupAction: 'restore' })
  } catch (error) {
    try { await syncHermesModelSettings(command, current, run, read) } catch (rollbackError) {
      throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
    }
    throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: error })
  }
}

async function applyHermesProvider(
  provider: ModelProviderId,
  key: string,
  path: string,
  file: ManagedTextFile,
  envPath: string,
  backupPath: string,
  findCommand: () => Promise<string | undefined>,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader
): Promise<void> {
  const command = await findCommand()
  if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
  const config = createHermesModelApiConfig(provider, '', file, path)
  await config.assertWritable()
  const previous = await read(command)
  const createdRecoveryPoint = await captureHermesRecoveryPoint(file, envPath, backupPath, previous)
  try {
    const definition = modelProvider(provider).hermes
    const expected = directHermesSettings(provider, definition.provider, definition.model)
    await syncHermesModelSettings(command, expected, run, read)
    await config.apply(key)
    await assertHermesSettings(command, read, expected)
  } catch (error) {
    // 失败的首次接管不能留下本次新建的恢复点：客户随后手工改配置再接入时，⛔ 被这份假恢复点覆盖。
    if (createdRecoveryPoint) {
      try {
        await replaceConfigurationTransaction(file, [{ path: backupPath, before: await file.read(backupPath), after: undefined }])
      } catch (removalError) {
        try { await syncHermesModelSettings(command, previous, run, read) } catch (rollbackError) {
          throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
        }
        throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: removalError })
      }
    }
    try { await syncHermesModelSettings(command, previous, run, read) } catch (rollbackError) {
      throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
    }
    throw new Error('AI_ACCESS_HERMES_CONFIG_FAILED', { cause: error })
  }
}

async function applyHermesConnection(
  provider: ModelProviderId,
  connection: ApiServiceConnection,
  file: ManagedTextFile,
  envPath: string,
  backupPath: string,
  findCommand: () => Promise<string | undefined>,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader
): Promise<void> {
  if (!new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{1,5}/hermes/${provider}/v1$`).test(connection.baseUrl)) {
    throw new Error('AI_ACCESS_CONNECTION_INVALID')
  }
  const command = await findCommand()
  if (command === undefined) throw new Error('AI_ACCESS_HERMES_NOT_INSTALLED')
  const previous = await read(command)
  const createdRecoveryPoint = await captureHermesRecoveryPoint(file, envPath, backupPath, previous)
  try {
    const expected = localHermesSettings(provider, connection)
    await syncHermesModelSettings(command, expected, run, read)
    await assertHermesSettings(command, read, expected)
  } catch (error) {
    // 失败的首次接管不能留下本次新建的恢复点：客户随后手工改配置再接入时，⛔ 被这份假恢复点覆盖。
    if (createdRecoveryPoint) {
      try {
        await replaceConfigurationTransaction(file, [{ path: backupPath, before: await file.read(backupPath), after: undefined }])
      } catch (removalError) {
        try { await syncHermesModelSettings(command, previous, run, read) } catch (rollbackError) {
          throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
        }
        throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: removalError })
      }
    }
    try { await syncHermesModelSettings(command, previous, run, read) } catch (rollbackError) {
      throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
    }
    throw new Error('AI_ACCESS_HERMES_CONFIG_FAILED', { cause: error })
  }
}

async function findHermesCommand(platform: NodeJS.Platform, root: string): Promise<string | undefined> {
  // Use the selected Hermes home for discovery, but trust the executable by its own fixed
  // virtualenv layout and console-script content. Never execute a generic PATH hit: a wrapper
  // named `hermes` can mutate local proxy state.
  for (const candidate of trustedHermesCommandCandidates(platform, root)) {
    if (await trustedHermesExecutable(candidate, platform)) return candidate
  }
  return undefined
}

export function resolveHermesHome(platform: NodeJS.Platform, home: string, localAppData?: string, configuredHome?: string): string {
  if (configuredHome !== undefined) {
    const absolute = platform === 'win32' ? win32.isAbsolute(configuredHome) : posix.isAbsolute(configuredHome)
    if (absolute) return configuredHome
  }
  if (platform === 'win32') {
    const local = localAppData && win32.isAbsolute(localAppData) ? localAppData : win32.join(home, 'AppData', 'Local')
    return win32.join(local, 'hermes')
  }
  return join(home, '.hermes')
}

function directoryOf(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.dirname(path) : posix.dirname(path)
}

function joinPath(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? win32.join(...segments) : posix.join(...segments)
}

function hermesEnvPath(platform: NodeJS.Platform, root: string): string {
  return platform === 'win32' ? win32.join(root, '.env') : join(root, '.env')
}

function hermesConfigPath(platform: NodeJS.Platform, root: string): string {
  return platform === 'win32' ? win32.join(root, 'config.yaml') : join(root, 'config.yaml')
}

async function readHermesModelSettings(
  command: string,
  read: (command: string, key: HermesModelKey) => Promise<string | undefined>
): Promise<HermesModelSettings> {
  const values: Partial<Record<HermesModelKey, string | undefined>> = {}
  // Do not fan out six child processes. A serial fallback is only used when config.yaml is
  // unavailable, and it also avoids racing Hermes' own config-file lock.
  for (const key of hermesModelKeys) values[key] = await read(command, key)
  return values as HermesModelSettings
}

/** Reads only the six model scalars we manage; the document and any customer key stay in-process. */
async function readHermesConfigYamlSettings(file: ManagedTextFile, path: string): Promise<HermesModelSettings | undefined> {
  let contents: string | undefined
  try { contents = await file.read(path) } catch { return undefined }
  return contents === undefined ? undefined : parseHermesModelSettingsYaml(contents)
}

function parseHermesModelSettingsYaml(contents: string): HermesModelSettings | undefined {
  const values: Partial<Record<HermesModelKey, string | undefined>> = {}
  let inModelSection = false
  let foundModelSection = false
  for (const line of contents.replace(/\r\n?/g, '\n').split('\n')) {
    if (!inModelSection) {
      if (/^model:\s*(?:#.*)?$/.test(line)) {
        inModelSection = true
        foundModelSection = true
      }
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('#')) break
    const match = /^\s+([a-z_]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = `model.${match[1]}` as HermesModelKey
    if (!hermesModelKeys.includes(key)) continue
    values[key] = yamlScalar(match[2])
  }
  return foundModelSection ? values as HermesModelSettings : undefined
}

function yamlScalar(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '' || value.startsWith('#')) return undefined
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/.exec(value)
  if (quoted) return quoted[1].slice(1, -1)
  const comment = value.search(/\s+#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim() || undefined
}

function directHermesSettings(provider: ModelProviderId, configuredProvider: string, model: string): HermesModelSettings {
  return {
    'model.provider': configuredProvider,
    'model.default': model,
    'model.base_url': undefined,
    'model.api_key': undefined,
    // Every built-in provider listed here exposes an OpenAI Chat Completions endpoint.
    'model.api_mode': 'chat_completions',
    'model.context_length': contextLength(provider, model)
  }
}

function localHermesSettings(provider: ModelProviderId, connection: ApiServiceConnection): HermesModelSettings {
  const model = connection.model ?? modelProvider(provider).models.hermes
  return {
    'model.provider': 'custom',
    'model.default': model,
    'model.base_url': connection.baseUrl,
    'model.api_key': connection.apiKey,
    // The local gateway serves /chat/completions. Leaving a prior Anthropic mode in place yields a false 404.
    'model.api_mode': 'chat_completions',
    // An unknown recipe model must use Hermes' default rather than inheriting an unrelated stale cap.
    'model.context_length': contextLength(provider, model)
  }
}

function contextLength(provider: ModelProviderId, model: string): string | undefined {
  const value = providerModelWindow(provider, model)
  return value === undefined ? undefined : String(value)
}

/**
 * Hermes ≥0.21 的 `config unset` 对本就未设置的键以非零退出（"Config key not set"），
 * 而「键应为空」在这里全部表达成 unset。因此 unset 失败后必须复核键是否确实已缺失：
 * 已缺失即目标已达成（幂等成功）；仍存在才是真实失败。夹具按同一语义模拟真实 CLI。
 */
async function syncHermesModelSettings(
  command: string,
  next: HermesModelSettings,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader
): Promise<void> {
  for (const key of hermesModelKeys) await syncHermesModelSetting(command, key, next[key], run, read)
}

async function syncHermesModelSettingsWithRollback(
  command: string,
  next: HermesModelSettings,
  previous: HermesModelSettings,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader
): Promise<void> {
  const attempted: HermesModelKey[] = []
  try {
    for (const key of hermesModelKeys) {
      // Record before the CLI call: a process may mutate then report failure.
      attempted.push(key)
      await syncHermesModelSetting(command, key, next[key], run, read)
    }
    await assertHermesSettings(command, read, next)
  } catch (error) {
    try {
      const afterFailure = await read(command)
      for (const key of [...attempted].reverse()) {
        // A field that no longer equals our just-written target was changed by the customer or
        // Hermes during the command/readback window. It is no longer ours to roll back.
        if (afterFailure[key] !== next[key]) continue
        await syncHermesModelSetting(command, key, previous[key], run, read)
      }
      const afterRollback = await read(command)
      // When every field is still ours, retain the old strict rollback/readback contract. A
      // customer final value instead remains in place; the controller will release the lease
      // and transport as EXTERNAL_VALUE_PRESERVED.
      if (sameHermesSettings(afterRollback, previous)) await assertHermesSettings(command, read, previous)
    } catch (rollbackError) {
      throw new Error('AI_ACCESS_HERMES_ROLLBACK_FAILED', { cause: rollbackError })
    }
    throw error
  }
}

async function syncHermesModelSetting(
  command: string,
  key: HermesModelKey,
  value: string | undefined,
  run: (command: string, args: readonly string[]) => Promise<void>,
  read: HermesSettingsReader
): Promise<void> {
  if (value !== undefined) {
    await run(command, ['config', 'set', key, value])
    return
  }
  try {
    await run(command, ['config', 'unset', key])
  } catch (error) {
    const current = await read(command)
    if (current[key] !== undefined) throw error
  }
}

async function assertHermesSettings(
  command: string,
  read: HermesSettingsReader,
  expected: HermesModelSettings
): Promise<void> {
  const actual = await read(command)
  if (hermesModelKeys.some((key) => actual[key] !== expected[key])) {
    throw new Error('AI_ACCESS_HERMES_READBACK_FAILED')
  }
}

async function runHermesCommand(command: string, args: readonly string[], hermesHome: string, platform: NodeJS.Platform, source?: NodeJS.ProcessEnv): Promise<void> {
  await execFile(command, [...args], {
    windowsHide: true, timeout: 15_000, maxBuffer: 1_024,
    env: trustedHermesEnvironment(platform, hermesHome, source)
  })
}

async function readHermesConfigValue(command: string, key: HermesModelKey, hermesHome: string, platform: NodeJS.Platform, source?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(command, ['config', 'get', key], {
      windowsHide: true, timeout: 15_000, maxBuffer: 1_024,
      env: trustedHermesEnvironment(platform, hermesHome, source)
    })
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch { return undefined }
}
