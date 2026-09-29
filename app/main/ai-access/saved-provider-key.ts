import type { AiAccessProvider, AiAccessShell, AiAccessState } from './service'

export const legacyKeyFieldNames = ['deepseekKey', 'zhipuKey', 'kimiKey', 'moonshotKey'] as const
type LegacyKeyField = typeof legacyKeyFieldNames[number]

/** Coding Plan and metered API Keys remain separate products, including legacy storage. */
const legacyKeyFields: Readonly<Record<AiAccessProvider, LegacyKeyField | undefined>> = {
  deepseek: 'deepseekKey',
  'zhipu-api': undefined,
  zhipu: 'zhipuKey',
  kimi: 'kimiKey',
  moonshot: 'moonshotKey'
}

/** Reads the same binding in the main service and the independent Codex auth process. */
export function savedProviderKey(state: AiAccessState, shell: AiAccessShell, provider: AiAccessProvider): string | undefined {
  if (state.shellKeys !== undefined) return state.shellKeys[shell]?.[provider]
  // Only an existing legacy binding owns the shared field. Reading must not assign it to
  // another client or product, and an explicit modern empty map must never revive it.
  if (state.selected[shell] !== provider) return undefined
  const field = legacyKeyFields[provider]
  return field === undefined ? undefined : state[field]
}
