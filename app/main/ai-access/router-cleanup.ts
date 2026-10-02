import { join } from 'node:path'
import { createAiAccessStore } from './store'
import { AiRouterController, type RouterReady } from './router-controller'
import { readAiRouterRuntime, readAiRouterSeat } from './router-runtime'
import type { AiRouterResidentSpec } from './router-resident'
import type { AiAccessAdapter, AiAccessState, AiAccessStateStore } from './service'
import { app } from 'electron'
import { createProductionAiAccessAdapters } from './production-adapters'
import { augmentedEnvironment } from '../shells/inventory'
import { createManagedTextFile } from './file'
import { deactivateCodexWorkspaceProviders } from './codex-workspace-config'

interface AiRouterCleanupController {
  stop(state: AiAccessState): Promise<boolean>
  ensureReady?(state: AiAccessState): Promise<RouterReady | undefined>
}
interface AiRouterCleanupDeps {
  readonly store?: AiAccessStateStore
  readonly controller?: AiRouterCleanupController
  readonly adapters?: readonly AiAccessAdapter[]
  readonly deactivateMulti?: (codexHome: string, commit: () => Promise<void>) => Promise<void>
}

/** Removes the verified AI route only. Saved Keys, Codex auth and the network resident are outside this boundary. */
export async function cleanupAiRouter(userData: string, spec: AiRouterResidentSpec, deps: AiRouterCleanupDeps = {}): Promise<void> {
  const root = join(userData, 'ai-access')
  const store = deps.store ?? createAiAccessStore(root)
  const controller = deps.controller ?? new AiRouterController(userData, spec)
  const state = await store.read()
  if (!(await controller.stop(state))) throw new Error('AI_ROUTER_CLEANUP_FAILED')
  if (await readAiRouterRuntime(root) || await readAiRouterSeat(root)) throw new Error('AI_ROUTER_CLEANUP_INCOMPLETE')
  try { await detachAiRouterConnections(userData, deps) } catch (error) {
    // Detachment rolls back client configuration on failure. Restore its verified listener too.
    if (controller.ensureReady && !(await controller.ensureReady(state))) throw new Error('AI_ROUTER_CLEANUP_RESTORE_FAILED', { cause: error })
    throw error
  }
}

/** Executable-removal recovery keeps its listener alive until owned client configuration is detached. */
export async function detachAiRouterConnections(userData: string, deps: Pick<AiRouterCleanupDeps, 'store' | 'adapters' | 'deactivateMulti'> = {}): Promise<void> {
  const store = deps.store ?? createAiAccessStore(join(userData, 'ai-access'))
  const state = await store.read()
  const shells = state.relayShells ?? []
  if (!shells.length && state.codexMode !== 'multi') return
  let adapters = deps.adapters
  if (!adapters) {
    const home = app.getPath('home')
    adapters = createProductionAiAccessAdapters(userData, home, process.platform, augmentedEnvironment(process.platform, home, process.env))
  }
  const rollbacks: (() => Promise<void>)[] = []
  try {
    for (const shell of shells) {
      const adapter = adapters.find(adapter => adapter.shell === shell)
      if (!adapter?.captureConnection || !adapter.deactivateToolboxConnection) throw new Error('AI_ROUTER_CONFIGURATION_CLEANUP_FAILED')
      const scope = shell === 'codex' ? undefined : state.configurationTargetScopes?.[shell]
      const target = scope !== undefined
        ? await adapter.selectConfigurationTarget?.(scope)
        : await adapter.configurationTargetStatus?.()
      if (scope !== undefined && target === undefined || target !== undefined && !target.writable) throw new Error('AI_ROUTER_CONFIGURATION_CLEANUP_FAILED')
      await adapter.recoverIsolationLease?.()
      rollbacks.push(await adapter.captureConnection())
      await adapter.deactivateToolboxConnection()
    }
    const detached = state.codexMode === 'multi' ? [...new Set([...shells, 'codex' as const])] : shells
    const next: AiAccessState = { ...state, selected: { ...state.selected, ...Object.fromEntries(detached.map(shell => [shell, 'official'])) },
      relayShells: [], pendingShells: state.pendingShells?.filter(shell => !detached.includes(shell)),
      shellFingerprints: Object.fromEntries(Object.entries(state.shellFingerprints ?? {}).filter(([shell]) => !detached.includes(shell as typeof shells[number]))),
      codexMode: 'single' as const }
    const commit = () => store.write(next)
    if (state.codexMode === 'multi') {
      const codexHome = await adapters.find(adapter => adapter.shell === 'codex')?.codexOfficialLoginRoot?.()
      if (!codexHome) throw new Error('AI_ROUTER_CONFIGURATION_CLEANUP_FAILED')
      if (deps.deactivateMulti) await deps.deactivateMulti(codexHome, commit)
      else await deactivateCodexWorkspaceProviders({ codexHome, file: createManagedTextFile({ maxBytes: 4 * 1024 * 1024 }) }, commit)
    } else await commit()
  } catch (error) {
    for (const rollback of rollbacks.reverse()) await rollback().catch(() => undefined)
    throw new Error('AI_ROUTER_CONFIGURATION_CLEANUP_FAILED', { cause: error })
  }
}
