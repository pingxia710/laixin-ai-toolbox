import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface AccountApi {
  status(): Promise<{ snapshot: string }>
  login(input: { username: string; password: string; inviteCode: string }): Promise<{ snapshot: string; recoveryCode: string }>
  register(input: { username: string; password: string; inviteCode: string }): Promise<{ snapshot: string; recoveryCode: string }>
  recover(input: { username: string; password: string; recoveryCode: string }): Promise<{ snapshot: string; recoveryCode: string }>
  rotateRecovery(input: { password: string }): Promise<{ snapshot: string; recoveryCode: string }>
  claimTrial(): Promise<{ snapshot: string }>
  redeemInviteRewards(): Promise<{ snapshot: string }>
  sessions(): Promise<{ sessions: string }>
  paymentOrders(): Promise<{ orders: string }>
  cancelPayment(input: { orderId: string }): Promise<{ snapshot: string }>
  cancelNetwork(input: { applicationId: string }): Promise<{ snapshot: string }>
  supportContext(): Promise<{ customerId: string; purchaseId: string; deviceId: string }>
  revokeSession(input: { sessionId: string }): Promise<{ snapshot: string }>
  changePassword(input: { currentPassword: string; password: string }): Promise<{ snapshot: string }>
  closeAccount(input: { password: string; confirmed: boolean }): Promise<{ snapshot: string }>
  installationStatus(input: { software: string }): Promise<{ state: string; message: string }>
  deviceReportStatus(): Promise<{ state: string; message: string }>
  sendDeviceReport(): Promise<{ state: string; message: string }>
  logout(): Promise<{ snapshot: string }>
  apply(input: { planId: string }): Promise<{ snapshot: string }>
  pay(input: { planId: string; channel: 'alipay' | 'wechat' }): Promise<{ snapshot: string; order: string; openedBrowser: boolean }>
  pollPayment(input: { orderId: string }): Promise<{ order: string }>
}
export const namespace = 'account'
export const api: AccountApi = {
  status: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.status', undefined),
  login: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.login', input),
  register: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.register', input),
  recover: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.recover', input),
  rotateRecovery: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.rotateRecovery', input),
  claimTrial: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.claimTrial', undefined),
  redeemInviteRewards: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.redeemInviteRewards', undefined),
  sessions: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.sessions', undefined),
  paymentOrders: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.paymentOrders', undefined),
  cancelPayment: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.cancelPayment', input),
  cancelNetwork: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.cancelNetwork', input),
  supportContext: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.supportContext', undefined),
  revokeSession: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.revokeSession', input),
  changePassword: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.changePassword', input),
  closeAccount: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.closeAccount', input),
  installationStatus: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.installationStatus', input),
  deviceReportStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.deviceReportStatus', undefined),
  sendDeviceReport: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.sendDeviceReport', undefined),
  logout: () => ipcRenderer.invoke(IPC_CHANNEL, 'account.logout', undefined),
  apply: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.apply', input),
  pay: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.pay', input),
  pollPayment: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'account.pollPayment', input)
}
declare global { interface ToolboxApi { readonly account: AccountApi } }
