import type { AiAccessProvider, AiAccessService, AiAccessStatus } from './service'
import type { CodexCommand } from '../codex-usage/runtime'
import { readCodexWorkspaceSource, type CodexApiWorkspaceSourceId, type CodexWorkspaceSourceId } from './codex-workspace-sources'

export type CodexWorkspaceOpenCode = 'opened' | 'key_missing' | 'key_rejected' | 'provider_unavailable' | 'codex_not_installed'

export interface CodexWorkspaceOpenResult {
  readonly ok: boolean
  readonly source: CodexWorkspaceSourceId
  readonly code: CodexWorkspaceOpenCode
}

export interface CodexWorkspaceServiceDeps {
  readonly access: Pick<AiAccessService, 'codexOfficialLoginRoot' | 'providerKey' | 'verifyAndSaveProviderKey'>
  readonly findCommand: () => Promise<CodexCommand | null>
  readonly installProviders: (codexHome: string) => Promise<void>
  readonly launch: (command: CodexCommand, input: { readonly codexHome: string; readonly source: ReturnType<typeof readCodexWorkspaceSource> }) => Promise<{ readonly threadId: string }>
  readonly openExternal: (url: string) => Promise<void>
}

export class CodexWorkspaceService {
  private launchPending: Promise<void> = Promise.resolve()

  constructor(private readonly deps: CodexWorkspaceServiceDeps) {}

  async open(sourceValue: string, candidateValue = ''): Promise<CodexWorkspaceOpenResult> {
    const source = readCodexWorkspaceSource(sourceValue)
    const command = await this.deps.findCommand()
    if (command === null) return { ok: false, source: source.id, code: 'codex_not_installed' }
    const codexHome = await this.deps.access.codexOfficialLoginRoot()
    if (source.id !== 'official') {
      const ready = await this.prepareKey(source.id, candidateValue)
      if (ready !== 'ready') return { ok: false, source: source.id, code: ready }
    }
    return this.serializeLaunch(async () => {
      if (source.id !== 'official') await this.deps.installProviders(codexHome)
      const launched = await this.deps.launch(command, { codexHome, source })
      if (!/^[A-Za-z0-9-]{16,128}$/.test(launched.threadId)) throw new Error('CODEX_WORKSPACE_THREAD_INVALID')
      await this.deps.openExternal(`codex://threads/${encodeURIComponent(launched.threadId)}`)
      return { ok: true, source: source.id, code: 'opened' }
    })
  }

  private async prepareKey(source: CodexApiWorkspaceSourceId, candidateValue: string): Promise<'ready' | Exclude<CodexWorkspaceOpenCode, 'opened' | 'codex_not_installed'>> {
    const candidate = candidateValue.trim()
    if (candidate !== '') {
      if (!/^[A-Za-z0-9._-]{16,512}$/.test(candidate)) return 'key_rejected'
      const status = await this.deps.access.verifyAndSaveProviderKey('codex', source as AiAccessProvider, candidate)
      const attempt = matchingAttempt(status, source as AiAccessProvider)
      if (attempt?.ok !== true) return attempt?.code === 'key_rejected' || attempt?.code === 'key_product_mismatch'
        ? 'key_rejected' : 'provider_unavailable'
      return 'ready'
    }
    return await this.deps.access.providerKey('codex', source as AiAccessProvider) === undefined ? 'key_missing' : 'ready'
  }

  /** Multiple app-servers may race the first SQLite initialization in one CODEX_HOME. */
  private serializeLaunch<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.launchPending.then(operation)
    this.launchPending = result.then(() => undefined, () => undefined)
    return result
  }
}

function matchingAttempt(status: AiAccessStatus, provider: AiAccessProvider): AiAccessStatus['attempt'] {
  return status.attempt?.shell === 'codex' && status.attempt.provider === provider ? status.attempt : undefined
}
