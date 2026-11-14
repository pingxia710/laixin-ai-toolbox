import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { QualityController, type QualityControllerDeps } from '../network-quality/controller'
import { openQualitySession } from '../network-quality/electron-session'
import { readQualityRuntime } from '../tunnel/runtime-owner'

export function registerActions(registry: BridgeRegistry, deps: QualityControllerDeps = { runtime: readQualityRuntime, open: openQualitySession }): void {
  const controller = new QualityController(deps)
  registry.registerAction({ name: 'networkquality.run', paramsSchema: schema.object({ share: schema.boolean() }),
    resultSchema: schema.object({ snapshot: schema.string({ maxLength: 2048 }) }),
    handler: async (params) => ({ snapshot: JSON.stringify(await controller.run((params as { share: boolean }).share)) }) })
  registry.registerAction({ name: 'networkquality.cancel', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ cancelled: schema.boolean() }), handler: () => ({ cancelled: controller.cancel() }) })
  registry.registerShutdownHook('networkquality', () => { controller.cancel() })
}
