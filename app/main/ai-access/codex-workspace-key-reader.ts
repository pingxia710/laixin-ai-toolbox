import type { AiAccessStateStore } from './service'
import { codexWorkspaceSourceIds, type CodexApiWorkspaceSourceId } from './codex-workspace-sources'

export const codexProviderKeyArgument = '--laixin-codex-provider-key'

export function readCodexProviderKeyRequest(argv: readonly string[]): CodexApiWorkspaceSourceId | undefined {
  const positions = argv.flatMap((value, index) => value === codexProviderKeyArgument ? [index] : [])
  if (positions.length !== 1) return undefined
  const source = argv[positions[0] + 1]
  return source !== 'official' && codexWorkspaceSourceIds.includes(source as never)
    ? source as CodexApiWorkspaceSourceId : undefined
}

/** Writes only the requested token to the command-auth stdout pipe. */
export async function emitCodexProviderKey(
  source: CodexApiWorkspaceSourceId,
  store: AiAccessStateStore,
  write: (value: string) => void = value => { process.stdout.write(value) }
): Promise<boolean> {
  const state = await store.read()
  const key = state.shellKeys?.codex?.[source]
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) return false
  write(key)
  return true
}
