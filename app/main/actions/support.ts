import { shell } from 'electron'
import configuration from '../../../resources/support-contact.json'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({ name: 'support.open', paramsSchema: schema.undefined(), resultSchema: schema.object({ opened: schema.boolean() }),
    handler: async () => {
      const url = new URL(configuration.customerServiceUrl)
      if (url.origin !== 'https://work.weixin.qq.com' || !/^\/kfid\/kfc[a-z0-9]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('SUPPORT_URL_INVALID')
      await shell.openExternal(url.href)
      return { opened: true }
    } })
}
