import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { modelProvider, providerModelWindow, type ApiServiceConnection, type ModelProviderId } from '../../shared/model-providers'
import { type ConfigurationTarget } from './configuration-target'
import { inspectCodexOfficialAuthentication, type CodexOfficialAuthStatus } from './codex-auth-document'
import { codexToolboxSection, parseCodexTomlDocument, restoreCodexTomlConnection } from './codex-toml-document'
import { replaceConfigurationTransaction, withConfigWriteLock } from './config-write-guard'

export interface ManagedTextFile {
  read(path: string): Promise<string | undefined>
  write(path: string, contents: string): Promise<void>
  remove(path: string): Promise<void>
  /** 目录列举(可选):语义备份修剪用;不提供时跳过修剪。 */
  list?(dir: string): Promise<string[]>
  /** Test-only in-memory adapters provide their own lock. Production files omit this and must acquire the filesystem lock. */
  withConfigWriteLock?<T>(lockPath: string, task: () => Promise<T>): Promise<T>
}

export interface DeepSeekConfig {
  apply(key: string): Promise<void>
  /** Restores a valid pre-connection snapshot when removing the Toolbox route, then clears Toolbox sidecars. */
  deactivateToolboxConnection(): Promise<void>
  /** Explicitly restores a still-present pre-connection snapshot. */
  restorePreviousConnection(): Promise<void>
  /** @deprecated Compatibility alias. New callers must use deactivateToolboxConnection for “使用官方”. */
  restoreOfficial(): Promise<void>
  /** Codex only: verifies whether its remaining auth.json proves a ChatGPT login without returning credentials. */
  officialAuthenticationStatus?(): Promise<CodexOfficialAuthStatus>
}

export interface HermesDeepSeekConfig extends DeepSeekConfig {
  assertWritable(): Promise<void>
}

const managedEnvBegin = '# >>> Laixin AI Toolbox managed model connection >>>'
const managedEnvEnd = '# <<< Laixin AI Toolbox managed model connection <<<'
const managedCodexBegin = '# >>> Laixin AI Toolbox managed model connection >>>'
const managedCodexEnd = '# <<< Laixin AI Toolbox managed model connection <<<'
const legacyDeepSeekEnv = /^# Managed by Laixin AI Toolbox: DeepSeek connection\nDEEPSEEK_API_KEY=[A-Za-z0-9._-]{16,512}\nDEEPSEEK_BASE_URL=https:\/\/api\.deepseek\.com\/\n$/
const hermesManagedConnectionKey = 'LAIXIN_AI_TOOLBOX_MODEL_CONNECTION'
const hermesManagedProviderKey = 'LAIXIN_AI_TOOLBOX_PROVIDER'
const hermesManagedModelKey = 'LAIXIN_AI_TOOLBOX_MODEL'
const claudeManagedEnvKeys = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'LAIXIN_AI_TOOLBOX_MODEL_CONNECTION'
] as const

/**
 * Only Toolbox-owned keys are replaced. The customer's original config is backed up locally
 * before the first switch and restored exactly when they return to their official account.
 */
export function createCodexModelApiConfig(
  provider: ModelProviderId,
  home: string,
  file: ManagedTextFile,
  connection?: ApiServiceConnection,
  target?: ConfigurationTarget
): DeepSeekConfig {
  const configPath = configurationTargetPath('codex', join(home, '.codex', 'config.toml'), target)
  const configDirectory = dirname(configPath)
  const modelsPath = join(configDirectory, 'laixin-models.json')
  const backupPath = join(configDirectory, 'laixin-model-api-backup.json')
  const configLockPath = join(configDirectory, 'laixin-config.lock')
  // CODEX_HOME changes the whole Codex user root, including the credential document. Keep the
  // status check beside the effective config rather than accidentally classifying another profile.
  const authPath = join(configDirectory, 'auth.json')
  return {
    async apply(key) {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [config, backup, models] = await Promise.all([file.read(configPath), file.read(backupPath), file.read(modelsPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        // 备份还在、配置里却没有托管段（CC Switch 整文件重写、客户手工清理都会这样）时可以重建，
        // 但损坏备份绝不能被当前本地路由覆盖成“接入前配置”。
        const original = saved.kind === 'valid' ? saved.original : (isLegacyCodexConfig(config) ? null : config ?? null)
        const desiredConfig = mergeCodexConfig(config, renderCodexConfig(provider, connection, key, modelsPath))
        await replaceConfigurationTransaction(file, [
          { path: backupPath, before: backup, after: saved.kind === 'missing' ? renderBackup(original) : backup },
          { path: modelsPath, before: models, after: renderCodexModels(provider, connection?.model), validate: validateModelsJson },
          { path: configPath, before: config, after: desiredConfig, validate: validateCodexToml }
        ], { backupAction: 'apply' })
      })
    },
    async deactivateToolboxConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [config, models, backup] = await Promise.all([file.read(configPath), file.read(modelsPath), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (config === undefined) {
          if (saved.kind === 'valid') {
            await replaceConfigurationTransaction(file, [
              { path: configPath, before: config, after: saved.original ?? undefined, validate: validateCodexToml },
              { path: modelsPath, before: models, after: undefined },
              { path: backupPath, before: backup, after: undefined }
            ], { backupAction: 'deactivate' })
            return
          }
          if (models === undefined) return
          await replaceConfigurationTransaction(file, [{ path: modelsPath, before: models, after: undefined }], { backupAction: 'deactivate' })
          return
        }
        if (saved.kind === 'valid' && (isLegacyCodexConfig(config) || isToolboxCodexConnection(config))) {
          const desired = isLegacyCodexConfig(config) ? saved.original ?? undefined : restoreCodexTomlConnection(config, saved.original)
          await replaceConfigurationTransaction(file, [
            { path: configPath, before: config, after: desired, validate: validateCodexToml },
            { path: modelsPath, before: models, after: undefined },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'deactivate' })
          return
        }
        const desired = isLegacyCodexConfig(config) ? undefined : removeToolboxCodexConnection(config)
        await replaceConfigurationTransaction(file, [
          { path: configPath, before: config, after: desired, validate: validateCodexToml },
          { path: modelsPath, before: models, after: undefined }
        ], { backupAction: 'deactivate' })
      })
    },
    async restorePreviousConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [config, models, backup] = await Promise.all([file.read(configPath), file.read(modelsPath), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        if (saved.kind === 'missing') {
          if (config === undefined) return
          if (!isLegacyCodexConfig(config)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
          await replaceConfigurationTransaction(file, [
            { path: configPath, before: config, after: undefined },
            { path: modelsPath, before: models, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        if (config === undefined) {
          const desired = restoreCodexTomlConnection(config, saved.original)
          await replaceConfigurationTransaction(file, [
            { path: configPath, before: config, after: desired, validate: validateCodexToml },
            { path: modelsPath, before: models, after: undefined },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        const desired = isLegacyCodexConfig(config) ? saved.original ?? undefined : restoreCodexTomlConnection(config, saved.original)
        await replaceConfigurationTransaction(file, [
          { path: configPath, before: config, after: desired, validate: validateCodexToml },
          { path: modelsPath, before: models, after: undefined },
          { path: backupPath, before: backup, after: undefined }
        ], { backupAction: 'restore' })
      })
    },
    async restoreOfficial() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [config, models, backup] = await Promise.all([file.read(configPath), file.read(modelsPath), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        // Compatibility for old callers: if an external tool has already removed our route, do
        // not write that external configuration back; only discard legacy sidecars.
        if (saved.kind === 'valid' && config !== undefined && !isLegacyCodexConfig(config) && !isToolboxCodexConnection(config)) {
          await replaceConfigurationTransaction(file, [
            { path: modelsPath, before: models, after: undefined },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        if (saved.kind === 'valid' && config === undefined) {
          await replaceConfigurationTransaction(file, [
            { path: configPath, before: config, after: saved.original ?? undefined, validate: validateCodexToml },
            { path: modelsPath, before: models, after: undefined },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        if (saved.kind === 'missing' && config !== undefined && !isLegacyCodexConfig(config)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const desired = saved.kind === 'valid'
          ? isLegacyCodexConfig(config!) ? saved.original ?? undefined : restoreCodexTomlConnection(config!, saved.original)
          : undefined
        await replaceConfigurationTransaction(file, [
          { path: configPath, before: config, after: desired, validate: validateCodexToml },
          { path: modelsPath, before: models, after: undefined },
          { path: backupPath, before: backup, after: undefined }
        ], { backupAction: 'restore' })
      })
    },
    async officialAuthenticationStatus() {
      try { return inspectCodexOfficialAuthentication(await file.read(authPath)) } catch {
        return { state: 'login-required', reason: 'unrecognized-authentication' }
      }
    }
  }
}

/** Merges only the Claude endpoint environment fields, retaining all other user settings. */
export function createClaudeModelApiConfig(
  provider: ModelProviderId,
  home: string,
  file: ManagedTextFile,
  connection?: ApiServiceConnection,
  target?: ConfigurationTarget
): DeepSeekConfig {
  const path = configurationTargetPath('claude', join(home, '.claude', 'settings.json'), target)
  const configDirectory = dirname(path)
  const backupPath = join(configDirectory, 'laixin-model-api-backup.json')
  const configLockPath = join(configDirectory, 'laixin-config.lock')
  return {
    async apply(key) {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [current, backup] = await Promise.all([file.read(path), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        const original = saved.kind === 'valid' ? saved.original : (isLegacyClaudeSettings(current) ? null : current ?? null)
        const desired = mergeClaudeSettings(current, provider, connection, key)
        await replaceConfigurationTransaction(file, [
          { path: backupPath, before: backup, after: saved.kind === 'missing' ? renderBackup(original) : backup },
          { path, before: current, after: desired, validate: validateClaudeSettings }
        ], { backupAction: 'apply' })
      })
    },
    async deactivateToolboxConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [current, backup] = await Promise.all([file.read(path), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (current === undefined) {
          if (saved.kind !== 'valid') return
          await replaceConfigurationTransaction(file, [
            { path, before: current, after: saved.original ?? undefined, validate: validateClaudeSettings },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'deactivate' })
          return
        }
        if (!isLegacyClaudeSettings(current) && !isManagedClaudeSettings(current)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const desired = saved.kind === 'valid'
          ? isLegacyClaudeSettings(current) ? saved.original ?? undefined : restoreClaudeSettings(current, saved.original)
          : isLegacyClaudeSettings(current) ? undefined : restoreClaudeSettings(current, null)
        await replaceConfigurationTransaction(file, [
          { path, before: current, after: desired, validate: validateClaudeSettings },
          ...(saved.kind === 'valid' ? [{ path: backupPath, before: backup, after: undefined }] : [])
        ], { backupAction: 'deactivate' })
      })
    },
    async restorePreviousConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [current, backup] = await Promise.all([file.read(path), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        if (saved.kind === 'missing') {
          if (current === undefined) return
          if (!isLegacyClaudeSettings(current)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
          await replaceConfigurationTransaction(file, [{ path, before: current, after: undefined }], { backupAction: 'restore' })
          return
        }
        const legacy = isLegacyClaudeSettings(current)
        const managed = current !== undefined && isManagedClaudeSettings(current)
        if (!legacy && !managed) {
          // useOfficial removes the whole Toolbox-owned env block.  It is safe to restore the
          // explicit backup only if the remaining customer settings still equal that deactivated
          // form; a new/manual endpoint must never be overwritten as if it were official.
          if (!isDeactivatedClaudeSettingsEquivalentToBackup(current, saved.original)) throw new Error('AI_ACCESS_CONFIG_NOT_MANAGED')
          await replaceConfigurationTransaction(file, [
            { path, before: current, after: saved.original ?? undefined, validate: validateClaudeSettings },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        const desired = legacy ? saved.original ?? undefined : restoreClaudeSettings(current!, saved.original)
        await replaceConfigurationTransaction(file, [
          { path, before: current, after: desired, validate: validateClaudeSettings },
          { path: backupPath, before: backup, after: undefined }
        ], { backupAction: 'restore' })
      })
    },
    async restoreOfficial() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const [current, backup] = await Promise.all([file.read(path), file.read(backupPath)])
        const saved = inspectModelApiBackup(backup)
        if (saved.kind === 'corrupt') throw new Error('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
        if (saved.kind === 'valid' && current !== undefined && !isLegacyClaudeSettings(current) && !isManagedClaudeSettings(current)) {
          await replaceConfigurationTransaction(file, [{ path: backupPath, before: backup, after: undefined }], { backupAction: 'restore' })
          return
        }
        if (saved.kind === 'valid' && current === undefined) {
          await replaceConfigurationTransaction(file, [
            { path, before: current, after: saved.original ?? undefined, validate: validateClaudeSettings },
            { path: backupPath, before: backup, after: undefined }
          ], { backupAction: 'restore' })
          return
        }
        if (saved.kind === 'missing' && current !== undefined && !isLegacyClaudeSettings(current)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const desired = saved.kind === 'valid'
          ? isLegacyClaudeSettings(current!) ? saved.original ?? undefined : restoreClaudeSettings(current!, saved.original)
          : undefined
        await replaceConfigurationTransaction(file, [
          { path, before: current, after: desired, validate: validateClaudeSettings },
          { path: backupPath, before: backup, after: undefined }
        ], { backupAction: 'restore' })
      })
    }
  }
}

/**
 * Hermes uses an .env file. Unlike TOML/JSON, separate variables can coexist safely, so
 * unrelated customer variables are kept and only a named Toolbox block is replaced.
 */
export function createHermesModelApiConfig(
  provider: ModelProviderId,
  home: string,
  file: ManagedTextFile,
  path = join(home, '.hermes', '.env'),
  target?: ConfigurationTarget
): HermesDeepSeekConfig {
  const keyName = providerEnvKey(provider)
  const configPath = configurationTargetPath('hermes', path, target)
  const configLockPath = join(dirname(configPath), 'laixin-config.lock')
  return {
    async assertWritable() {
      const current = await file.read(configPath)
      if (current !== undefined && !canManageHermesEnv(current, keyName)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    },
    async apply(key) {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const current = await file.read(configPath)
        if (current !== undefined && !canManageHermesEnv(current, keyName)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        await replaceConfigurationTransaction(file, [{
          path: configPath, before: current, after: withManagedEnvBlock(current, hermesManagedValues(provider, key))
        }], { backupAction: 'apply' })
      })
    },
    async deactivateToolboxConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const current = await file.read(configPath)
        if (current === undefined) return
        if (!canManageHermesEnv(current, keyName)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const restored = withoutManagedEnvBlock(current)
        await replaceConfigurationTransaction(file, [{ path: configPath, before: current, after: restored === '' ? undefined : restored }], { backupAction: 'deactivate' })
      })
    },
    async restorePreviousConnection() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const current = await file.read(configPath)
        if (current === undefined) return
        if (!canManageHermesEnv(current, keyName)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const restored = withoutManagedEnvBlock(current)
        await replaceConfigurationTransaction(file, [{ path: configPath, before: current, after: restored === '' ? undefined : restored }], { backupAction: 'restore' })
      })
    },
    async restoreOfficial() {
      return withManagedConfigWriteLock(file, configLockPath, async () => {
        const current = await file.read(configPath)
        if (current === undefined) return
        if (!canManageHermesEnv(current, keyName)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
        const restored = withoutManagedEnvBlock(current)
        await replaceConfigurationTransaction(file, [{ path: configPath, before: current, after: restored === '' ? undefined : restored }], { backupAction: 'restore' })
      })
    }
  }
}

export function createCodexDeepSeekConfig(home: string, file: ManagedTextFile): DeepSeekConfig {
  return createCodexModelApiConfig('deepseek', home, file)
}

export function createClaudeDeepSeekConfig(home: string, file: ManagedTextFile): DeepSeekConfig {
  return createClaudeModelApiConfig('deepseek', home, file)
}

/**
 * 托管指纹：只覆盖工具箱自己写进去的那一段，客户自己的其他设置 ⛔ 算进来。
 * 取 sha256 存指纹，⛔ 把配置原文（含本机令牌）留在状态里。
 */
export function managedFingerprint(section: string | undefined): string | undefined {
  return section === undefined ? undefined : createHash('sha256').update(section).digest('hex')
}

/** Codex：语义托管段；第三方工具删掉注释后仍能识别同一条工具箱连接。 */
export function codexManagedSection(contents: string | undefined): string | undefined {
  if (contents === undefined) return undefined
  try { return codexToolboxSection(contents) } catch { return undefined }
}

/** Claude：settings.json 里工具箱负责的那些 env 键，按键名排序后规范化。 */
export function claudeManagedSection(contents: string | undefined): string | undefined {
  if (contents === undefined || !isManagedClaudeSettings(contents)) return undefined
  try {
    const env = parseClaudeSettings(contents).env
    if (!record(env)) return undefined
    const managed = Object.entries(env)
      .filter(([name]) => claudeManagedEnvKeys.includes(name as typeof claudeManagedEnvKeys[number]))
      .sort(([left], [right]) => left.localeCompare(right))
    return JSON.stringify(managed)
  } catch { return undefined }
}

/** Hermes：配置在它自己的 CLI 里，指纹取工具箱设过的六个键。 */
export function hermesManagedSection(settings: Readonly<Record<string, string | undefined>>): string | undefined {
  const provider = settings['model.provider']
  const model = settings['model.default']
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return JSON.stringify([['model.api_key', settings['model.api_key'] ?? ''], ['model.base_url', settings['model.base_url'] ?? ''],
    ['model.api_mode', settings['model.api_mode'] ?? ''], ['model.context_length', settings['model.context_length'] ?? ''],
    ['model.default', model], ['model.provider', provider]])
}

export function createHermesDeepSeekConfig(home: string, file: ManagedTextFile, path?: string): HermesDeepSeekConfig {
  return createHermesModelApiConfig('deepseek', home, file, path)
}

function renderCodexConfig(provider: ModelProviderId, connection: ApiServiceConnection | undefined, key: string, modelsPath: string): string {
  const definition = modelProvider(provider)
  const local = connection !== undefined
  const baseUrl = local ? codexConnectionUrl(connection) : definition.codex.baseUrl
  const modelName = connection?.model ?? definition.codex.model
  const providerName = local ? `laixin-${provider}-local` : `laixin-${provider}`
  const displayName = local ? 'Laixin Local API Service' : definition.codex.name
  const apiKey = connection?.apiKey ?? key
  return `${managedCodexBegin}
# Provider: ${provider}
# Managed by Laixin AI Toolbox: ${definition.title} connection
${local ? '# Connection: local API service\n' : ''}model = "${modelName}"
model_provider = "${providerName}"
forced_login_method = "api"
model_reasoning_effort = "high"
model_catalog_json = "${tomlString(modelsPath)}"

[model_providers.${providerName}]
name = "${displayName}"
base_url = "${baseUrl}"
wire_api = "responses"
experimental_bearer_token = "${apiKey}"
${managedCodexEnd}
`
}

function renderCodexModels(provider: ModelProviderId, selectedModel?: string): string {
  const definition = modelProvider(provider)
  const model = selectedModel ?? definition.codex.model
  const contextWindow = selectedModel ? providerModelWindow(provider, model) ?? definition.codex.contextWindow : definition.codex.contextWindow
  return `${JSON.stringify({ models: [{
    slug: model, prefer_websockets: false, support_verbosity: false, default_verbosity: 'low',
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', input_modalities: definition.codex.inputModalities,
    supports_image_detail_original: definition.codex.inputModalities.includes('image'), truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true, experimental_supported_tools: [], base_instructions: '', tool_mode: null, multi_agent_version: 'v2', use_responses_lite: false,
    include_skills_usage_instructions: false, auto_review_model_override: null, context_window: contextWindow,
    max_context_window: contextWindow, effective_context_window_percent: 95, auto_compact_token_limit: null,
    comp_hash: '3000', reasoning_summary_format: 'experimental', default_reasoning_summary: 'none',
    display_name: model === definition.codex.model ? definition.codex.displayName : model, description: definition.codex.description, default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' }
    ],
    shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.144.0',
    supported_in_api: true, availability_nux: null, upgrade: null, priority: 1
  }] }, null, 2)}\n`
}

function claudeEnv(provider: ModelProviderId, connection: ApiServiceConnection | undefined, key: string): Record<string, string> {
  const definition = modelProvider(provider)
  const modelName = connection?.model ?? definition.claude.model
  const contextWindow = connection?.model ? providerModelWindow(provider, modelName) ?? definition.claude.contextWindow : definition.claude.contextWindow
  // The main request may use a gateway-selected allowed model. Claude Code's small/fast slot is
  // part of the provider contract, so it must stay on the product-approved small model.
  const smallModel = definition.claude.smallModel
  const baseUrl = connection === undefined ? definition.claude.baseUrl : claudeConnectionUrl(connection)
  const apiKey = connection?.apiKey ?? key
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    [connection === undefined ? definition.claude.keyName : 'ANTHROPIC_AUTH_TOKEN']: apiKey,
    ANTHROPIC_MODEL: modelName,
    ANTHROPIC_DEFAULT_FABLE_MODEL: modelName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: modelName,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
    CLAUDE_CODE_EFFORT_LEVEL: definition.claude.effort,
    // Stable Anthropic-compatible providers do not need Claude Code's experimental beta headers.
    // The gateway also strips any residual header from an already-open client process.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    LAIXIN_AI_TOOLBOX_MODEL_CONNECTION: '1'
  }
}

export type ModelApiBackupState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly original: string | null }
  | { readonly kind: 'corrupt' }

/** Captures Toolbox-owned files before a service reconfiguration and restores them with readback. */
export async function captureManagedTextFiles(file: ManagedTextFile, paths: readonly string[]): Promise<() => Promise<void>> {
  const before = await Promise.all(paths.map((path) => file.read(path)))
  return async () => {
    const current = await Promise.all(paths.map((path) => file.read(path)))
    await replaceConfigurationTransaction(file, paths.map((path, index) => ({ path, before: current[index], after: before[index] })))
  }
}

function mergeCodexConfig(current: string | undefined, block: string): string {
  try {
    return parseCodexTomlDocument(isLegacyCodexConfig(current) ? '' : current ?? '').replaceToolboxConnection(block)
  } catch (error) {
    if ((error as Error).message === 'AI_ACCESS_CONFIG_TOML_UNSUPPORTED') throw new Error('AI_ACCESS_CONFIG_UNMANAGED', { cause: error })
    throw error
  }
}

function isToolboxCodexConnection(contents: string): boolean { return parseCodexTomlDocument(contents).toolboxConnection !== undefined }

function removeToolboxCodexConnection(contents: string): string | undefined {
  const document = parseCodexTomlDocument(contents)
  if (document.toolboxConnection === undefined) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  return document.removeToolboxConnection() || undefined
}

function isLegacyCodexConfig(contents: string | undefined): boolean {
  return typeof contents === 'string' && !contents.includes(managedCodexEnd) &&
    /^# Managed by Laixin AI Toolbox: .+ connection\n/.test(contents) &&
    /\nmodel_provider = "(deepseek|zai|kimi)"\n/.test(contents) &&
    /\nbase_url = "https:\/\/(api\.deepseek\.com\/?|api\.z\.ai\/api\/v1|api\.kimi\.com\/coding\/v1)"\n/.test(contents)
}

function mergeClaudeSettings(current: string | undefined, provider: ModelProviderId, connection: ApiServiceConnection | undefined, key: string): string {
  const parsed = current === undefined ? {} : parseClaudeSettings(current)
  const previous = record(parsed.env) ? parsed.env : {}
  const retained = Object.fromEntries(Object.entries(previous).filter(([name]) => !claudeManagedEnvKeys.includes(name as typeof claudeManagedEnvKeys[number])))
  return `${JSON.stringify({ ...parsed, env: { ...retained, ...claudeEnv(provider, connection, key) } }, null, 2)}\n`
}

function isManagedClaudeSettings(contents: string): boolean {
  try {
    const parsed = parseClaudeSettings(contents)
    if (!record(parsed.env)) return false
    const env = parsed.env
    const expectedSmallModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    // Pre-0.4.10 Toolbox blocks do not contain ANTHROPIC_SMALL_FAST_MODEL; retain that exact
    // marker-backed shape for recovery. New blocks must make both small-model slots agree.
    const smallModelIsRecognized = env.ANTHROPIC_SMALL_FAST_MODEL === undefined ||
      typeof env.ANTHROPIC_SMALL_FAST_MODEL === 'string' && env.ANTHROPIC_SMALL_FAST_MODEL === expectedSmallModel
    return env.LAIXIN_AI_TOOLBOX_MODEL_CONNECTION === '1' && typeof env.ANTHROPIC_BASE_URL === 'string' && isManagedClaudeBase(env.ANTHROPIC_BASE_URL) && smallModelIsRecognized &&
      ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL']
        .every((key) => typeof env[key] === 'string') &&
      (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' || typeof env.ANTHROPIC_API_KEY === 'string')
  } catch { return false }
}

function isLegacyClaudeSettings(contents: string | undefined): boolean {
  if (contents === undefined) return false
  try {
    const parsed = parseClaudeSettings(contents)
    if (Object.keys(parsed).length !== 1 || !record(parsed.env)) return false
    const env = parsed.env
    // This old unstructured block is recognized only for migration. Its DeepSeek model name is
    // now current, while claudeEnv() always takes the canonical choice from the provider contract.
    const legacy = [
      { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', keyName: 'ANTHROPIC_AUTH_TOKEN', fable: false },
      { baseUrl: 'https://api.z.ai/api/anthropic', model: 'GLM-4.7', keyName: 'ANTHROPIC_AUTH_TOKEN', fable: true },
      { baseUrl: 'https://api.kimi.com/coding/', model: 'k3-256k', keyName: 'ANTHROPIC_API_KEY', fable: true }
    ] as const
    return legacy.some(({ baseUrl, model, keyName, fable }) => {
      const expected = {
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_EFFORT_LEVEL: 'max',
        ...(fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: model } : {})
      }
      return Object.keys(env).length === Object.keys(expected).length + 1 && Object.entries(expected).every(([name, value]) => env[name] === value) &&
        typeof env[keyName] === 'string' && /^[A-Za-z0-9._-]{16,512}$/.test(env[keyName])
    })
  } catch { return false }
}

function parseClaudeSettings(contents: string): Record<string, unknown> {
  try {
    const candidate: unknown = JSON.parse(contents)
    if (!record(candidate) || (candidate.env !== undefined && !record(candidate.env))) throw new Error()
    return candidate
  } catch { throw new Error('AI_ACCESS_CONFIG_UNMANAGED') }
}

function restoreClaudeSettings(current: string, original: string | null): string | undefined {
  const currentSettings = parseClaudeSettings(current)
  const originalSettings = original === null ? {} : parseClaudeSettings(original)
  const currentEnv = record(currentSettings.env) ? currentSettings.env : {}
  const originalEnv = record(originalSettings.env) ? originalSettings.env : {}
  const currentNonManaged = withoutClaudeManagedEnv(currentEnv)
  const originalNonManaged = withoutClaudeManagedEnv(originalEnv)
  const unchanged = equalJson(
    withClaudeEnv(currentSettings, currentNonManaged),
    withClaudeEnv(originalSettings, originalNonManaged)
  )
  if (unchanged) return original ?? undefined
  const restoredEnv = { ...currentNonManaged, ...pickClaudeManagedEnv(originalEnv) }
  return `${JSON.stringify(withClaudeEnv(currentSettings, restoredEnv), null, 2)}\n`
}

/**
 * `deactivateToolboxConnection` removes every Toolbox-controlled Claude env key.  A later
 * restore is allowed only for that exact shape, with the non-controlled settings still matching
 * the snapshot.  This keeps an explicit CC Switch backup recoverable without treating a new
 * manual endpoint as an official/deactivated configuration.
 */
function isDeactivatedClaudeSettingsEquivalentToBackup(current: string | undefined, original: string | null): boolean {
  const currentSettings = current === undefined ? {} : parseClaudeSettings(current)
  const originalSettings = original === null ? {} : parseClaudeSettings(original)
  const currentEnv = record(currentSettings.env) ? currentSettings.env : {}
  if (Object.keys(currentEnv).some(name => claudeManagedEnvKeys.includes(name as typeof claudeManagedEnvKeys[number]))) return false
  const originalEnv = record(originalSettings.env) ? originalSettings.env : {}
  return equalJson(
    withClaudeEnv(currentSettings, currentEnv),
    withClaudeEnv(originalSettings, withoutClaudeManagedEnv(originalEnv))
  )
}

function withoutClaudeManagedEnv(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !claudeManagedEnvKeys.includes(name as typeof claudeManagedEnvKeys[number])))
}

function pickClaudeManagedEnv(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => claudeManagedEnvKeys.includes(name as typeof claudeManagedEnvKeys[number]) && name !== 'LAIXIN_AI_TOOLBOX_MODEL_CONNECTION'))
}

function withClaudeEnv(settings: Record<string, unknown>, env: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...settings }
  delete rest.env
  return Object.keys(env).length === 0 ? rest : { ...rest, env }
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right))
}

/** JSON object key order is not a settings change; arrays retain their meaningful order. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedJson(value[key])]))
  return value
}

function isManagedClaudeBase(value: string): boolean {
  return [
    'https://api.deepseek.com/anthropic', 'https://api.z.ai/api/anthropic', 'https://api.kimi.com/coding/',
    'https://open.bigmodel.cn/api/anthropic', 'https://api.moonshot.cn/anthropic'
  ].includes(value) || /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/claude\/(deepseek|zhipu-api|zhipu|kimi|moonshot)$/.test(value)
}

/** Does not throw: callers can preserve corrupt evidence and decide which safe action remains available. */
export function inspectModelApiBackup(contents: string | undefined): ModelApiBackupState {
  if (contents === undefined) return { kind: 'missing' }
  try {
    const value: unknown = JSON.parse(contents)
    if (!record(value) || value.version !== 1 || (typeof value.original !== 'string' && value.original !== null) || Object.keys(value).length !== 2) throw new Error()
    return { kind: 'valid', original: value.original }
  } catch { return { kind: 'corrupt' } }
}

function renderBackup(original: string | null): string {
  return `${JSON.stringify({ version: 1, original })}\n`
}

function validateCodexToml(contents: string | undefined): void {
  if (contents !== undefined) parseCodexTomlDocument(contents)
}

function validateModelsJson(contents: string | undefined): void {
  if (contents !== undefined) JSON.parse(contents)
}

function validateClaudeSettings(contents: string | undefined): void {
  if (contents !== undefined) parseClaudeSettings(contents)
}

function configurationTargetPath(shell: ConfigurationTarget['shell'], fallback: string, target: ConfigurationTarget | undefined): string {
  if (target === undefined) return fallback
  if (target.shell !== shell || target.path === undefined || !target.writable) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
  return target.path
}

/**
 * Production uses the fail-closed filesystem lock. An in-memory test adapter must opt in to a
 * lock explicitly; there is no catch-and-continue path for a real file adapter.
 */
function withManagedConfigWriteLock<T>(file: ManagedTextFile, lockPath: string, task: () => Promise<T>): Promise<T> {
  return file.withConfigWriteLock === undefined ? withConfigWriteLock(lockPath, task) : file.withConfigWriteLock(lockPath, task)
}

function providerEnvKey(provider: ModelProviderId): string {
  switch (provider) {
    case 'deepseek': return 'DEEPSEEK_API_KEY'
    case 'zhipu-api': return 'GLM_API_KEY'
    case 'zhipu': return 'GLM_API_KEY'
    case 'kimi': return 'KIMI_API_KEY'
    case 'moonshot': return 'KIMI_CN_API_KEY'
  }
}

function canManageHermesEnv(contents: string, key: string): boolean {
  const block = inspectManagedHermesEnv(contents)
  if (block.kind === 'invalid') return false
  const outside = block.kind === 'legacy' ? '' : block.kind === 'valid' ? withoutManagedEnvBlock(contents) : contents
  return !new RegExp(`^${escapeRegex(key)}=`, 'm').test(outside)
}

function withManagedEnvBlock(current: string | undefined, values: Readonly<Record<string, string>>): string {
  const base = current === undefined ? '' : withoutManagedEnvBlock(current)
  const block = `${managedEnvBegin}\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n${managedEnvEnd}\n`
  return base === '' ? block : `${base.endsWith('\n') ? base : `${base}\n`}\n${block}`
}

function withoutManagedEnvBlock(contents: string): string {
  const block = inspectManagedHermesEnv(contents)
  if (block.kind === 'legacy') return ''
  if (block.kind === 'none') return contents.replace(/^\n+|\n+$/g, '')
  if (block.kind === 'invalid') throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  return [...block.lines.slice(0, block.begin), ...block.lines.slice(block.end + 1)].join('\n').replace(/^\n+|\n+$/g, '')
}

type ManagedHermesEnvBlock =
  | { readonly kind: 'none' }
  | { readonly kind: 'legacy'; readonly provider: ModelProviderId }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly lines: readonly string[]; readonly begin: number; readonly end: number; readonly provider: ModelProviderId }

/** A matching comment alone is never ownership proof: every generated key and sidecar must agree. */
function inspectManagedHermesEnv(contents: string): ManagedHermesEnvBlock {
  if (legacyDeepSeekEnv.test(contents)) return { kind: 'legacy', provider: 'deepseek' }
  const lines = contents.split('\n')
  const begins = lines.flatMap((line, index) => line === managedEnvBegin ? [index] : [])
  const ends = lines.flatMap((line, index) => line === managedEnvEnd ? [index] : [])
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) return { kind: 'invalid' }
  const values: Record<string, string> = {}
  for (const line of lines.slice(begins[0] + 1, ends[0])) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (match === null || Object.hasOwn(values, match[1])) return { kind: 'invalid' }
    values[match[1]] = match[2]
  }
  const provider = values[hermesManagedProviderKey]
  if (!isModelProviderId(provider) || values[hermesManagedConnectionKey] !== '1') return { kind: 'invalid' }
  const definition = modelProvider(provider).hermes
  const keyName = providerEnvKey(provider)
  const expectedNames = [
    ...Object.keys(definition.env), keyName,
    hermesManagedConnectionKey, hermesManagedProviderKey, hermesManagedModelKey
  ].sort()
  if (values[hermesManagedModelKey] !== definition.model || values[keyName] === '' ||
      JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expectedNames) ||
      Object.entries(definition.env).some(([key, value]) => values[key] !== value)) return { kind: 'invalid' }
  return { kind: 'valid', lines, begin: begins[0], end: ends[0], provider: provider as ModelProviderId }
}

function hermesManagedValues(provider: ModelProviderId, key: string): Record<string, string> {
  const definition = modelProvider(provider).hermes
  return {
    ...definition.env,
    [providerEnvKey(provider)]: key,
    [hermesManagedConnectionKey]: '1',
    [hermesManagedProviderKey]: provider,
    [hermesManagedModelKey]: definition.model
  }
}

function isModelProviderId(value: string | undefined): value is ModelProviderId {
  return value === 'deepseek' || value === 'zhipu-api' || value === 'zhipu' || value === 'kimi' || value === 'moonshot'
}

/** True when the .env still carries a Toolbox-owned managed block (current or legacy shape). */
export function hasHermesManagedEnvBlock(contents: string | undefined): boolean {
  if (contents === undefined) return false
  const block = inspectManagedHermesEnv(contents)
  return block.kind === 'valid' || block.kind === 'legacy'
}

/** The provider recorded inside an intact Toolbox-owned .env block; undefined when there is none. */
export function hermesManagedEnvOwner(contents: string | undefined): ModelProviderId | undefined {
  if (contents === undefined) return undefined
  const block = inspectManagedHermesEnv(contents)
  return block.kind === 'valid' || block.kind === 'legacy' ? block.provider : undefined
}

/**
 * Removes only the Toolbox-owned .env block, keeping every customer variable.
 * Returns true when a block was present and removed.
 */
export async function removeHermesManagedEnvBlock(
  file: ManagedTextFile,
  envPath: string,
  action: 'deactivate' | 'restore'
): Promise<boolean> {
  return withManagedConfigWriteLock(file, join(dirname(envPath), 'laixin-config.lock'), async () => {
    const current = await file.read(envPath)
    if (current === undefined) return false
    const block = inspectManagedHermesEnv(current)
    if (block.kind === 'none') return false
    if (block.kind === 'invalid') throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    const restored = withoutManagedEnvBlock(current)
    await replaceConfigurationTransaction(file, [{ path: envPath, before: current, after: restored === '' ? undefined : restored }], { backupAction: action })
    return true
  })
}

function codexConnectionUrl(connection: ApiServiceConnection): string {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/codex\/(deepseek|zhipu-api|zhipu|kimi|moonshot)\/v1$/.test(connection.baseUrl)) {
    throw new Error('AI_ACCESS_CONNECTION_INVALID')
  }
  return connection.baseUrl
}

function claudeConnectionUrl(connection: ApiServiceConnection): string {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/claude\/(deepseek|zhipu-api|zhipu|kimi|moonshot)$/.test(connection.baseUrl)) {
    throw new Error('AI_ACCESS_CONNECTION_INVALID')
  }
  return connection.baseUrl
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function tomlString(value: string): string { return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
