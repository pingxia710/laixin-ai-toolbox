import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'

export interface DiagnosticsApi {
  run(params: { readonly software: DiagnosticSoftware }): Promise<{ snapshot: string }>
  /** 网络卡报障专用：要求此次点击之后独立的新诊断；已有检查未结时拒绝复用。 */
  runForReport(params: { readonly software: DiagnosticSoftware }): Promise<{ snapshot: string }>
  /** 空 id 采集网络卡片即时信息；非空 id 使用已选软件的同次诊断。 */
  copy(params: { readonly id: string }): Promise<{ snapshot: string }>
  /** 一键上报。只有客户按下按钮才会调到，⛔ 在别处自动触发。 */
  report(params: { readonly id: string }): Promise<{ snapshot: string }>
  /** 当次诊断未完成，按所选软件提交即时状态与日志。 */
  reportIncomplete(params: { readonly software: DiagnosticSoftware }): Promise<{ snapshot: string }>
}
export const namespace = 'diagnostics'
export const api: DiagnosticsApi = {
  run: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.run', params),
  runForReport: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.runForReport', params),
  copy: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.copy', params),
  report: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.report', params),
  reportIncomplete: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'diagnostics.reportIncomplete', params)
}
declare global { interface ToolboxApi { readonly diagnostics: DiagnosticsApi } }
