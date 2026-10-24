import { ActionRegistry, type ActionRegistryOptions } from './action-registry'
import { ShutdownRegistry, type ShutdownHook } from './shutdown-registry'

export class BridgeRegistry extends ActionRegistry {
  readonly shutdownHooks = new ShutdownRegistry()

  constructor(options: ActionRegistryOptions = {}) {
    super(options)
  }

  registerShutdownHook(moduleId: string, hook: ShutdownHook): void {
    this.shutdownHooks.registerShutdownHook(moduleId, hook)
  }
}
