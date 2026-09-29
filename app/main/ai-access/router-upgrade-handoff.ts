import type { AiRouterResidentSpec } from './router-resident'
import { join } from 'node:path'
import { AiRouterController, type RouterReady } from './router-controller'
import { readAiRouterSeat } from './router-runtime'
import { activeRouterRoute } from './router-state'
import { createAiAccessStore } from './store'
import type { AiAccessStateStore } from './service'

export interface AiRouterUpgradeController {
  stop(state: Awaited<ReturnType<AiAccessStateStore['read']>>): Promise<boolean>
  refresh(state: Awaited<ReturnType<AiAccessStateStore['read']>>): Promise<boolean>
}

interface AiRouterUpgradeDeps {
  readonly store?: AiAccessStateStore
  readonly controller?: AiRouterUpgradeController
}

export interface AiRouterStartupController {
  ensureReady(state: Awaited<ReturnType<AiAccessStateStore['read']>>, install?: boolean): Promise<RouterReady | undefined>
}

interface AiRouterStartupDeps {
  readonly store?: AiAccessStateStore
  readonly controller?: AiRouterStartupController
}

/**
 * The new desktop process may acknowledge an update only after the current router has published
 * a HMAC-proved runtime and the exact same PID/bootId holds the seat. This is deliberately
 * separate from the old-owner handoff: a failed new owner must leave no success acknowledgement.
 */
export async function restoreAiRouterAfterUpdate(
  userData: string,
  spec: AiRouterResidentSpec,
  deps: AiRouterStartupDeps = {}
): Promise<'ready' | 'not_configured' | 'failed'> {
  try {
    const store = deps.store ?? createAiAccessStore(join(userData, 'ai-access'))
    const state = await store.read()
    if (!activeRouterRoute(state)) return 'not_configured'
    const controller = deps.controller ?? new AiRouterController(userData, spec)
    const ready = await controller.ensureReady(state, true)
    if (!ready) return 'failed'
    const seat = await readAiRouterSeat(join(userData, 'ai-access'))
    return seat?.holder?.pid === ready.runtime.pid && seat.holder.bootId === ready.runtime.bootId ? 'ready' : 'failed'
  } catch { return 'failed' }
}

/**
 * The updater calls this only after the replacement has been verified. No update helper starts
 * until the exact HMAC/runtime/seat owner has stopped. A pre-helper failure can restore it.
 */
export async function prepareAiRouterUpdate(
  userData: string,
  spec: AiRouterResidentSpec,
  deps: AiRouterUpgradeDeps = {}
): Promise<(() => Promise<void>) | undefined> {
  const store = deps.store ?? createAiAccessStore(join(userData, 'ai-access'))
  const controller = deps.controller ?? new AiRouterController(userData, spec)
  const state = await store.read()
  if (!activeRouterRoute(state)) return undefined
  try {
    if (!(await controller.stop(state))) throw new Error('AI_ROUTER_UPDATE_HANDOFF_FAILED')
  } catch (error) {
    const code = (error as Error).message
    if (code !== 'AI_ROUTER_STOP_UNCERTAIN' && code !== 'AI_ROUTER_STOP_INCOMPLETE') throw error
    if (!(await controller.refresh(state).catch(() => false))) throw new Error('AI_ROUTER_UPDATE_RESTORE_FAILED', { cause: error })
    throw new Error('AI_ROUTER_UPDATE_HANDOFF_FAILED', { cause: error })
  }
  return async () => {
    if (!(await controller.refresh(state))) throw new Error('AI_ROUTER_UPDATE_RESTORE_FAILED')
  }
}
