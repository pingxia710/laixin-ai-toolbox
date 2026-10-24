import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface OfficialAccountApi {
  read(input: { shell: 'codex' | 'claude' }): Promise<{ snapshot: string }>
}

export const namespace = 'officialaccount'
export const api: OfficialAccountApi = {
  read: input => ipcRenderer.invoke(IPC_CHANNEL, 'officialaccount.read', input)
}

declare global {
  interface ToolboxApi { readonly officialaccount: OfficialAccountApi }
}
