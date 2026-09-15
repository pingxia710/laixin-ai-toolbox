import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface DiagnosticsApi {
  run(): Promise<{ snapshot: string }>
  copy(): Promise<{ snapshot: string }>
  /** 一键上报。只有客户按下按钮才会调到，⛔ 在别处自动触发。 */
  report(): Promise<{ snapshot: string }>
}
export const namespace = 'diagnostics'
export const api: DiagnosticsApi = {
  run: () => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.run', undefined),
  copy: () => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.copy', undefined),
  report: () => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.report', undefined)
}
declare global { interface ToolboxApi { readonly diagnostics: DiagnosticsApi } }
