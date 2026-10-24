import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { SubscriptionIssue } from '../../subscription-types'
export interface SubscriptionResult { data: string; error: string }
export interface SubscriptionApi {
  catalog(): Promise<SubscriptionResult>
  list(input?: { cursor: string }): Promise<SubscriptionResult>
  create(input: { productId: string; channel: string; requestId: string }): Promise<SubscriptionResult>
  detail(input: { orderId: string }): Promise<SubscriptionResult>
  pay(input: { orderId: string }): Promise<SubscriptionResult>
  reveal(input: { orderId: string }): Promise<SubscriptionResult>
  complete(input: { orderId: string }): Promise<SubscriptionResult>
  cancel(input: { orderId: string }): Promise<SubscriptionResult>
  report(input: { orderId: string; issue: SubscriptionIssue }): Promise<SubscriptionResult>
}
export const namespace = 'subscription'
export const api: SubscriptionApi = {
  catalog: () => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.catalog', undefined),
  list: (input = { cursor: '' }) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.list', input),
  create: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.create', input),
  detail: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.detail', input),
  pay: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.pay', input),
  reveal: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.reveal', input),
  complete: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.complete', input),
  cancel: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.cancel', input),
  report: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'subscription.report', input)
}
declare global { interface ToolboxApi { readonly subscription: SubscriptionApi } }
