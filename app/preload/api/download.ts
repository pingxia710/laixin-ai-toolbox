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

// RETIRE01:下载引擎退役后仅保留「到官方下载页」;latest/status 只服务于从未接线的引擎,一并移除。
export interface DownloadApi {
  openExternal(resourceId: string): Promise<DownloadTaskResult>
}

export const namespace = 'download'

export const api: DownloadApi = {
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
