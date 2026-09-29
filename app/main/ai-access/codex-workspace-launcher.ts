import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexCommand } from '../codex-usage/runtime'
import type { CodexWorkspaceOfficialModel } from './codex-workspace-config'
import type { CodexWorkspaceSource } from './codex-workspace-sources'

export interface CodexWorkspaceLaunchOptions {
  readonly cwd: string
  readonly codexHome: string
  readonly source: CodexWorkspaceSource
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

export interface CodexWorkspaceLaunchResult {
  readonly threadId: string
  readonly provider: string
  readonly model: string
}

export interface CodexWorkspaceModelListOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  readonly includeHidden?: boolean
}

export interface CodexWorkspaceModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly hidden: boolean
  readonly supportedReasoningEfforts: readonly CodexWorkspaceReasoningEffort[]
  readonly defaultReasoningEffort: string
  readonly inputModalities: readonly string[]
  readonly multiAgentVersion: string | null
  readonly additionalSpeedTiers: readonly string[]
  readonly serviceTiers: readonly CodexWorkspaceServiceTier[]
  readonly defaultServiceTier: string | null
}

export interface CodexWorkspaceReasoningEffort {
  readonly reasoningEffort: string
  readonly description: string
}

export interface CodexWorkspaceServiceTier {
  readonly id: string
  readonly name: string
  readonly description: string
}

const BUNDLED_CATALOG_STOP_GRACE_MS = 250

/**
 * Reads the current app-server public catalogue and its matching full bundled ModelInfo entries
 * from one throwaway CODEX_HOME. This deliberately never reads the customer's daily profile or
 * asks the local gateway for /models.
 */
export async function readCodexWorkspaceOfficialModels(command: CodexCommand, options: CodexWorkspaceModelListOptions): Promise<readonly CodexWorkspaceOfficialModel[]> {
  const codexHome = await mkdtemp(join(tmpdir(), 'laixin-codex-model-list-'))
  try {
    const [models, bundledCatalog] = await Promise.all([
      readCodexWorkspaceModels(command, { ...options, codexHome, includeHidden: true }),
      readCodexWorkspaceBundledCatalog(command, { ...options, codexHome })
    ])
    return mergeOfficialCatalog(models, bundledCatalog)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
}

/** Test-only callers may provide a temporary CODEX_HOME to verify app-server parsing of a generated catalogue. */
export async function readCodexWorkspaceModels(command: CodexCommand, options: CodexWorkspaceModelListOptions & { readonly codexHome: string }): Promise<readonly CodexWorkspaceModel[]> {
  const child = spawn(command.executable, [...command.args], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), CODEX_HOME: options.codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let buffer = ''
  let totalBytes = 0
  let finished = false
  let initialized = false
  const timeout = setTimeout(() => finish(new Error('CODEX_WORKSPACE_TIMEOUT')), options.timeoutMs ?? 15_000)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))

  let resolveModels: (models: readonly CodexWorkspaceModel[]) => void = () => undefined
  let rejectModels: (error: Error) => void = () => undefined
  const result = new Promise<readonly CodexWorkspaceModel[]>((resolve, reject) => { resolveModels = resolve; rejectModels = reject })
  const finish = (error?: Error, models?: readonly CodexWorkspaceModel[]): void => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error) rejectModels(error)
    else resolveModels(models ?? [])
  }
  const send = (message: Record<string, unknown>): void => {
    if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const fail = (): void => finish(new Error('CODEX_WORKSPACE_PROTOCOL_INVALID'))

  child.on('error', () => finish(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdin.on('error', () => finish(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.on('close', () => finish(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (finished) return
    totalBytes += Buffer.byteLength(chunk)
    if (totalBytes > 1_048_576) { fail(); return }
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown> | undefined
      try { message = record(JSON.parse(line)) } catch { /* checked below */ }
      if (!message) { fail(); return }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
        continue
      }
      if (message.id === 1) {
        if (message.error !== undefined || initialized) { fail(); return }
        initialized = true
        send({ method: 'initialized' })
        send({ id: 2, method: 'model/list', params: { includeHidden: options.includeHidden ?? true } })
        continue
      }
      if (message.id !== 2) continue
      if (!initialized || message.error !== undefined) { fail(); return }
      const data = record(message.result)?.data
      if (!Array.isArray(data)) { fail(); return }
      const parsedModels = data.map(parseWorkspaceModel)
      if (parsedModels.some((model): model is undefined => model === undefined) || parsedModels.length === 0) { fail(); return }
      const models = parsedModels.filter((model): model is CodexWorkspaceModel => model !== undefined)
      if (new Set(models.map(model => model.id)).size !== models.length) { fail(); return }
      finish(undefined, models)
      return
    }
  })
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'laixin_codex_workspace', title: '来信 AI 工作窗口', version: '0.5.19' }, capabilities: null } })
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    finished = true
    child.stdin.end()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
    force.unref()
    await closed
    clearTimeout(force)
  }
}

/** The current binary exposes its complete built-in ModelInfo catalogue through this supported debug command. */
export async function readCodexWorkspaceBundledCatalog(command: CodexCommand, options: CodexWorkspaceModelListOptions & { readonly codexHome: string }): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const child = spawn(command.executable, ['debug', 'models', '--bundled'], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), CODEX_HOME: options.codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let output = ''
  let totalBytes = 0
  let finished = false
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let resolveCatalog: (catalog: readonly Readonly<Record<string, unknown>>[]) => void = () => undefined
  let rejectCatalog: (error: Error) => void = () => undefined
  const result = new Promise<readonly Readonly<Record<string, unknown>>[]>((resolve, reject) => { resolveCatalog = resolve; rejectCatalog = reject })
  const timeout = setTimeout(() => finish(new Error('CODEX_WORKSPACE_TIMEOUT')), options.timeoutMs ?? 15_000)
  const finish = (error?: Error, catalog?: readonly Readonly<Record<string, unknown>>[]): void => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error !== undefined) rejectCatalog(error)
    else resolveCatalog(catalog ?? [])
  }
  const fail = (): void => finish(new Error('CODEX_WORKSPACE_MODEL_CATALOG_UNSUPPORTED'))

  child.on('error', () => finish(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (finished) return
    totalBytes += Buffer.byteLength(chunk)
    if (totalBytes > 16_777_216) { fail(); return }
    output += chunk
  })
  child.on('close', code => {
    if (finished) return
    if (code !== 0) { fail(); return }
    let result: Record<string, unknown> | undefined
    try { result = record(JSON.parse(output)) } catch { /* checked below */ }
    const models = Array.isArray(result?.models) ? result.models.map(record) : undefined
    if (models === undefined || models.length === 0 || models.some(model => model === undefined) ||
      new Set(models.map(model => model?.slug)).size !== models.length || models.some(model => !validModelId(model?.slug))) {
      fail()
      return
    }
    finish(undefined, models as readonly Readonly<Record<string, unknown>>[])
  })
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    finished = true
    await stopBundledCatalogChild(child, closed)
  }
}

async function stopBundledCatalogChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { child.kill('SIGTERM') } catch { /* an unavailable child still must not block cleanup */ }
  if (await closesWithin(closed, BUNDLED_CATALOG_STOP_GRACE_MS)) return
  try { child.kill('SIGKILL') } catch { /* final bounded close wait handles a failed spawn */ }
  await closesWithin(closed, BUNDLED_CATALOG_STOP_GRACE_MS)
}

function closesWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void closed.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function mergeOfficialCatalog(models: readonly CodexWorkspaceModel[], bundledCatalog: readonly Readonly<Record<string, unknown>>[]): readonly CodexWorkspaceOfficialModel[] {
  if (models.some(model => model.id.startsWith('laixin.')) || bundledCatalog.some(model => typeof model.slug === 'string' && model.slug.startsWith('laixin.'))) {
    throw new Error('CODEX_WORKSPACE_MODEL_CATALOG_UNSUPPORTED')
  }
  const bundledBySlug = new Map(bundledCatalog.map(model => [model.slug, model]))
  if (bundledBySlug.size !== models.length || bundledCatalog.length !== models.length) throw new Error('CODEX_WORKSPACE_MODEL_CATALOG_UNSUPPORTED')
  return models.map(model => {
    const catalog = bundledBySlug.get(model.id)
    if (catalog === undefined || !catalogMatchesModel(catalog, model)) throw new Error('CODEX_WORKSPACE_MODEL_CATALOG_UNSUPPORTED')
    return { slug: model.id, catalog }
  })
}

function catalogMatchesModel(catalog: Readonly<Record<string, unknown>>, model: CodexWorkspaceModel): boolean {
  const catalogLevels = Array.isArray(catalog.supported_reasoning_levels) ? catalog.supported_reasoning_levels.map(record) : undefined
  const catalogServiceTiers = Array.isArray(catalog.service_tiers) ? catalog.service_tiers.map(record) : undefined
  return catalog.display_name === model.displayName && catalog.description === model.description &&
    catalog.visibility === (model.hidden ? 'hide' : 'list') && sameStrings(catalog.input_modalities, model.inputModalities) &&
    catalogLevels !== undefined && sameReasoningEfforts(catalogLevels, model.supportedReasoningEfforts) &&
    catalog.default_reasoning_level === model.defaultReasoningEffort && optionalNullableString(catalog.multi_agent_version) &&
    nullishString(catalog.multi_agent_version) === model.multiAgentVersion && sameStrings(catalog.additional_speed_tiers, model.additionalSpeedTiers) &&
    catalogServiceTiers !== undefined && sameServiceTiers(catalogServiceTiers, model.serviceTiers) &&
    optionalNullableString(catalog.default_service_tier) && nullishString(catalog.default_service_tier) === model.defaultServiceTier
}

function parseWorkspaceModel(value: unknown): CodexWorkspaceModel | undefined {
  const model = record(value)
  const efforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(record) : undefined
  const serviceTiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers.map(record) : undefined
  if (model === undefined || !validModelId(model.id) || !validModelId(model.model) || !nonemptyString(model.displayName) || !nonemptyString(model.description) ||
    typeof model.hidden !== 'boolean' || !nonemptyString(model.defaultReasoningEffort) || !stringArray(model.inputModalities) ||
    !stringArray(model.additionalSpeedTiers) || !nullableString(model.multiAgentVersion) || !nullableString(model.defaultServiceTier) ||
    efforts === undefined || serviceTiers === undefined || !validReasoningEfforts(efforts) || !validServiceTiers(serviceTiers)) return undefined
  const typed = model as unknown as CodexWorkspaceModel
  return typed.supportedReasoningEfforts.some(effort => effort.reasoningEffort === typed.defaultReasoningEffort) &&
    (typed.defaultServiceTier === null || typed.serviceTiers.some(tier => tier.id === typed.defaultServiceTier)) ? typed : undefined
}

function validReasoningEfforts(efforts: readonly (Record<string, unknown> | undefined)[]): boolean {
  return efforts.length > 0 && efforts.every(effort => nonemptyString(effort?.reasoningEffort) && nonemptyString(effort?.description))
}

function validServiceTiers(tiers: readonly (Record<string, unknown> | undefined)[]): boolean {
  return tiers.every(tier => nonemptyString(tier?.id) && nonemptyString(tier?.name) && nonemptyString(tier?.description))
}

function sameReasoningEfforts(left: readonly (Record<string, unknown> | undefined)[], right: readonly CodexWorkspaceReasoningEffort[]): boolean {
  return left.length === right.length && left.every((effort, index) => effort?.effort === right[index].reasoningEffort && effort.description === right[index].description)
}

function sameServiceTiers(left: readonly (Record<string, unknown> | undefined)[], right: readonly CodexWorkspaceServiceTier[]): boolean {
  return left.length === right.length && left.every((tier, index) => tier?.id === right[index].id && tier.name === right[index].name && tier.description === right[index].description)
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index])
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonemptyString)
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

/** Creates and materializes one native Codex thread, then always stops its temporary app-server. */
export async function launchCodexWorkspaceThread(command: CodexCommand, options: CodexWorkspaceLaunchOptions): Promise<CodexWorkspaceLaunchResult> {
  const child = spawn(command.executable, [...command.args], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), CODEX_HOME: options.codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let buffer = ''
  let totalBytes = 0
  let nextId = 1
  let finished = false
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const timeout = setTimeout(() => failAll(new Error('CODEX_WORKSPACE_TIMEOUT')), options.timeoutMs ?? 15_000)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))

  const request = (method: string, params?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (finished) { reject(new Error('CODEX_WORKSPACE_UNAVAILABLE')); return }
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`)
  })
  const notify = (method: string): void => { if (!finished) child.stdin.write(`${JSON.stringify({ method })}\n`) }

  function failAll(error: Error): void {
    if (finished) return
    finished = true
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  child.on('error', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdin.on('error', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.on('close', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (finished) return
    totalBytes += Buffer.byteLength(chunk)
    if (totalBytes > 1_048_576) { failAll(new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')); return }
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      receive(line)
    }
  })

  function receive(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      const object = record(parsed)
      if (object === undefined) throw new Error()
      message = object
    } catch { failAll(new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')); return }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })}\n`)
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error('CODEX_WORKSPACE_REQUEST_FAILED'))
    else waiter.resolve(message.result)
  }

  try {
    await request('initialize', { clientInfo: { name: 'laixin_codex_workspace', title: '来信 AI 工作窗口', version: '0.5.19' }, capabilities: null })
    notify('initialized')
    const startParams: Record<string, unknown> = { cwd: options.cwd, modelProvider: options.source.provider, ephemeral: false }
    if (options.source.model !== undefined) startParams.model = options.source.model
    const started = record(await request('thread/start', startParams))
    const thread = record(started?.thread)
    const threadId = typeof thread?.id === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(thread.id) ? thread.id : undefined
    const provider = typeof started?.modelProvider === 'string' ? started.modelProvider : undefined
    const model = typeof started?.model === 'string' ? started.model : undefined
    if (threadId === undefined || provider !== options.source.provider || model === undefined ||
      (options.source.model !== undefined && model !== options.source.model)) throw new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')
    await request('thread/inject_items', {
      threadId,
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `Laixin source binding: ${options.source.id}.` }] }]
    })
    await request('thread/name/set', { threadId, name: options.source.title })
    return { threadId, provider, model }
  } finally {
    clearTimeout(timeout)
    finished = true
    child.stdin.end()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
    force.unref()
    await closed
    clearTimeout(force)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
