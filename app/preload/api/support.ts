import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
export const namespace = 'support'
export const api = { open: (): Promise<{ opened: boolean }> => ipcRenderer.invoke(IPC_CHANNEL, 'support.open', undefined) }
declare global { interface ToolboxApi { readonly support: typeof api } }
