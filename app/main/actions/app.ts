import { app } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({
    name: 'app.info',
    paramsSchema: schema.undefined(),
    resultSchema: schema.object({
      version: schema.string({ maxLength: 100 }),
      platform: schema.string({ maxLength: 20 }),
      architecture: schema.string({ maxLength: 20 }),
      packaged: schema.boolean()
    }),
    handler: () => ({ version: app.getVersion(), platform: process.platform, architecture: process.arch, packaged: app.isPackaged })
  })
}
