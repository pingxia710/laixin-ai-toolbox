import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

interface AlphaApi {
  echo(): Promise<{ readonly source: string }>
}

export const namespace = 'alpha'

export const api: AlphaApi = {
  echo: () => ipcRenderer.invoke(IPC_CHANNEL, 'alpha.echo', undefined) as Promise<{ readonly source: string }>
}

declare global {
  interface ToolboxApi {
    readonly alpha: AlphaApi
  }
}
