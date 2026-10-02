import { safeStorage } from 'electron'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isProviderModelAllowed, isProviderShellSupported, modelProviderIds, normalizeProviderModel, providerShellContract } from '../../shared/model-providers'
import type { AiAccessState, CodexMultiModelPoolEntry } from './service'
import type { GatewayRoute, MultiModelGatewayRoute } from './gateway'

export interface AiRouterBinding { readonly port: number; readonly identitySecret: string }

export function routerBinding(state: AiAccessState): AiRouterBinding | undefined {
  const binding = state.codexMultiRelay
  return binding && Number.isInteger(binding.port) && binding.port >= 1024 && binding.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(binding.identitySecret) ? binding : undefined
}

/** An empty keyed listener is needed while the GUI commits a first connection transaction. */
export function routerConfigured(state: AiAccessState): boolean {
  const relay = state.relay
  return routerBinding(state) !== undefined && (activeRouterRoute(state) !== undefined ||
    relay !== undefined && Number.isInteger(relay.port) && relay.port >= 1024 && relay.port <= 65535 && /^[a-f0-9]{64}$/.test(relay.token))
}

export type RouterRouteResolver = (shell: GatewayRoute['shell'], provider: GatewayRoute['provider']) => { endpoint: string; model: string }

export function activeSingleRouterRoutes(state: AiAccessState, resolve?: RouterRouteResolver): readonly GatewayRoute[] {
  if (!state.relay || !/^[a-f0-9]{64}$/.test(state.relay.token)) return []
  return (['codex', 'claude', 'hermes'] as const).flatMap(shell => {
    const provider = state.selected?.[shell]
    if (!modelProviderIds.includes(provider as GatewayRoute['provider']) ||
      !state.relayShells?.includes(shell) || state.pendingShells?.includes(shell) ||
      shell === 'codex' && state.codexMode === 'multi') return []
    const id = provider as GatewayRoute['provider']
    if (!isProviderShellSupported(id, shell)) return []
    const key = state.shellKeys?.[shell]?.[id]
    if (!key || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) return []
    const contract = providerShellContract(id, shell)
    if (contract.status !== 'supported') return []
    const resolved = resolve?.(shell, id)
    const stored = state.shellModels?.[shell]?.[id]
    const model = (stored === undefined ? undefined : normalizeProviderModel(id, shell, stored)) ??
      (resolved === undefined ? undefined : normalizeProviderModel(id, shell, resolved.model)) ?? contract.defaultModel
    if (!isProviderModelAllowed(id, shell, model)) return []
    return [{ shell, provider: id, model, key, endpoint: resolved?.endpoint ?? contract.endpoint }]
  })
}

/** The router reads the encrypted business state directly and fails closed without rewriting it. */
export async function readRouterBusinessState(root: string): Promise<AiAccessState> {
  const path = join(root, 'ai-access', 'ai-access.enc')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('AI_ROUTER_STATE_INVALID')
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('AI_ROUTER_STORAGE_UNAVAILABLE')
  }
  const value: unknown = JSON.parse(safeStorage.decryptString(await readFile(path)))
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) throw new Error('AI_ROUTER_STATE_INVALID')
  return value as AiAccessState
}

export function activeRouterRoute(state: AiAccessState): MultiModelGatewayRoute | undefined {
  if (state.codexMode !== 'multi' || !state.codexMultiRelay || !Number.isInteger(state.codexMultiRelay.port) ||
    state.codexMultiRelay.port < 1024 || state.codexMultiRelay.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(state.codexMultiRelay.identitySecret) ||
    !Array.isArray(state.codexMultiModelPool) || !state.codexMultiModelPool.length) return undefined
  const seen = new Set<string>()
  const providers = new Set<string>()
  const models = (state.codexMultiModelPool as readonly CodexMultiModelPoolEntry[]).map(entry => {
    if (!entry || !modelProviderIds.includes(entry.provider) || !isProviderModelAllowed(entry.provider, 'codex', entry.model) ||
      entry.internalModelId !== `laixin.${entry.provider}.${entry.model}` || seen.has(entry.internalModelId) ||
      providers.has(entry.provider)) return undefined
    seen.add(entry.internalModelId)
    providers.add(entry.provider)
    const key = state.shellKeys?.codex?.[entry.provider]
    const contract = providerShellContract(entry.provider, 'codex')
    if (!key || !/^[A-Za-z0-9._-]{16,512}$/.test(key) || contract.status !== 'supported') return undefined
    return { ...entry, endpoint: contract.endpoint, key }
  })
  if (models.some(model => model === undefined)) return undefined
  return { provider: 'laixin-multi', models: models as NonNullable<typeof models[number]>[] }
}
