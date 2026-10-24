import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'
import type { PlanUsageBridgeResponse } from '../../shared/plan-usage-types'

export interface PlanUsageApi {
  read(input: { platform: string }): Promise<PlanUsageBridgeResponse>
  openOfficialPage(input: { platform: string }): Promise<PlanUsageBridgeResponse>
}

export const namespace = 'planusage'
export const api: PlanUsageApi = {
  read: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'planusage.read', input) as Promise<PlanUsageBridgeResponse>,
  openOfficialPage: (input) => ipcRenderer.invoke(IPC_CHANNEL, 'planusage.openOfficialPage', input) as Promise<PlanUsageBridgeResponse>
}

declare global {
  interface ToolboxApi { readonly planusage: PlanUsageApi }
}
