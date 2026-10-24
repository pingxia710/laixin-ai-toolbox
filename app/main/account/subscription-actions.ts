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
              // 浏览器没弹出来是「打开付款页」失败,不是「下单」失败(PAY-11):订单已建,
              // 保留数据、如实标记,让界面引导客户重试打开 ⛔ 整包丢成「暂未开放购买」。
              try { await shell.openExternal(url.href) } catch { return { data: JSON.stringify({ ...(data as SubscriptionPayment), browserOpened: false }), error: '' } }
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
