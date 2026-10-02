import { dirname, join } from 'node:path'
import { parseCodexTomlDocument } from './codex-toml-document'
import type { ManagedTextFile } from './deepseek-config'
import { replaceConfigurationTransaction, withConfigWriteLock } from './config-write-guard'
import { isProviderModelAllowed, modelProviderIds, modelProviders, providerModelWindow } from '../../shared/model-providers'

const legacyManagedBegin = '# >>> Laixin AI Toolbox managed Codex workspaces >>>'
const legacyManagedEnd = '# <<< Laixin AI Toolbox managed Codex workspaces <<<'
const managedBegin = '# >>> Laixin AI Toolbox managed Codex multi-model provider >>>'
const managedEnd = '# <<< Laixin AI Toolbox managed Codex multi-model provider <<<'
const catalogBegin = '# >>> Laixin AI Toolbox managed Codex multi-model catalog >>>'
const catalogEnd = '# <<< Laixin AI Toolbox managed Codex multi-model catalog <<<'
const multiProvider = 'laixin-multi'
// Candidate builds already wrote this block; recognise it before replacing our own tables.
const previousWorkspaceProviders = ['laixin-deepseek', 'laixin-kimi-api', 'laixin-zhipu-api'] as const
const previousFixedWorkspaceProviders = ['laixin-workspace-deepseek', 'laixin-kimi-api', 'laixin-workspace-zhipu-api'] as const

export interface CodexMultiModelWorkspaceConnection {
  readonly baseUrl: string
  readonly model: string
  /** Exact internal picker IDs from the same gateway-pool snapshot as baseUrl. */
  readonly models: readonly string[]
}

/**
 * A complete, current official catalogue entry emitted by the trusted Desktop Codex binary.
 * `catalog` is deliberately opaque here: it retains per-model execution metadata that
 * app-server's public model/list response does not expose.
 */
export interface CodexWorkspaceOfficialModel {
  readonly slug: string
  readonly catalog: Readonly<Record<string, unknown>>
}

export interface CodexWorkspaceConfigOptions {
  readonly codexHome: string
  readonly toolboxExecutable: string
  readonly multiModel: CodexMultiModelWorkspaceConnection
  /** Complete current Desktop catalogue, verified against an isolated app-server model/list before this config is written. */
  readonly officialModels: readonly CodexWorkspaceOfficialModel[]
  readonly file: ManagedTextFile
}

export interface CodexWorkspaceDeactivateOptions {
  readonly codexHome: string
  readonly file: ManagedTextFile
}

export type CodexWorkspaceCatalogState = 'written' | 'missing' | 'unreadable' | 'modified'
export interface CodexWorkspaceCatalogStatus { readonly state: CodexWorkspaceCatalogState }

type CodexWorkspaceCatalogReadOptions = Omit<CodexWorkspaceConfigOptions, 'officialModels'>

/**
 * Reads back only whether the Toolbox-owned provider and picker directory still match the
 * current pool. No path, executable, endpoint or catalogue contents cross this boundary.
 */
export async function readCodexWorkspaceCatalogStatus(options: CodexWorkspaceCatalogReadOptions): Promise<CodexWorkspaceCatalogStatus> {
  const path = join(options.codexHome, 'config.toml')
  const modelsPath = join(options.codexHome, 'laixin-multi-models.json')
  let config: string | undefined
  let models: string | undefined
  try { [config, models] = await Promise.all([options.file.read(path), options.file.read(modelsPath)]) } catch { return { state: 'unreadable' } }
  if (config === undefined || !config.includes(managedBegin) || !config.includes(catalogBegin)) {
    return { state: config?.includes(managedEnd) || config?.includes(catalogEnd) || models !== undefined ? 'modified' : 'missing' }
  }
  if (models === undefined || !absoluteExecutable(options.toolboxExecutable) || !localMultiModelUrl(options.multiModel.baseUrl) ||
    !validPickerModels(options.multiModel.models) || !options.multiModel.models.includes(options.multiModel.model)) return { state: 'modified' }
  try {
    parseCodexTomlDocument(config)
    const expectedProvider = renderManagedBlock(options.toolboxExecutable, options.multiModel).trim()
    const expectedCatalog = `${catalogBegin}\nmodel_catalog_json = "${tomlString(modelsPath)}"\n${catalogEnd}`
    if (normalizeManagedSection(managedSection(removeManagedCatalog(config), managedBegin, managedEnd)) !== normalizeManagedSection(expectedProvider) ||
      managedSection(config, catalogBegin, catalogEnd) !== expectedCatalog) return { state: 'modified' }
    validateModelsJson(models)
    const parsed = JSON.parse(models) as { models: Array<Record<string, unknown>> }
    const pickerModels = parsed.models.filter(model => typeof model.slug === 'string' && model.slug.startsWith('laixin.'))
    const officialCount = parsed.models.length - pickerModels.length
    const expected = options.multiModel.models.map((slug, index) => renderPickerModel(slug, officialCount + index + 1))
    return JSON.stringify(pickerModels) === JSON.stringify(expected) ? { state: 'written' } : { state: 'modified' }
  } catch { return { state: 'modified' } }
}

/**
 * Registers provider definitions without changing Codex's global model/model_provider. Each new
 * thread chooses its provider explicitly, so official login and existing threads keep their route.
 */
export async function installCodexWorkspaceProviders(options: CodexWorkspaceConfigOptions): Promise<void> {
  if (!absoluteExecutable(options.toolboxExecutable)) throw new Error('CODEX_WORKSPACE_EXECUTABLE_INVALID')
  if (!localMultiModelUrl(options.multiModel.baseUrl) || !validModelId(options.multiModel.model) ||
    !validPickerModels(options.multiModel.models) || !options.multiModel.models.includes(options.multiModel.model) ||
    !validOfficialModels(options.officialModels)) {
    throw new Error('CODEX_MULTI_MODEL_CONNECTION_INVALID')
  }
  const path = join(options.codexHome, 'config.toml')
  const modelsPath = join(options.codexHome, 'laixin-multi-models.json')
  const lockPath = join(dirname(path), 'laixin-config.lock')
  await managedLock(options.file, lockPath, async () => {
    const [current, currentModels] = await Promise.all([options.file.read(path), options.file.read(modelsPath)])
    if (current !== undefined) parseCodexTomlDocument(current)
    // Older candidates could place the catalogue marker inside the provider marker when the
    // config was otherwise empty. Remove the inner catalogue first, then normalize both owned
    // sections into independent root blocks.
    const base = removeMultiModelBlock(removeManagedCatalog(current ?? ''))
    const block = renderManagedBlock(options.toolboxExecutable, options.multiModel)
    const candidate = joinBlock(insertCatalogBlock(base, modelsPath), block)
    const models = renderModels(options.officialModels, options.multiModel.models)
    parseCodexTomlDocument(candidate)
    if (candidate === current && models === currentModels) return
    await replaceConfigurationTransaction(options.file, [
      { path: modelsPath, before: currentModels, after: models, validate: validateModelsJson },
      { path, before: current, after: candidate, validate: value => { if (value !== undefined) parseCodexTomlDocument(value) } }
    ], { backupAction: 'workspace' })
  })
}

/**
 * Removes only D's logical multi-model provider and generated catalogue. The caller's encrypted
 * state commit participates in the same rollback boundary, while legacy fixed providers remain.
 */
export async function deactivateCodexWorkspaceProviders(
  options: CodexWorkspaceDeactivateOptions,
  commitState: () => Promise<void>
): Promise<void> {
  const path = join(options.codexHome, 'config.toml')
  const modelsPath = join(options.codexHome, 'laixin-multi-models.json')
  const lockPath = join(dirname(path), 'laixin-config.lock')
  await managedLock(options.file, lockPath, async () => {
    const [current, currentModels] = await Promise.all([options.file.read(path), options.file.read(modelsPath)])
    if (current !== undefined) parseCodexTomlDocument(current)
    const withoutManaged = current === undefined ? undefined : removeMultiModelBlock(removeManagedCatalog(current))
    const candidate = withoutManaged?.trim() === '' ? undefined : withoutManaged
    if (candidate !== undefined) parseCodexTomlDocument(candidate)
    const changes = [
      { path: modelsPath, before: currentModels, after: undefined, validate: (value: string | undefined) => {
        if (value !== undefined) validateModelsJson(value)
      } },
      { path, before: current, after: candidate, validate: (value: string | undefined) => {
        if (value !== undefined) parseCodexTomlDocument(value)
      } }
    ] as const
    if (candidate !== current || currentModels !== undefined) {
      await replaceConfigurationTransaction(options.file, changes, { backupAction: 'workspace' })
    }
    try { await commitState() } catch (error) {
      try {
        if (candidate !== current || currentModels !== undefined) {
          await replaceConfigurationTransaction(options.file, changes.map(change => ({
            ...change, before: change.after, after: change.before
          })))
        }
      } catch (rollbackError) {
        throw new Error('AI_ACCESS_CONFIG_ROLLBACK_FAILED', { cause: rollbackError })
      }
      throw new Error('AI_ACCESS_CONFIG_TRANSACTION_FAILED', { cause: error })
    }
  })
}

function managedLock<T>(file: ManagedTextFile, path: string, task: () => Promise<T>): Promise<T> {
  return file.withConfigWriteLock === undefined ? withConfigWriteLock(path, task) : file.withConfigWriteLock(path, task)
}

function managedSection(contents: string, begin: string, end: string): string | undefined {
  const start = contents.indexOf(begin)
  const finish = contents.indexOf(end, start + begin.length)
  if (start < 0 || finish < 0 || contents.indexOf(begin, start + begin.length) >= 0 || contents.indexOf(end, finish + end.length) >= 0) return undefined
  return contents.slice(start, finish + end.length).trim()
}

function normalizeManagedSection(value: string | undefined): string | undefined {
  return value?.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
}

function renderManagedBlock(executable: string, connection: CodexMultiModelWorkspaceConnection): string {
  const command = tomlString(executable)
  return `${managedBegin}\n# Logical provider: laixin-multi\n[model_providers.${multiProvider}]\nname = "来信多模型"\nbase_url = "${tomlString(connection.baseUrl)}"\nwire_api = "responses"\n\n[model_providers.${multiProvider}.auth]\ncommand = "${command}"\nargs = ["--laixin-codex-provider-key", "multi"]\nrefresh_interval_ms = 0\ntimeout_ms = 20000\n${managedEnd}\n`
}

function removeMultiModelBlock(contents: string): string {
  const withoutCurrent = removeOwnedBlock(contents, managedBegin, managedEnd, [multiProvider], true)
  return removeOwnedBlock(withoutCurrent, legacyManagedBegin, legacyManagedEnd, [multiProvider], false)
}

function removeOwnedBlock(contents: string, begin: string, end: string, providers: readonly string[], absentIsOk: boolean): string {
  const lines = contents.split('\n')
  const markers = lines.flatMap((line, index) => {
    const trimmed = line.trim()
    return trimmed === begin || trimmed === end ? [index] : []
  })
  if (markers.length === 0) return contents
  if (markers.length !== 2 || lines[markers[0]].trim() !== begin || lines[markers[1]].trim() !== end || markers[0] >= markers[1]) {
    throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  }
  const body = lines.slice(markers[0] + 1, markers[1])
  if (!managedBlockMatches(body, providers)) {
    if (!absentIsOk && (managedBlockMatches(body, previousWorkspaceProviders) || managedBlockMatches(body, previousFixedWorkspaceProviders))) return contents
    throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  }
  return [...lines.slice(0, markers[0]), ...lines.slice(markers[1] + 1)].join('\n').replace(/\n+$/g, '')
}

function managedBlockMatches(lines: readonly string[], providers: readonly string[]): boolean {
  const expected = new Map<string, ReadonlySet<string>>()
  for (const provider of providers) {
    expected.set(`model_providers.${provider}`, new Set(['name', 'base_url', 'wire_api']))
    expected.set(`model_providers.${provider}.auth`, new Set(['command', 'args', 'refresh_interval_ms', 'timeout_ms']))
  }
  const seen = new Map<string, Set<string>>()
  let table: string | undefined
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('# Source: ') || line === '# Logical provider: laixin-multi') continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header !== null) {
      table = header[1]
      if (!expected.has(table) || seen.has(table)) return false
      seen.set(table, new Set())
      continue
    }
    const assignment = /^([a-z_]+)\s*=\s*.+$/.exec(line)
    if (assignment === null || table === undefined || !expected.get(table)?.has(assignment[1])) return false
    const keys = seen.get(table)!
    if (keys.has(assignment[1])) return false
    keys.add(assignment[1])
  }
  if (seen.size !== expected.size) return false
  for (const [tableName, keys] of expected) {
    const actual = seen.get(tableName)
    if (actual === undefined || actual.size !== keys.size || [...keys].some(key => !actual.has(key))) return false
  }
  return true
}

function joinBlock(base: string, block: string): string {
  const trimmed = base.replace(/\n+$/g, '')
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

/**
 * Codex treats model_catalog_json as a replacement directory. Keep the generated root setting
 * visibly separate from provider tables, and reject an unowned setting instead of overwriting a
 * customer's catalogue. The old single-provider route must first be restored/deactivated.
 */
function removeManagedCatalog(contents: string): string {
  const lines = contents.split('\n')
  const markers = lines.flatMap((line, index) => {
    const trimmed = line.trim()
    return trimmed === catalogBegin || trimmed === catalogEnd ? [index] : []
  })
  if (markers.length === 0) {
    if (lines.some(line => /^\s*model_catalog_json\s*=/.test(line))) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    return contents
  }
  if (markers.length !== 2 || lines[markers[0]].trim() !== catalogBegin || lines[markers[1]].trim() !== catalogEnd || markers[0] >= markers[1]) {
    throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  }
  const body = lines.slice(markers[0] + 1, markers[1]).filter(line => line.trim() !== '')
  if (body.length !== 1 || !/^model_catalog_json\s*=\s*"(?:[^"\\]|\\.)*"\s*$/.test(body[0].trim())) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  return [...lines.slice(0, markers[0]), ...lines.slice(markers[1] + 1)].join('\n').replace(/\n+$/g, '')
}

function insertCatalogBlock(contents: string, modelsPath: string): string {
  const block = `${catalogBegin}\nmodel_catalog_json = "${tomlString(modelsPath)}"\n${catalogEnd}`
  const lines = contents.replace(/\n+$/g, '').split('\n')
  const firstTable = lines.findIndex(line => line.trim().startsWith('['))
  if (firstTable < 0) return contents.trim() === '' ? `${block}\n` : `${block}\n\n${contents.replace(/\n+$/g, '')}\n`
  const legacyStart = lines.findIndex(line => line.trim() === legacyManagedBegin)
  const insertion = legacyStart >= 0 && legacyStart < firstTable ? legacyStart : firstTable
  return [...lines.slice(0, insertion), block, '', ...lines.slice(insertion)].join('\n').replace(/\n+$/g, '') + '\n'
}

function renderModels(officialModels: readonly CodexWorkspaceOfficialModel[], pickerModels: readonly string[]): string {
  return `${JSON.stringify({ models: [
    ...officialModels.map(model => model.catalog),
    ...pickerModels.map((slug, index) => renderPickerModel(slug, officialModels.length + index + 1))
  ] }, null, 2)}\n`
}

function renderPickerModel(slug: string, priority: number): Record<string, unknown> {
  const capabilities = pickerModelCapabilities(slug)
  if (!capabilities) throw new Error('CODEX_MULTI_MODEL_CONNECTION_INVALID')
  return {
    slug, prefer_websockets: false, support_verbosity: false, default_verbosity: 'low',
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', input_modalities: capabilities.inputModalities,
    supports_image_detail_original: false, truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true, experimental_supported_tools: [], base_instructions: '', tool_mode: null,
    multi_agent_version: 'v2', use_responses_lite: false, include_skills_usage_instructions: false,
    auto_review_model_override: null, context_window: capabilities.contextWindow, max_context_window: capabilities.contextWindow,
    effective_context_window_percent: 95, auto_compact_token_limit: null, comp_hash: '3000',
    reasoning_summary_format: 'experimental', default_reasoning_summary: 'none', display_name: slug,
    description: slug.startsWith('laixin.') ? 'Laixin multi-model picker entry' : 'Official Codex model',
    default_reasoning_level: 'high', supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' }
    ], shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.144.0',
    supported_in_api: true, availability_nux: null, upgrade: null, priority
  }
}

function validateModelsJson(value: string | undefined): void {
  if (value === undefined) throw new Error('AI_ACCESS_CONFIG_MODELS_INVALID')
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('AI_ACCESS_CONFIG_MODELS_INVALID')
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models) || models.length === 0 || models.some(model => typeof model !== 'object' || model === null || !validModelId((model as { slug?: unknown }).slug))) {
    throw new Error('AI_ACCESS_CONFIG_MODELS_INVALID')
  }
  const ids = models.map(model => (model as { slug: string }).slug)
  if (new Set(ids).size !== ids.length) throw new Error('AI_ACCESS_CONFIG_MODELS_INVALID')
}

function validPickerModels(models: readonly string[]): boolean {
  return models.length > 0 && models.every(model => validModelId(model) && pickerModelCapabilities(model) !== undefined) && new Set(models).size === models.length
}

/** Use the same product and exact model facts as single-model configuration; never guess a generic cap. */
function pickerModelCapabilities(slug: string) {
  const provider = modelProviderIds.find(provider => slug.startsWith(`laixin.${provider}.`))
  if (!provider) return undefined
  const model = slug.slice(`laixin.${provider}.`.length)
  const contextWindow = providerModelWindow(provider, model)
  if (!isProviderModelAllowed(provider, 'codex', model) || contextWindow === undefined) return undefined
  return { contextWindow, inputModalities: modelProviders[provider].codex.inputModalities }
}

function validOfficialModels(models: readonly CodexWorkspaceOfficialModel[]): boolean {
  return models.length > 0 && models.every(validOfficialModel) && new Set(models.map(model => model.slug)).size === models.length
}

function validOfficialModel(model: CodexWorkspaceOfficialModel): boolean {
  if (!validModelId(model.slug) || model.slug.startsWith('laixin.')) return false
  const catalog = model.catalog
  const levels = Array.isArray(catalog.supported_reasoning_levels) ? catalog.supported_reasoning_levels : undefined
  const serviceTiers = Array.isArray(catalog.service_tiers) ? catalog.service_tiers : undefined
  return catalog.slug === model.slug && typeof catalog.display_name === 'string' && catalog.display_name.length > 0 &&
    typeof catalog.description === 'string' && catalog.description.length > 0 &&
    (catalog.visibility === 'list' || catalog.visibility === 'hide') && stringArray(catalog.input_modalities) &&
    levels !== undefined && levels.length > 0 && levels.every(level => {
      const value = object(level)
      return typeof value?.effort === 'string' && value.effort.length > 0 && typeof value.description === 'string' && value.description.length > 0
    }) && typeof catalog.default_reasoning_level === 'string' && levels.some(level => object(level)?.effort === catalog.default_reasoning_level) &&
    optionalNullableString(catalog.multi_agent_version) && stringArray(catalog.additional_speed_tiers) && serviceTiers !== undefined &&
    serviceTiers.every(tier => {
      const value = object(tier)
      return typeof value?.id === 'string' && value.id.length > 0 && typeof value.name === 'string' && value.name.length > 0 && typeof value.description === 'string' && value.description.length > 0
    }) && optionalNullableString(catalog.default_service_tier) &&
    (nullishString(catalog.default_service_tier) === null || serviceTiers.some(tier => object(tier)?.id === catalog.default_service_tier)) &&
    positiveInteger(catalog.context_window) && positiveInteger(catalog.max_context_window) &&
    typeof catalog.shell_type === 'string' && catalog.shell_type.length > 0 && typeof catalog.web_search_tool_type === 'string' && catalog.web_search_tool_type.length > 0
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function optionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || nullableString(value)
}

function nullishString(value: unknown): string | null {
  return value === undefined ? null : value as string | null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function absoluteExecutable(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function tomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function localMultiModelUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/codex/multi/v1' && !url.search && !url.hash
  } catch { return false }
}
