import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export const namespace = 'networkquality'
export interface NetworkQualityApi {
  run(params: { share: boolean }): Promise<{ snapshot: string }>
  cancel(): Promise<{ cancelled: boolean }>
}
export const api: NetworkQualityApi = {
  run: params => ipcRenderer.invoke(IPC_CHANNEL, 'networkquality.run', params) as Promise<{ snapshot: string }>,
  cancel: () => ipcRenderer.invoke(IPC_CHANNEL, 'networkquality.cancel', undefined) as Promise<{ cancelled: boolean }>
}
declare global { interface ToolboxApi { readonly networkquality: NetworkQualityApi } }
