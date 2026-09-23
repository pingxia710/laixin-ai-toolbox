import { ipcRenderer } from 'electron'
import { IPC_CHANNEL } from '../../bridge-protocol'

export interface DownloadTaskResult {
  readonly taskId: string
  readonly state: string
  readonly reason: string
  readonly message: string
  readonly receivedBytes: string
  readonly totalBytes: string
  readonly retryCount: string
  readonly localSha256: string
  readonly installerPath: string
}

export interface DownloadApi {
  latest(resourceId: string): Promise<DownloadTaskResult>
  status(taskId: string): Promise<DownloadTaskResult>
  openExternal(resourceId: string): Promise<DownloadTaskResult>
}

export const namespace = 'download'

export const api: DownloadApi = {
  latest: (resourceId) => invoke('download.latest', { resourceId }),
  status: (taskId) => invoke('download.status', { taskId }),
  openExternal: (resourceId) => invoke('download.openExternal', { resourceId })
}

function invoke(action: string, params: object): Promise<DownloadTaskResult> {
  return ipcRenderer.invoke(IPC_CHANNEL, action, params) as Promise<DownloadTaskResult>
}

declare global {
  interface ToolboxApi {
    readonly download: DownloadApi
  }
}
