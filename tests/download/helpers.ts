import { DownloadManagerError, type DownloadManager } from '../../app/main/download/download-manager'
import type { DownloadTaskSnapshot } from '../../app/main/download/types'

/** 测试专用:轮询任务直至离开 downloading/verifying;生产类不提供此方法(生产零调用点)。 */
export async function waitForSettled(manager: DownloadManager, taskId: string): Promise<DownloadTaskSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await manager.status(taskId)
    if (task.state !== 'downloading' && task.state !== 'verifying') {
      return task
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new DownloadManagerError('DOWNLOAD_SETTLE_TIMEOUT')
}
