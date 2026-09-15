import { session, type DownloadItem } from 'electron'
import type { DownloadCompletion, DownloadEngine, DownloadTransfer } from './download-manager'

// 传输开始后 60 秒没有任何新字节即判卡死,走中断可续传路径;⛔ 只防启动超时。
const STALL_WATCHDOG_MS = 60_000
const STALL_CHECK_INTERVAL_MS = 5_000

export class ElectronDownloadEngine implements DownloadEngine {
  async start(request: Parameters<DownloadEngine['start']>[0]): Promise<DownloadTransfer> {
    // 内存分区:不带 persist: 前缀,cookie/缓存不落盘,任务终态后整体释放。
    const downloadSession = session.fromPartition(`toolbox-download-${request.taskId}${request.sourceId ? `-${request.sourceId}` : ''}`, { cache: false })
    if (request.network !== 'direct' && !request.proxyUrl) throw new Error('DOWNLOAD_PROXY_REQUIRED')
    await downloadSession.setProxy(request.network === 'direct' ? { mode: 'direct' } : {
      mode: 'fixed_servers',
      proxyRules: request.proxyUrl,
      proxyBypassRules: '<-loopback>'
    })

    let blockedHost = false
    downloadSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const allowed = request.allowedHosts.includes(new URL(details.url).hostname)
        blockedHost ||= !allowed
        callback({ cancel: !allowed })
      } catch {
        blockedHost = true
        callback({ cancel: true })
      }
    })

    return new Promise<DownloadTransfer>((resolve, reject) => {
      let timedOut = false
      const onWillDownload = (_event: Electron.Event, item: DownloadItem): void => {
        clearTimeout(timeout)
        if (timedOut) { item.cancel(); return }
        item.setSavePath(request.partPath)
        resolve(new ElectronDownloadTransfer(item, () => blockedHost, downloadSession))
      }
      // 启动失败时没有 transfer,也就没人能调 release() ⇒ 分区 Session、代理规则和
      // once('will-download') 监听全留着,而每次重试都是新 taskId、新分区。失败路径自己清。
      // 顺序要紧:先断连接(在途请求就此中止,不会再来 will-download),再摘监听,
      // ⛔ 先摘监听——那之间真来一个 item 就没人给它 setSavePath,Electron 会弹保存对话框。
      const releaseOnFailure = async (): Promise<void> => {
        try { await downloadSession.closeAllConnections() } catch { /* 会话可能已被销毁 */ }
        try { await downloadSession.clearStorageData() } catch { /* 会话可能已被销毁 */ }
        downloadSession.removeListener('will-download', onWillDownload)
        try { downloadSession.webRequest.onBeforeRequest(null) } catch { /* 会话可能已被销毁 */ }
      }
      const timeout = setTimeout(() => {
        timedOut = true
        void releaseOnFailure()
        reject(new Error('DOWNLOAD_ENGINE_START_TIMEOUT'))
      }, 15_000)
      downloadSession.once('will-download', onWillDownload)
      try {
        downloadSession.downloadURL(request.assetUrl)
      } catch (error) {
        clearTimeout(timeout)
        void releaseOnFailure()
        reject(error)
      }
    })
  }
}

class ElectronDownloadTransfer implements DownloadTransfer {
  private readonly progressListeners: Array<(receivedBytes: number, totalBytes: number) => void> = []
  private readonly completions: DownloadCompletion[] = []
  private readonly completionWaiters: Array<(completion: DownloadCompletion) => void> = []
  private interruptionPublished = false
  private stalled = false
  private settled = false
  private lastActivityAt = Date.now()
  private watchdog: ReturnType<typeof setInterval> | undefined = setInterval(() => this.checkStall(), STALL_CHECK_INTERVAL_MS)

  constructor(private readonly item: DownloadItem, private readonly blockedHost: () => boolean, private readonly downloadSession: Electron.Session) {
    item.on('updated', (_event, state) => {
      this.lastActivityAt = Date.now()
      this.progressListeners.forEach((listener) => listener(item.getReceivedBytes(), item.getTotalBytes()))
      if (state === 'interrupted' && !this.interruptionPublished) {
        this.interruptionPublished = true
        this.publish('interrupted', item.canResume())
      }
    })
    item.on('done', (_event, state) => {
      this.stopWatchdog()
      this.settled = true
      this.publish(state, false)
    })
    if (item.getState() === 'interrupted') {
      this.interruptionPublished = true
      this.publish('interrupted', item.canResume())
    }
  }

  /** 任务终态后由管理器调用:停看门狗、断开连接并清空分区存储,释放会话。 */
  async release(): Promise<void> {
    this.stopWatchdog()
    try { await this.downloadSession.closeAllConnections() } catch { /* 会话可能已被销毁 */ }
    try { await this.downloadSession.clearStorageData() } catch { /* 会话可能已被销毁 */ }
  }

  onProgress(listener: (receivedBytes: number, totalBytes: number) => void): void {
    this.progressListeners.push(listener)
  }

  waitForCompletion(): Promise<DownloadCompletion> {
    const completion = this.completions.shift()
    if (completion !== undefined) {
      return Promise.resolve(completion)
    }
    return new Promise((resolve) => this.completionWaiters.push(resolve))
  }

  cancel(): void {
    this.item.cancel()
  }

  resume(): void {
    this.interruptionPublished = false
    this.stalled = false
    this.settled = false
    this.lastActivityAt = Date.now()
    this.stopWatchdog()
    this.watchdog = setInterval(() => this.checkStall(), STALL_CHECK_INTERVAL_MS)
    this.item.resume()
  }

  private checkStall(): void {
    if (this.settled || this.stalled) return
    if (Date.now() - this.lastActivityAt < STALL_WATCHDOG_MS) return
    this.stalled = true
    this.interruptionPublished = true
    this.stopWatchdog()
    this.publish('interrupted', this.item.canResume())
    this.item.cancel()
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private publish(state: string, canResume: boolean): void {
    // stall 后 item.cancel() 会再发一个 done(cancelled);恢复之前必须吞掉,⛔ 被续传监听当成用户取消。
    if (this.stalled && state === 'cancelled') return
    const item = this.item
    const completion: DownloadCompletion = {
      state: this.resolveState(state),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      canResume: !this.blockedHost() && canResume,
      etag: item.getETag(),
      lastModified: item.getLastModifiedTime(),
      mimeType: item.getMimeType(),
      urlChain: item.getURLChain()
    }
    const waiter = this.completionWaiters.shift()
    if (waiter === undefined) {
      this.completions.push(completion)
    } else {
      waiter(completion)
    }
  }

  private resolveState(value: string): DownloadCompletion['state'] {
    if (value === 'completed') return 'completed'
    if (value === 'cancelled') return 'cancelled'
    return 'interrupted'
  }
}
