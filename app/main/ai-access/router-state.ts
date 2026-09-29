import { safeStorage } from 'electron'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isProviderModelAllowed, modelProviderIds, providerShellContract } from '../../shared/model-providers'
import type { AiAccessState, CodexMultiModelPoolEntry } from './service'
import type { MultiModelGatewayRoute } from './gateway'

export interface AiRouterBinding { readonly port: number; readonly identitySecret: string }

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
