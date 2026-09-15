import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { UsageBridgeResponse } from '../../main/codex-usage/types'

export interface CodexUsageApi {
  last(): Promise<UsageBridgeResponse>
  refresh(): Promise<UsageBridgeResponse>
  refreshForAccount?(input: { accountKey: string }): Promise<UsageBridgeResponse>
}

export const namespace = 'codexusage'
export const api: CodexUsageApi = {
  last: () => ipcRenderer.invoke(IPC_CHANNEL, 'codexusage.last', undefined) as Promise<UsageBridgeResponse>,
  refresh: () => ipcRenderer.invoke(IPC_CHANNEL, 'codexusage.refresh', undefined) as Promise<UsageBridgeResponse>,
  refreshForAccount: input => ipcRenderer.invoke(IPC_CHANNEL, 'codexusage.refreshForAccount', input)
}

declare global {
  interface ToolboxApi { readonly codexusage: CodexUsageApi }
}
