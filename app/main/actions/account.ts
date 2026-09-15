import { app, shell } from 'electron'
import { join } from 'node:path'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { AccountClient } from '../account/client'
import { createSessionStore } from '../account/store'
import { isAlipayCheckoutUrl } from '../account/payment-url'
import { setNetworkAccountAccess } from '../tunnel/runtime'
import { registerSubscriptionActions } from '../account/subscription-actions'
import { registerSharingActions } from '../account/sharing-actions'
import { setInstallationReporter, setDownloadReporter } from '../account/installation-report'
import { collectDeviceFacts } from '../account/device-report'

declare const __TOOLBOX_ACCOUNT_ORIGIN__: string

export function registerAccountActions(registry: BridgeRegistry, client: AccountClient): void {
  registerSubscriptionActions(registry, client)
  registerSharingActions(registry, client)
  const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 150_000 }) })
  registry.registerAction({ name: 'account.snapshot', paramsSchema: schema.undefined(), resultSchema,
    handler: () => ({ snapshot: JSON.stringify(client.snapshot()) }) })
  const recoverySchema = schema.object({ snapshot: schema.string({ maxLength: 150_000 }), recoveryCode: schema.string({ maxLength: 80 }) })
  for (const method of ['status', 'logout', 'claimTrial'] as const) {
    registry.registerAction({ name: `account.${method}`, paramsSchema: schema.undefined(), resultSchema,
      handler: async () => ({ snapshot: JSON.stringify(await client[method]()) }) })
  }
  // 邀请有礼：开通名下待开通的奖励流量，逐笔幂等，可重试。
  registry.registerAction({ name: 'account.redeemInviteRewards', paramsSchema: schema.undefined(), resultSchema,
    handler: async () => ({ snapshot: JSON.stringify(await client.redeemInviteRewards()) }) })
  registry.registerAction({ name: 'account.sessions', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ sessions: schema.string({ maxLength: 6000 }) }), handler: async () => ({ sessions: JSON.stringify(await client.sessions()) }) })
  registry.registerAction({ name: 'account.paymentOrders', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ orders: schema.string({ maxLength: 100_000 }) }), handler: async () => ({ orders: JSON.stringify(await client.paymentOrders()) }) })
  registry.registerAction({ name: 'account.cancelPayment', paramsSchema: schema.object({ orderId: schema.string({ maxLength: 64 }) }), resultSchema,
    handler: async (params) => ({ snapshot: JSON.stringify(await client.cancelPayment((params as { orderId: string }).orderId)) }) })
  registry.registerAction({ name: 'account.cancelNetwork', paramsSchema: schema.object({ applicationId: schema.string({ maxLength: 64 }) }), resultSchema,
    handler: async (params) => ({ snapshot: JSON.stringify(await client.cancelNetwork((params as { applicationId: string }).applicationId)) }) })
  registry.registerAction({ name: 'account.supportContext', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ customerId: schema.string({ maxLength: 40 }), purchaseId: schema.string({ maxLength: 40 }), deviceId: schema.string({ maxLength: 40 }) }),
    handler: () => client.supportContext() })
  registry.registerAction({ name: 'account.revokeSession', paramsSchema: schema.object({ sessionId: schema.string({ maxLength: 50 }) }), resultSchema,
    handler: async (params) => ({ snapshot: JSON.stringify(await client.revokeSession((params as { sessionId: string }).sessionId)) }) })
  registry.registerAction({ name: 'account.changePassword', paramsSchema: schema.object({ currentPassword: schema.string(), password: schema.string() }), resultSchema,
    handler: async (params) => { const { currentPassword, password } = params as { currentPassword: string; password: string }
      return { snapshot: JSON.stringify(await client.changePassword(currentPassword, password)) } } })
  registry.registerAction({ name: 'account.closeAccount', paramsSchema: schema.object({ password: schema.string(), confirmed: schema.boolean() }), resultSchema,
    handler: async (params) => { const { password, confirmed } = params as { password: string; confirmed: boolean }
      return { snapshot: JSON.stringify(await client.closeAccount(password, confirmed)) } } })
  registry.registerAction({ name: 'account.installationStatus', paramsSchema: schema.object({ software: schema.string({ maxLength: 20 }) }),
    resultSchema: schema.object({ state: schema.string({ maxLength: 20 }), message: schema.string({ maxLength: 160 }) }),
    handler: (params) => client.installationStatus((params as { software: string }).software) })
  registry.registerAction({ name: 'account.deviceReportStatus', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ state: schema.string({ maxLength: 20 }), message: schema.string({ maxLength: 160 }) }),
    handler: () => client.deviceReportStatus() })
  registry.registerAction({ name: 'account.sendDeviceReport', paramsSchema: schema.undefined(),
    resultSchema: schema.object({ state: schema.string({ maxLength: 20 }), message: schema.string({ maxLength: 160 }) }),
    handler: () => client.sendDeviceReport() })
  for (const mode of ['register', 'login'] as const) {
    registry.registerAction({ name: `account.${mode}`,
      // 注册动作统一带 inviteCode 字段（空串 = 未填），桥参数无可选字段表达。
      paramsSchema: schema.object({ username: schema.string(), password: schema.string(), inviteCode: schema.string({ maxLength: 32 }) }), resultSchema: recoverySchema,
      handler: async (params) => { const { username, password, inviteCode } = params as { username: string; password: string; inviteCode: string }
        let recoveryCode = ''
        const view = await client.authenticate(mode, username, password, (code) => { recoveryCode = code }, inviteCode)
        return { snapshot: JSON.stringify(view), recoveryCode } } })
  }
  registry.registerAction({ name: 'account.recover', paramsSchema: schema.object({ username: schema.string(),
    recoveryCode: schema.string({ maxLength: 80 }), password: schema.string() }), resultSchema: recoverySchema,
    handler: async (params) => {
      const { username, recoveryCode, password } = params as { username: string; recoveryCode: string; password: string }
      const result = await client.recover(username, recoveryCode, password)
      return { snapshot: JSON.stringify(result.view), recoveryCode: result.recoveryCode }
    } })
  registry.registerAction({ name: 'account.rotateRecovery', paramsSchema: schema.object({ password: schema.string() }), resultSchema: recoverySchema,
    handler: async (params) => {
      const result = await client.rotateRecovery((params as { password: string }).password)
      return { snapshot: JSON.stringify(result.view), recoveryCode: result.recoveryCode }
    } })
  registry.registerAction({ name: 'account.apply', paramsSchema: schema.object({ planId: schema.string({ maxLength: 40 }) }), resultSchema,
    handler: async (params) => ({ snapshot: JSON.stringify(await client.apply((params as { planId: string }).planId)) }) })
  const paymentResultSchema = schema.object({ snapshot: schema.string({ maxLength: 150_000 }), order: schema.string({ maxLength: 4000 }), openedBrowser: schema.boolean() })
  registry.registerAction({ name: 'account.pay', paramsSchema: schema.object({ planId: schema.string({ maxLength: 40 }), channel: schema.string({ maxLength: 12 }) }),
    resultSchema: paymentResultSchema,
    handler: async (params) => {
      const { planId, channel } = params as { planId: string; channel: string }
      if (!['alipay', 'wechat'].includes(channel)) throw new Error('ACCOUNT_REQUEST_INVALID')
      const result = await client.pay(planId, channel as 'alipay' | 'wechat')
      let openedBrowser = false
      // Server responses still need validation before crossing into OS protocol handlers.
      if (result.order?.redirect?.kind === 'url') {
        if (channel !== 'alipay' || !isAlipayCheckoutUrl(result.order.redirect.data)) throw new Error('ACCOUNT_RESPONSE_INVALID')
        try { await shell.openExternal(result.order.redirect.data); openedBrowser = true } catch { /* Return the saved order so the customer can retry. */ }
      }
      return { snapshot: JSON.stringify(result.view), order: JSON.stringify(result.order), openedBrowser }
    } })
  registry.registerAction({ name: 'account.pollPayment', paramsSchema: schema.object({ orderId: schema.string({ maxLength: 64 }) }),
    resultSchema: schema.object({ order: schema.string({ maxLength: 4000 }) }),
    handler: async (params) => {
      const order = await client.pollPayment((params as { orderId: string }).orderId)
      return { order: JSON.stringify(order) }
    } })
  registry.registerShutdownHook('account', () => client.dispose())
}

export function registerActions(registry: BridgeRegistry): void {
  const client = new AccountClient(__TOOLBOX_ACCOUNT_ORIGIN__, createSessionStore(join(app.getPath('userData'), 'account')), setNetworkAccountAccess,
    () => collectDeviceFacts(app.getVersion(), app.getPath('userData')))
  setInstallationReporter((confirmed) => client.captureInstallationReport(confirmed))
  setDownloadReporter((passive) => client.captureDownloadReport(passive))
  registerAccountActions(registry, client)
}
