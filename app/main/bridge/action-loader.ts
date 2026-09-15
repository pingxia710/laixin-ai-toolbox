import { BridgeError } from './action-registry'
import type { BridgeRegistry } from './bridge-registry'

interface ActionModule {
  readonly registerActions: (registry: BridgeRegistry) => void
}

export function registerDiscoveredActions(
  registry: BridgeRegistry,
  modules: Readonly<Record<string, unknown>>
): void {
  for (const path of Object.keys(modules).sort()) {
    const candidate = modules[path]
    if (!isActionModule(candidate)) {
      throw new BridgeError('ACTION_MODULE_INVALID')
    }
    candidate.registerActions(registry)
  }
}

function isActionModule(value: unknown): value is ActionModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'registerActions' in value &&
    typeof value.registerActions === 'function'
  )
}
