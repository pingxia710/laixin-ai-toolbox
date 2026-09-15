import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { SharingIssue, SharingSoftware } from '../../sharing-types'
export interface SharingResult { data: string; error: string }
export interface SharingPublishInput {
  side: string; productId: string; software: string; accountPlan: string; apiProvider: string; apiModel: string
  termDays: string; quotaAmount: string; quotaUnit: string; usageTier: string; priceCents: string
  availableCount: string; deliveryHours: string; requestId: string
}
export interface SharingApi {
  catalog(): Promise<SharingResult>
  standards(): Promise<SharingResult>
  posts(): Promise<SharingResult>
  myPosts(): Promise<SharingResult>
  publish(input: SharingPublishInput): Promise<SharingResult>
  closePost(input: { postId: string }): Promise<SharingResult>
  list(input?: { cursor: string }): Promise<SharingResult>
  create(input: { listingId: string; channel: string; requestId: string }): Promise<SharingResult>
  detail(input: { orderId: string }): Promise<SharingResult>
  pay(input: { orderId: string }): Promise<SharingResult>
  reveal(input: { orderId: string }): Promise<SharingResult>
  complete(input: { orderId: string }): Promise<SharingResult>
  cancel(input: { orderId: string }): Promise<SharingResult>
  report(input: { orderId: string; issue: SharingIssue }): Promise<SharingResult>
  intentions(): Promise<SharingResult>
  share(input: { software: SharingSoftware; plan: string; availableNote: string; contact: string; requestId: string }): Promise<SharingResult>
}
export const namespace = 'sharing'
export const api: SharingApi = {
  catalog: () => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.catalog', undefined),
  standards: () => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.standards', undefined),
  posts: () => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.posts', undefined),
  myPosts: () => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.myPosts', undefined),
  publish: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.publish', input),
  closePost: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.closePost', input),
  list: (input = { cursor: '' }) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.list', input),
  create: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.create', input),
  detail: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.detail', input),
  pay: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.pay', input),
  reveal: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.reveal', input),
  complete: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.complete', input),
  cancel: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.cancel', input),
  report: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.report', input),
  intentions: () => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.intentions', undefined),
  share: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'sharing.share', input)
}
declare global { interface ToolboxApi { readonly sharing: SharingApi } }
