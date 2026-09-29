import { join } from 'node:path'
import { createAiAccessStore } from './store'
import { AiRouterController } from './router-controller'
import { readAiRouterRuntime, readAiRouterSeat } from './router-runtime'
import type { AiRouterResidentSpec } from './router-resident'
import type { AiAccessStateStore } from './service'

interface AiRouterCleanupController { stop(state: Awaited<ReturnType<AiAccessStateStore['read']>>): Promise<boolean> }
interface AiRouterCleanupDeps { readonly store?: AiAccessStateStore; readonly controller?: AiRouterCleanupController }

/** Removes the verified AI route only. Saved Keys, Codex auth and the network resident are outside this boundary. */
export async function cleanupAiRouter(userData: string, spec: AiRouterResidentSpec, deps: AiRouterCleanupDeps = {}): Promise<void> {
  const root = join(userData, 'ai-access')
  const store = deps.store ?? createAiAccessStore(root)
  const controller = deps.controller ?? new AiRouterController(userData, spec)
  const state = await store.read()
  if (!(await controller.stop(state))) throw new Error('AI_ROUTER_CLEANUP_FAILED')
  if (await readAiRouterRuntime(root) || await readAiRouterSeat(root)) throw new Error('AI_ROUTER_CLEANUP_INCOMPLETE')
}
