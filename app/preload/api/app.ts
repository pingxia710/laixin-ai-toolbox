import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface AppInfo {
  readonly version: string
  readonly platform: string
  readonly architecture: string
  readonly packaged: boolean
}

export interface AppApi {
  info(): Promise<AppInfo>
}

export const namespace = 'app'

export const api: AppApi = {
  info: () => ipcRenderer.invoke(IPC_CHANNEL, 'app.info', undefined) as Promise<AppInfo>
}

declare global {
  interface ToolboxApi {
    readonly app: AppApi
  }
}
