import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'

export const namespace = 'networkdiagnostics'
export interface NetworkDiagnosticsApi {
  run(params: { software: DiagnosticSoftware }): Promise<{ snapshot: string }>
}
export const api: NetworkDiagnosticsApi = {
  run: (params) => ipcRenderer.invoke(IPC_CHANNEL, 'networkdiagnostics.run', params) as Promise<{ snapshot: string }>
}
declare global { interface ToolboxApi { readonly networkdiagnostics: NetworkDiagnosticsApi } }
