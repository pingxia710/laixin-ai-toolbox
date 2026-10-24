import type { AiAccessService } from './service'
import type { CodexCommand } from '../codex-usage/runtime'
import type { CodexWorkspaceOfficialModel } from './codex-workspace-config'
import { codexWorkspaceSources, readCodexWorkspaceSource, type CodexWorkspaceSourceId } from './codex-workspace-sources'

export type CodexWorkspaceOpenCode = 'opened' | 'model_pool_empty' | 'codex_not_installed' | 'login_required' | 'official_restore_failed'

export interface CodexWorkspaceOpenResult {
  readonly ok: boolean
  readonly source: CodexWorkspaceSourceId
  readonly code: CodexWorkspaceOpenCode
}

export interface CodexWorkspaceServiceDeps {
  readonly access: Pick<AiAccessService, 'codexOfficialLoginRoot' | 'codexMultiModelConnection' | 'status' | 'useOfficial'>
  readonly findCommand: () => Promise<CodexCommand | null>
  readonly readOfficialModels: (command: CodexCommand) => Promise<readonly CodexWorkspaceOfficialModel[]>
  readonly installProviders: (codexHome: string, connection: { readonly baseUrl: string; readonly model: string; readonly models: readonly string[] }, officialModels: readonly CodexWorkspaceOfficialModel[]) => Promise<void>
  readonly launch: (command: CodexCommand, input: { readonly codexHome: string; readonly source: ReturnType<typeof readCodexWorkspaceSource> }) => Promise<{ readonly threadId: string }>
  readonly openExternal: (url: string) => Promise<void>
}

export class CodexWorkspaceService {
  private launchPending: Promise<void> = Promise.resolve()

  constructor(private readonly deps: CodexWorkspaceServiceDeps) {}

  async open(sourceValue: string): Promise<CodexWorkspaceOpenResult> {
    if (sourceValue !== 'official' && sourceValue !== 'multi') throw new Error('CODEX_WORKSPACE_SOURCE_INVALID')
    let source = codexWorkspaceSources[sourceValue]
    const command = await this.deps.findCommand()
    if (command === null) return { ok: false, source: source.id, code: 'codex_not_installed' }
    const codexHome = await this.deps.access.codexOfficialLoginRoot()
    const connection = source.id === 'multi' ? await this.deps.access.codexMultiModelConnection() : undefined
    if (source.id === 'multi' && connection === undefined) return { ok: false, source: source.id, code: 'model_pool_empty' }
    const officialModels = connection === undefined ? undefined : await this.deps.readOfficialModels(command)
    if (connection !== undefined) source = readCodexWorkspaceSource('multi', connection.model)
    return this.serializeLaunch(async () => {
      if (source.id === 'official') {
        const status = await this.deps.access.status()
        if (status.officialAuthentication?.codex?.state !== 'official') {
          return { ok: false, source: source.id, code: 'login_required' }
        }
        if (status.shells.codex.selected !== 'official') {
          try { await this.deps.access.useOfficial('codex') } catch {
            return { ok: false, source: source.id, code: 'official_restore_failed' }
          }
        }
      } else await this.deps.installProviders(codexHome, connection!, officialModels!)
      const launched = await this.deps.launch(command, { codexHome, source })
      if (!/^[A-Za-z0-9-]{16,128}$/.test(launched.threadId)) throw new Error('CODEX_WORKSPACE_THREAD_INVALID')
      await this.deps.openExternal(`codex://threads/${encodeURIComponent(launched.threadId)}`)
      return { ok: true, source: source.id, code: 'opened' }
    })
  }

  /** Multiple app-servers may race the first SQLite initialization in one CODEX_HOME. */
  private serializeLaunch<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.launchPending.then(operation)
    this.launchPending = result.then(() => undefined, () => undefined)
    return result
  }
}
