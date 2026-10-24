import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({
    name: 'beta.echo',
    paramsSchema: schema.undefined(),
    resultSchema: schema.object({ source: schema.string({ maxLength: 10 }) }),
    handler: () => ({ source: 'beta' })
  })
}
