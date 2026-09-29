export const codexWorkspaceSourceIds = ['official', 'multi'] as const
export type CodexWorkspaceSourceId = typeof codexWorkspaceSourceIds[number]
export type CodexApiWorkspaceSourceId = Exclude<CodexWorkspaceSourceId, 'official'>

export interface CodexWorkspaceSource {
  readonly id: CodexWorkspaceSourceId
  readonly provider: string
  readonly model?: string
  readonly title: string
}

export const codexWorkspaceSources: Readonly<Record<CodexWorkspaceSourceId, CodexWorkspaceSource>> = {
  official: { id: 'official', provider: 'openai', title: 'OpenAI 官方 · 新工作' },
  multi: { id: 'multi', provider: 'laixin-multi', title: '来信多模型 · 新对话' }
}

export function readCodexWorkspaceSource(value: string, multiModel?: string): CodexWorkspaceSource {
  if (!codexWorkspaceSourceIds.includes(value as CodexWorkspaceSourceId)) throw new Error('CODEX_WORKSPACE_SOURCE_INVALID')
  const source = codexWorkspaceSources[value as CodexWorkspaceSourceId]
  if (source.id !== 'multi') return source
  if (multiModel === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(multiModel)) throw new Error('CODEX_MULTI_MODEL_UNAVAILABLE')
  return { ...source, model: multiModel }
}
