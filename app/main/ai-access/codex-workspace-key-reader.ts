import type { AiAccessStateStore } from './service'
import { codexWorkspaceSourceIds, type CodexApiWorkspaceSourceId } from './codex-workspace-sources'
import { activeRouterRoute } from './router-state'
import type { RouterReady } from './router-controller'
import { savedProviderKey } from './saved-provider-key'

export const codexProviderKeyArgument = '--laixin-codex-provider-key'
const legacyCodexProviderKeySources = ['deepseek', 'moonshot', 'zhipu-api'] as const
type LegacyCodexProviderKeySource = typeof legacyCodexProviderKeySources[number]
export type CodexProviderKeySource = CodexApiWorkspaceSourceId | LegacyCodexProviderKeySource

export function readCodexProviderKeyRequest(argv: readonly string[]): CodexProviderKeySource | undefined {
  const positions = argv.flatMap((value, index) => value === codexProviderKeyArgument ? [index] : [])
  if (positions.length !== 1) return undefined
  const source = argv[positions[0] + 1]
  return source !== 'official' && (codexWorkspaceSourceIds.includes(source as never) || legacyCodexProviderKeySources.includes(source as never))
    ? source as CodexProviderKeySource : undefined
}

/** Writes only the requested multi-router token or retained legacy provider Key to command-auth. */
export async function emitCodexProviderKey(
  source: CodexProviderKeySource,
  store: Pick<AiAccessStateStore, 'read'>,
  write: (value: string) => void = value => { process.stdout.write(value) },
  options: { readonly ensureReady: (state: Awaited<ReturnType<AiAccessStateStore['read']>>) => Promise<RouterReady | false | undefined> }
): Promise<boolean> {
  const state = await store.read().catch(() => undefined)
  if (!state) return false
  if (source !== 'multi') {
    const key = savedProviderKey(state, 'codex', source)
    if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) return false
    write(key)
    return true
  }
  if (!activeRouterRoute(state)) return false
  const ready = await options.ensureReady(state).catch(() => undefined)
  if (!ready || !/^[a-f0-9]{64}$/.test(ready.runtime.token)) return false
  write(ready.runtime.token)
  return true
}
