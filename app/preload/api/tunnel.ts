import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { NetworkRepairStatus } from '../../shared/network-repair'

export interface TunnelActionResult {
  readonly outcome: string
  readonly code: string
  readonly message: string
}

export interface TunnelImportResult extends TunnelActionResult {
  readonly authorizationId: string
  readonly nodeLabel: string
  readonly expiresAt: string
  readonly source: string
  readonly pendingAvailable: boolean
}

export interface TunnelStatusView {
  readonly currentConfig: string
  readonly pendingConfig: string
  readonly canApplyPending: boolean
  readonly state: string
  readonly message: string
  readonly source: string
  readonly authorization: string
  readonly backend: string
  readonly nodeLabel: string
  readonly exitIp: string
  /** 这一刻走的哪条路:来信通道 / 复用电脑上已有外网 / 未连接。界面按它说话,⛔ 猜。 */
  readonly pathSource: '' | 'laixin' | 'reused'
  readonly lastVerifiedAt: string
  readonly configVersion: string
  readonly expiresAt: string
  readonly pendingAvailable: boolean
  readonly unrestored: string
  readonly componentMissing: string
  readonly traffic?: string
}

export interface RouteExplanationView {
  readonly outcome: 'direct' | 'tunnel' | 'dedicated' | 'kernel-check' | 'invalid' | 'unconfigured'
  readonly reasonCode: string
  readonly title: string
  readonly detail: string
  /** 具体命中的那一条规则；判不出时为空串（主进程 D4 已下发，界面按它显示）。 */
  readonly matchedRule: string
}

export interface TunnelApi {
  syncAccountConfig(): Promise<TunnelActionResult>
  importConfig(): Promise<TunnelImportResult>
  applyPending(): Promise<TunnelActionResult>
  start(): Promise<TunnelActionResult>
  stop(): Promise<TunnelActionResult>
  repair(): Promise<TunnelActionResult>
  repairStatus(): Promise<NetworkRepairStatus>
  status(): Promise<TunnelStatusView>
  explainRoute(host: string): Promise<RouteExplanationView>
}

export const namespace = 'tunnel'

export const api: TunnelApi = {
  syncAccountConfig: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.syncAccountConfig', undefined) as Promise<TunnelActionResult>,
  importConfig: () =>
    ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.importConfig', undefined) as Promise<TunnelImportResult>,
  applyPending: () =>
    ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.applyPending', undefined) as Promise<TunnelActionResult>,
  start: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.start', undefined) as Promise<TunnelActionResult>,
  stop: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.stop', undefined) as Promise<TunnelActionResult>,
  repair: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.repair', undefined) as Promise<TunnelActionResult>,
  repairStatus: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.repairStatus', undefined) as Promise<NetworkRepairStatus>,
  status: () => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.status', undefined) as Promise<TunnelStatusView>,
  explainRoute: (host) => ipcRenderer.invoke(IPC_CHANNEL, 'tunnel.explainRoute', { host }) as Promise<RouteExplanationView>
}

declare global {
  interface ToolboxApi {
    readonly tunnel: TunnelApi
  }
}
