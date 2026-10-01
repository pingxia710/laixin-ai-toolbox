import { session, type DownloadItem } from 'electron'
import type { DownloadCompletion, DownloadEngine, DownloadTransfer } from './download-manager'

// 传输开始后 60 秒没有任何新字节即判卡死,走中断可续传路径;⛔ 只防启动超时。
const STALL_WATCHDOG_MS = 60_000
const STALL_CHECK_INTERVAL_MS = 5_000

// 分区缓存上限:Electron session 无销毁 API,用过的分区进程存活期常驻;按 resourceId
// 复用后跨资源数量仍必须有界,超出只丢缓存引用——空闲分区已由 release() 清理过。
export const DOWNLOAD_PARTITION_LIMIT = 8

export class ElectronDownloadEngine implements DownloadEngine {
  private readonly partitions = new Map<string, Electron.Session>()

  async start(request: Parameters<DownloadEngine['start']>[0]): Promise<DownloadTransfer> {
    if (request.network !== 'direct' && !request.proxyUrl) throw new Error('DOWNLOAD_PROXY_REQUIRED')
    // 内存分区(无 persist: 前缀):cookie/缓存不落盘。分区按 resourceId 复用,
    // ⛔ 按任务 id——每次重试一个新 taskId 就是一个进程存活期常驻的新分区。
    // onBeforeRequest 是单监听槽,后设覆盖前设;上一任务晚到的 release 会清掉监听,
    // 但管理器在完成时仍按 allowedHosts 复核 urlChain,不放行越权主机。
    const downloadSession = this.partitionFor(request.resourceId)
    // 分区可能复用,代理每次重设,⛔ 沿用上一任务的代理规则。
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
        resolve(new ElectronDownloadTransfer(item, () => blockedHost, releaseSession))
      }
      // 启动失败时没有 transfer,也就没人能调 release() ⇒ 代理规则和 once('will-download')
      // 监听全留着。失败路径自己清;transfer.release 走同一入口,⛔ 只清连接不摘监听。
      // 顺序要紧:先断连接(在途请求就此中止,不会再来 will-download),再摘监听,
      // ⛔ 先摘监听——那之间真来一个 item 就没人给它 setSavePath,Electron 会弹保存对话框。
      const releaseSession = async (): Promise<void> => {
        try { await downloadSession.closeAllConnections() } catch { /* 会话可能已被销毁 */ }
        try { await downloadSession.clearStorageData() } catch { /* 会话可能已被销毁 */ }
        downloadSession.removeListener('will-download', onWillDownload)
        try { await downloadSession.webRequest.onBeforeRequest(null) } catch { /* 会话可能已被销毁 */ }
      }
      const timeout = setTimeout(() => {
        timedOut = true
        void releaseSession()
        reject(new Error('DOWNLOAD_ENGINE_START_TIMEOUT'))
      }, 15_000)
      downloadSession.once('will-download', onWillDownload)
      try {
        downloadSession.downloadURL(request.assetUrl)
      } catch (error) {
        clearTimeout(timeout)
        void releaseSession()
        reject(error)
      }
    })
  }

  /** resourceId → 分区 LRU:同资源重试/续传/换源复用同一分区;超限逐出最久未用的引用。 */
  private partitionFor(resourceId: string): Electron.Session {
    const existing = this.partitions.get(resourceId)
    if (existing !== undefined) {
      this.partitions.delete(resourceId)
      this.partitions.set(resourceId, existing)
      return existing
    }
    // 分区名只保留安全字符,⛔ 目录条目 id 里的特殊字符进分区名。
    const created = session.fromPartition(`toolbox-download-${resourceId.replace(/[^a-zA-Z0-9-]/g, '-')}`, { cache: false })
    this.partitions.set(resourceId, created)
    while (this.partitions.size > DOWNLOAD_PARTITION_LIMIT) {
      const oldest = this.partitions.keys().next().value
      if (oldest === undefined) break
      this.partitions.delete(oldest)
    }
    return created
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

  constructor(private readonly item: DownloadItem, private readonly blockedHost: () => boolean, private readonly releaseSession: () => Promise<void>) {
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

  /** 任务终态后由管理器调用:停看门狗,并走与失败路径同一入口释放会话(断连接、清存储、摘监听)。 */
  async release(): Promise<void> {
    this.stopWatchdog()
    await this.releaseSession()
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
