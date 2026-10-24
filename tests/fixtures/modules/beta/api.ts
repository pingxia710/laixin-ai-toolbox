import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

interface BetaApi {
  echo(): Promise<{ readonly source: string }>
}

export const namespace = 'beta'

export const api: BetaApi = {
  echo: () => ipcRenderer.invoke(IPC_CHANNEL, 'beta.echo', undefined) as Promise<{ readonly source: string }>
}

declare global {
  interface ToolboxApi {
    readonly beta: BetaApi
  }
}
