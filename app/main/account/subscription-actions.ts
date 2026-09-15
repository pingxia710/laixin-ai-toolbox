import { shell } from 'electron'
import { subscriptionMessages, type SubscriptionOperation, type SubscriptionPayment } from '../../subscription-types'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { AccountClientError, accountMessages } from './client'
import type { AccountClient } from './client'

export function registerSubscriptionActions(registry: BridgeRegistry, client: AccountClient): void {
  const operations: Record<SubscriptionOperation, string[]> = { catalog: [], list: ['cursor'], create: ['productId', 'channel', 'requestId'],
    detail: ['orderId'], pay: ['orderId'], reveal: ['orderId'], complete: ['orderId'], cancel: ['orderId'], report: ['orderId', 'issue'] }
  for (const [operation, fields] of Object.entries(operations)) {
    registry.registerAction({ name: `subscription.${operation}`,
      paramsSchema: fields.length ? schema.object(Object.fromEntries(fields.map((field) => [field, schema.string({ maxLength: 80 })]))) : schema.undefined(),
      resultSchema: schema.object({ data: schema.string({ maxLength: 1024 * 1024 }), error: schema.string({ maxLength: 200 }) }),
      handler: async (input) => {
        try {
          const data = await client.subscription(operation as SubscriptionOperation, input as Record<string, string> | undefined)
          if (operation === 'pay') {
            const payment = (data as SubscriptionPayment)?.payment
            if (payment?.redirect?.kind === 'url') {
              const url = new URL(payment.redirect.data)
              if (url.protocol !== 'https:' || url.hostname !== 'openapi.alipay.com' || url.port || url.username || url.password || url.pathname !== '/gateway.do') throw new AccountClientError('SUBSCRIPTION_UNAVAILABLE')
              await shell.openExternal(url.href)
            }
          }
          return { data: JSON.stringify(data), error: '' }
        } catch (error) {
          const code = error instanceof AccountClientError ? error.message : 'SUBSCRIPTION_UNAVAILABLE'
          return { data: '', error: subscriptionMessages[code] ?? accountMessages[code] ?? subscriptionMessages.SUBSCRIPTION_UNAVAILABLE }
        }
      } })
  }
}
