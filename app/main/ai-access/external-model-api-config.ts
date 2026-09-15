import { isProviderShellSupported, type ApiServiceConnection, type ModelProviderId } from '../../shared/model-providers'
import type { ConfigurationTarget } from './configuration-target'
import {
  createClaudeModelApiConfig,
  createCodexModelApiConfig,
  type DeepSeekConfig,
  type ManagedTextFile
} from './deepseek-config'

/** Providers that are active customer choices beyond DeepSeek. Z.AI is legacy-only. */
export const externalModelApiProviders = ['zhipu-api', 'zhipu', 'kimi', 'moonshot'] as const
export type ExternalModelApiProvider = typeof externalModelApiProviders[number]

export function createCodexExternalModelApiConfig(
  provider: ExternalModelApiProvider,
  home: string,
  file: ManagedTextFile,
  connection?: ApiServiceConnection,
  target?: ConfigurationTarget
): DeepSeekConfig {
  if (!isProviderShellSupported(provider, 'codex')) throw new Error('AI_ACCESS_PROVIDER_SHELL_UNSUPPORTED')
  return createCodexModelApiConfig(provider, home, file, connection, target)
}

export function createClaudeExternalModelApiConfig(
  provider: ExternalModelApiProvider,
  home: string,
  file: ManagedTextFile,
  connection?: ApiServiceConnection,
  target?: ConfigurationTarget
): DeepSeekConfig {
  if (!isProviderShellSupported(provider, 'claude')) throw new Error('AI_ACCESS_PROVIDER_SHELL_UNSUPPORTED')
  return createClaudeModelApiConfig(provider, home, file, connection, target)
}

/** Helpful only where a caller accepts either the DeepSeek or external provider set. */
export function isExternalModelApiProvider(provider: ModelProviderId): provider is ExternalModelApiProvider {
  return externalModelApiProviders.includes(provider as ExternalModelApiProvider)
}
