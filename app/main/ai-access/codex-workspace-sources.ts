import { modelProviders } from '../../shared/model-providers'

export const codexWorkspaceSourceIds = ['official', 'deepseek', 'moonshot', 'zhipu-api'] as const
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
  deepseek: {
    id: 'deepseek', provider: 'laixin-deepseek', model: modelProviders.deepseek.models.codex,
    title: 'DeepSeek API · 新工作'
  },
  moonshot: {
    id: 'moonshot', provider: 'laixin-kimi-api', model: modelProviders.moonshot.models.codex,
    title: 'Kimi API · 新工作'
  },
  'zhipu-api': {
    id: 'zhipu-api', provider: 'laixin-zhipu-api', model: modelProviders['zhipu-api'].models.codex,
    title: '智谱 API · 新工作'
  }
}

export function readCodexWorkspaceSource(value: string): CodexWorkspaceSource {
  if (!codexWorkspaceSourceIds.includes(value as CodexWorkspaceSourceId)) throw new Error('CODEX_WORKSPACE_SOURCE_INVALID')
  return codexWorkspaceSources[value as CodexWorkspaceSourceId]
}
