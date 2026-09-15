import { shell } from 'electron'
import { sharingMessages, type SharingOperation, type SharingPayment } from '../../sharing-types'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema, type Schema } from '../bridge/schema'
import { AccountClientError, accountMessages } from './client'
import type { AccountClient } from './client'

export function registerSharingActions(registry: BridgeRegistry, client: AccountClient): void {
  const bound = (maxLength: number): Schema => schema.string({ maxLength })
  const operations: Record<SharingOperation, Record<string, Schema>> = { catalog: {}, standards: {}, posts: {}, myPosts: {}, list: { cursor: bound(80) },
    create: { listingId: bound(80), channel: bound(80), requestId: bound(80) },
    detail: { orderId: bound(80) }, pay: { orderId: bound(80) }, reveal: { orderId: bound(80) }, complete: { orderId: bound(80) }, cancel: { orderId: bound(80) },
    report: { orderId: bound(80), issue: bound(80) }, intentions: {},
    publish: { side: bound(20), productId: bound(40), software: bound(20), accountPlan: bound(80), apiProvider: bound(80), apiModel: bound(160),
      termDays: bound(20), quotaAmount: bound(20), quotaUnit: bound(40), usageTier: bound(40), priceCents: bound(20), availableCount: bound(20),
      deliveryHours: bound(20), requestId: bound(80) },
    closePost: { postId: bound(80) },
    share: { software: bound(80), plan: bound(80), availableNote: bound(200), contact: bound(80), requestId: bound(80) } }
  for (const [operation, fields] of Object.entries(operations)) {
    registry.registerAction({ name: `sharing.${operation}`,
      paramsSchema: Object.keys(fields).length ? schema.object(fields) : schema.undefined(),
      resultSchema: schema.object({ data: schema.string({ maxLength: 1024 * 1024 }), error: schema.string({ maxLength: 200 }) }),
      handler: async (input) => {
        try {
          const data = await client.sharing(operation as SharingOperation, input as Record<string, string> | undefined)
          if (operation === 'pay') {
            const payment = (data as SharingPayment)?.payment
            if (payment?.redirect?.kind === 'url') {
              const url = new URL(payment.redirect.data)
              if (url.protocol !== 'https:' || url.hostname !== 'openapi.alipay.com' || url.port || url.username || url.password || url.pathname !== '/gateway.do') throw new AccountClientError('SHARING_UNAVAILABLE')
              await shell.openExternal(url.href)
            }
          }
          return { data: JSON.stringify(data), error: '' }
        } catch (error) {
          const code = error instanceof AccountClientError ? error.message : 'SHARING_UNAVAILABLE'
          return { data: '', error: sharingMessages[code] ?? accountMessages[code] ?? sharingMessages.SHARING_UNAVAILABLE }
        }
      } })
  }
}
