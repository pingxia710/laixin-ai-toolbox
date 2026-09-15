import { randomUUID } from 'node:crypto'
import { isVerifyTimeout } from './types'
import type {
  ArtifactIdentity,
  DownloadArtifactInspector,
  DownloadCatalog,
  DownloadResource,
  DownloadSource,
  DownloadState,
  DownloadTaskSnapshot,
  DownloadTaskStore,
  StoredDownloadTask,
  TunnelSnapshot
} from './types'

export interface DownloadCompletion {
  readonly state: 'completed' | 'cancelled' | 'interrupted'
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly canResume: boolean
  readonly etag: string
  readonly lastModified: string
  readonly mimeType: string
  readonly urlChain: readonly string[]
}

export interface DownloadTransfer {
  onProgress(listener: (receivedBytes: number, totalBytes: number) => void): Promise<void> | void
  waitForCompletion(): Promise<DownloadCompletion>
  cancel(): void
  resume(): void
  /** 任务终态后释放引擎侧资源(会话、连接、缓存);引擎没有额外资源时可缺省。 */
  release?(): Promise<void>
}

export interface DownloadEngine {
  start(request: {
    readonly taskId: string
    readonly sourceId?: string
    readonly assetUrl: string
    readonly allowedHosts: readonly string[]
    readonly proxyUrl: string
    readonly network?: 'direct' | 'tunnel'
    readonly partPath: string
  }): Promise<DownloadTransfer>
}

export class DownloadManagerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DownloadManagerError'
  }
}

interface ActiveTransfer {
  readonly resource: DownloadResource
  readonly transfer: DownloadTransfer
  readonly sources: readonly DownloadSource[]
  readonly sourceIndex: number
}

// 下载进度落盘节流:每个进度事件不落盘,至少间隔这么久才写一次;终态由状态迁移强制落盘。
const PROGRESS_PERSIST_INTERVAL_MS = 500
// 自动恢复中断的指数退避:第 1/2/3 次重试分别等待 2s/8s/30s,⛔ 瞬间烧完重试次数。
const RETRY_BACKOFF_MS = [2_000, 8_000, 30_000] as const

export interface DownloadManagerOptions {
  readonly catalog: DownloadCatalog
  readonly engine: DownloadEngine
  readonly store: DownloadTaskStore
  readonly inspector: DownloadArtifactInspector
  readonly tunnel: () => TunnelSnapshot
  readonly taskId?: () => string
  readonly taskPaths?: (taskId: string, resource: DownloadResource) => { readonly artifactPath: string; readonly partPath: string }
  readonly externalOpen?: (url: string) => Promise<void>
  readonly installerHandoff?: (task: StoredDownloadTask, resource: DownloadResource) => Promise<string>
  readonly copyLocalArtifact?: (source: string, destination: string) => Promise<void>
  readonly hasExistingInstallation?: (resource: DownloadResource) => boolean
  readonly autoResumeLimit?: number
  readonly retryBackoffMs?: readonly number[]
  readonly now?: () => string
}

export class DownloadManager {
  private readonly resources = new Map<string, DownloadResource>()
  private readonly active = new Map<string, ActiveTransfer>()
  private readonly taskId: () => string
  private readonly taskPaths: NonNullable<DownloadManagerOptions['taskPaths']>
  private readonly autoResumeLimit: number
  private readonly retryBackoffMs: readonly number[]
  private readonly now: () => string
  private disposed = false
  private readonly pending = new Map<string, Promise<DownloadTaskSnapshot>>()
  // 同一任务的记录写入串行化,⛔ 进度回写与状态迁移并发互相覆盖(收敛档 E-7)。
  private readonly writeQueues = new Map<string, Promise<unknown>>()
  // 在途校验的取消句柄:校验要跑 hdiutil/codesign 等子进程,没有它客户就只能停在
  // 「校验中」等重启。cancel 拿它杀子进程,verify 拿它判「已经被取消了,别再写状态」。
  private readonly verifications = new Map<string, AbortController>()
  private readonly progressWrites = new Map<string, { receivedBytes: string; totalBytes: string; timer?: ReturnType<typeof setTimeout>; dirty: boolean }>()

  constructor(private readonly options: DownloadManagerOptions) {
    for (const resource of options.catalog.resources) {
      this.resources.set(resource.id, resource)
    }
    this.taskId = options.taskId ?? randomUUID
    this.taskPaths = options.taskPaths ?? (() => ({ artifactPath: '', partPath: '' }))
    this.autoResumeLimit = options.autoResumeLimit ?? 3
    this.retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async start(resourceId: string): Promise<DownloadTaskSnapshot> {
    return this.exclusive(resourceId, () => this.startDownload(resourceId))
  }

  private async startDownload(resourceId: string): Promise<DownloadTaskSnapshot> {
    if (this.disposed) throw new DownloadManagerError('DOWNLOAD_MANAGER_CLOSED')
    const resource = this.requireResource(resourceId)
    const latest = await this.latest(resourceId)
    if (latest && ['downloading', 'verifying', 'interrupted-resumable'].includes(latest.state)) return latest
    if (resource.type === 'external-entry') {
      return this.openExternal(resourceId)
    }

    if (this.options.hasExistingInstallation?.(resource) === true) {
      const confirmation = {
        ...this.createTask(resource, 'not-downloaded'),
        reason: 'existing-installation',
        message: '检测到已安装，请先确认'
      }
      await this.persist(confirmation, 'existing-installation-confirmation-required')
      return confirmation
    }

    const sources = this.sourcesFor(resource)
    const available = sources.some((source) => this.connectionFor(source) !== undefined)
    const task = this.createTask(resource, available ? 'downloading' : 'needs-tunnel')
    if (task.state === 'needs-tunnel') {
      // 连不上通道,这次根本没开始下 ⇒ 先别动上次保留的包,客户还可能回去重试校验。
      await this.persist(task, 'needs-tunnel')
      return task
    }

    // 到这里才是真的重新下一份:上次校验超时保留的那份再没人会碰,清掉。
    await this.discardRetainedArtifacts(resourceId)
    await this.persist(task, 'downloading')
    await this.beginTransfer(task, resource, sources, 0)
    return this.requireTask(task.taskId)
  }

  private sourcesFor(resource: DownloadResource): readonly DownloadSource[] {
    const sources = resource.sources ?? [{ id: 'official', assetUrl: resource.assetUrl ?? '', allowedHosts: resource.allowedHosts, network: 'tunnel' as const }]
    return [...sources].sort((a, b) => Number(a.network === 'tunnel') - Number(b.network === 'tunnel'))
  }

  private connectionFor(source: DownloadSource): string | undefined {
    if (source.network === 'direct') return ''
    const tunnel = this.options.tunnel()
    return tunnel.state === 'connected' && tunnel.localProxyUrl ? tunnel.localProxyUrl : undefined
  }

  private async beginTransfer(task: StoredDownloadTask, resource: DownloadResource, sources: readonly DownloadSource[], from: number): Promise<void> {
    let waitingForTunnel = false
    for (let index = from; index < sources.length; index++) {
      if (this.disposed || (await this.requireTask(task.taskId)).state === 'cancelled') return
      const source = sources[index]
      const proxyUrl = this.connectionFor(source)
      if (proxyUrl === undefined) { waitingForTunnel = true; continue }
      await this.options.store.deletePart(task)
      await this.update(task.taskId, { state: 'downloading', reason: '', receivedBytes: '0', retryCount: '0', resumeEtag: '', resumeLastModified: '', message: index === 0 ? '下载中' : '正在尝试备用下载渠道' })
      let transfer: DownloadTransfer
      try {
        transfer = await this.options.engine.start({ taskId: task.taskId, sourceId: source.id, assetUrl: source.assetUrl, allowedHosts: source.allowedHosts, proxyUrl, network: source.network, partPath: task.partPath })
      } catch {
        if (this.disposed || (await this.requireTask(task.taskId)).state === 'cancelled') return
        await this.options.store.appendEvent({ at: this.now(), result: 'download-source-unavailable', sourceId: source.id })
        continue
      }
      if (this.disposed || (await this.requireTask(task.taskId)).state === 'cancelled') {
        transfer.cancel()
        await this.releaseTransfer(transfer)
        return
      }
      this.active.set(task.taskId, { resource, transfer, sources, sourceIndex: index })
      transfer.onProgress((receivedBytes, totalBytes) => {
        if (this.active.get(task.taskId)?.transfer !== transfer) return
        this.recordProgress(task.taskId, receivedBytes, totalBytes)
      })
      void this.monitor(task.taskId)
      return
    }
    if (waitingForTunnel) {
      await this.update(task.taskId, { state: 'needs-tunnel', reason: 'tunnel-not-connected', message: '当前渠道暂不可用，可连接网络后重试备用渠道' })
    } else {
      await this.fail(task.taskId, 'network-interrupted', '下载渠道暂不可用，请重试或使用备用入口')
    }
  }

  async cancel(taskId: string): Promise<DownloadTaskSnapshot> {
    const task = await this.requireTask(taskId)
    // verifying 也允许取消:校验挂住时(hdiutil 等许可协议、codesign 久挂)这是客户
    // 唯一的出口,⛔ 让他只能退出工具箱重开。
    if (task.state !== 'downloading' && task.state !== 'interrupted-resumable' && task.state !== 'verifying') {
      throw new DownloadManagerError('DOWNLOAD_CANCEL_NOT_ALLOWED')
    }
    // 先中止在途校验:杀掉子进程并让 verify 停手,再落取消态,
    // ⛔ 让它在我们写完之后又把状态改成 ready / 不是安装包。
    this.verifications.get(taskId)?.abort()
    this.active.get(taskId)?.transfer.cancel()
    const cancelled = await this.update(taskId, {
      state: 'cancelled',
      reason: 'cancelled',
      message: '已取消',
      endedAt: this.now()
    })
    await this.options.store.deletePart(cancelled)
    // verifying 时分段已提升成正式文件:取消就一并清掉,⛔ 留一个没校验完的包在盘上。
    if (task.state === 'verifying') await this.options.store.deleteArtifact(cancelled)
    await this.persist(cancelled, 'cancelled')
    await this.releaseActive(taskId)
    return cancelled
  }

  async retry(taskId: string): Promise<DownloadTaskSnapshot> {
    const task = await this.requireTask(taskId)
    // 校验超时是「没判出来」不是「判坏了」:包还在原处,重试就只重新校验,
    // ⛔ 让客户为一次判不出来把几百 MB 重下一遍。
    if (task.state === 'failed' && task.reason === 'verify-timeout') {
      return this.exclusive(`verify:${taskId}`, () => this.retryVerification(taskId))
    }
    if (task.state !== 'interrupted-terminal' && task.state !== 'failed' && task.state !== 'needs-tunnel') {
      throw new DownloadManagerError('DOWNLOAD_RETRY_NOT_ALLOWED')
    }
    return this.start(task.resourceId)
  }

  private async retryVerification(taskId: string): Promise<DownloadTaskSnapshot> {
    if (this.disposed) throw new DownloadManagerError('DOWNLOAD_MANAGER_CLOSED')
    const task = await this.requireTask(taskId)
    const resource = this.requireResource(task.resourceId)
    // 包真的还在才谈得上重新校验;不在了就退回原来的重下路径,⛔ 对着空气反复校验。
    if (resource.type !== 'download' || await this.options.store.artifactStatus(task) === undefined) {
      return this.start(task.resourceId)
    }
    const verifying = await this.update(taskId, { state: 'verifying', reason: '', message: '正在核验本地安装包', endedAt: '' })
    await this.persist(verifying, 'verify-retry')
    await this.verify(taskId, resource, { mimeType: '' })
    return this.requireTask(taskId)
  }

  async resume(taskId: string): Promise<DownloadTaskSnapshot> {
    const task = await this.requireTask(taskId)
    const active = this.active.get(taskId)
    if (task.state !== 'interrupted-resumable' || active === undefined) {
      throw new DownloadManagerError('DOWNLOAD_RESUME_NOT_ALLOWED')
    }
    active.transfer.resume()
    const resumed = await this.update(taskId, { state: 'downloading', reason: '', message: '下载中' })
    await this.persist(resumed, 'resumed')
    void this.monitor(taskId)
    return resumed
  }

  async status(taskId: string): Promise<DownloadTaskSnapshot> {
    return this.requireTask(taskId)
  }

  async latest(resourceId: string): Promise<DownloadTaskSnapshot | undefined> {
    this.requireResource(resourceId)
    return (await this.options.store.list()).filter((task) => task.resourceId === resourceId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).at(0)
  }

  async importLocal(resourceId: string, source: string): Promise<DownloadTaskSnapshot> {
    return this.exclusive(resourceId, async () => {
      if (this.disposed) throw new DownloadManagerError('DOWNLOAD_MANAGER_CLOSED')
      const resource = this.requireResource(resourceId)
      if (resource.type !== 'download' || !this.options.copyLocalArtifact) throw new DownloadManagerError('DOWNLOAD_LOCAL_IMPORT_UNAVAILABLE')
      const latest = await this.latest(resourceId)
      if (latest && ['downloading', 'verifying', 'interrupted-resumable'].includes(latest.state)) throw new DownloadManagerError('DOWNLOAD_BUSY')
      const task = { ...this.createTask(resource, 'verifying'), message: '正在核验本地安装包' }
      await this.persist(task, 'local-import')
      try {
        // source is supplied only by the native file picker, never by renderer IPC.
        await this.options.copyLocalArtifact(source, task.partPath)
        await this.options.store.promotePart(task)
        // 新的一份已经落好,上次校验超时保留的那份才可以清;⛔ 拷贝失败时两份都没了。
        await this.discardRetainedArtifacts(resourceId)
        await this.verify(task.taskId, resource, { mimeType: '' })
      } catch {
        await this.fail(task.taskId, 'local-file-unavailable', '无法读取安装包，请重新选择或求助')
      }
      return this.requireTask(task.taskId)
    })
  }

  private exclusive(resourceId: string, operation: () => Promise<DownloadTaskSnapshot>): Promise<DownloadTaskSnapshot> {
    const pending = this.pending.get(resourceId)
    if (pending) return pending
    const result = operation().finally(() => { this.pending.delete(resourceId) })
    this.pending.set(resourceId, result)
    return result
  }

  async openInstaller(taskId: string): Promise<DownloadTaskSnapshot> {
    return this.exclusive(`open:${taskId}`, () => this.handoffInstaller(taskId))
  }

  private async handoffInstaller(taskId: string): Promise<DownloadTaskSnapshot> {
    const task = await this.requireTask(taskId)
    if (task.state !== 'ready' && task.state !== 'handed-off-install') {
      throw new DownloadManagerError('DOWNLOAD_INSTALLER_NOT_READY')
    }
    const resource = this.requireResource(task.resourceId)
    if (resource.type !== 'download') throw new DownloadManagerError('DOWNLOAD_INSTALLER_NOT_READY')
    await this.verify(taskId, resource, { mimeType: '' })
    const checked = await this.requireTask(taskId)
    if (checked.state !== 'ready') return checked
    let message: string
    try {
      if (!this.options.installerHandoff) throw new DownloadManagerError('DOWNLOAD_HANDOFF_UNAVAILABLE')
      message = await this.options.installerHandoff(checked, resource)
    } catch {
      const failed = await this.update(taskId, {
        state: 'ready',
        reason: 'installer-open-failed',
        message: '安装包未能打开，已核验的文件仍保留。请重试打开或求助，无需重新下载。',
        endedAt: this.now()
      })
      await this.persist(failed, 'installer-open-failed')
      return failed
    }
    const handedOff = await this.update(taskId, {
      state: 'handed-off-install',
      reason: '',
      message,
      endedAt: this.now()
    })
    await this.persist(handedOff, 'handed-off-install')
    return handedOff
  }

  async openExternal(resourceId: string): Promise<DownloadTaskSnapshot> {
    const resource = this.requireResource(resourceId)
    if (resource.type !== 'external-entry') {
      throw new DownloadManagerError('DOWNLOAD_EXTERNAL_ENTRY_REQUIRED')
    }
    if (!this.options.externalOpen) throw new DownloadManagerError('DOWNLOAD_HANDOFF_UNAVAILABLE')
    await this.options.externalOpen(resource.officialPageUrl)
    const task = this.createTask(resource, 'handed-off-install')
    const handedOff = {
      ...task,
      message: '已交给系统打开 / 安装待核',
      endedAt: this.now()
    }
    await this.persist(handedOff, 'handed-off-install')
    return handedOff
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const [taskId, active] of this.active.entries()) {
      active.transfer.cancel()
      await this.releaseTransfer(active.transfer)
      this.progressWrites.delete(taskId)
    }
    this.active.clear()
  }

  async recoverAfterRestart(): Promise<void> {
    for (const task of await this.options.store.list()) {
      if (task.state === 'ready' || task.state === 'handed-off-install') {
        const resource = this.resources.get(task.resourceId)
        if (resource?.type === 'external-entry') continue
        const matchesResource = (sha256: string, byteLength: number): boolean =>
          resource !== undefined && byteLength === Number(resource.expectedBytes) &&
          sha256 === task.localSha256 && sha256 === resource.recordedSha256 &&
          (resource.officialSha256 === null || sha256 === resource.officialSha256)
        // 核验时记录过 size+mtime 且文件没变 → 免读内容免重算,⛔ 每次启动把所有大包重哈希一遍。
        let intact = false
        if (resource !== undefined && task.localSha256 !== '' && (task.artifactSize ?? '') !== '' && (task.artifactMtimeMs ?? '') !== '') {
          const info = await this.options.store.artifactStatus(task)
          intact = info !== undefined && String(info.size) === task.artifactSize &&
            String(info.mtimeMs) === task.artifactMtimeMs && matchesResource(task.localSha256, info.size)
        }
        if (intact) continue
        const digest = await this.options.store.hashArtifact(task)
        if (digest !== undefined && matchesResource(digest.sha256, digest.byteLength)) continue
        await this.options.store.deleteArtifact(task)
        await this.persist({ ...task, state: 'failed', reason: 'artifact-unavailable', message: '上次的安装包已不在原处或不符合当前核验记录，请重新准备安装包。', receivedBytes: '0', localSha256: '' }, 'artifact-unavailable')
      } else if (['downloading', 'verifying', 'interrupted-resumable'].includes(task.state)) {
        await this.options.store.deletePart(task)
        await this.persist({ ...task, state: 'interrupted-terminal', reason: 'app-restarted', message: '上次下载因工具箱退出而中断，无法续传原分段。点击“重新下载”继续，原安装步骤保留。', resumeEtag: '', resumeLastModified: '', endedAt: this.now() }, 'interrupted-after-restart')
      }
    }
  }

  async waitForSettled(taskId: string): Promise<DownloadTaskSnapshot> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = await this.requireTask(taskId)
      if (task.state !== 'downloading' && task.state !== 'verifying') {
        return task
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new DownloadManagerError('DOWNLOAD_SETTLE_TIMEOUT')
  }

  private async monitor(taskId: string): Promise<void> {
    const active = this.active.get(taskId)
    if (active === undefined) {
      return
    }
    const completion = await active.transfer.waitForCompletion()
    if (this.disposed || this.active.get(taskId) !== active) {
      await this.releaseTransfer(active.transfer)
      return
    }
    const task = await this.requireTask(taskId)
    if (task.state === 'cancelled') {
      await this.releaseActive(taskId)
      return
    }
    if (!this.isAllowedUrlChain(completion.urlChain, active.sources[active.sourceIndex].allowedHosts)) {
      await this.fail(taskId, 'host-not-allowed', '主机不在清单')
      return
    }
    if (completion.state === 'cancelled') {
      const cancelled = await this.update(taskId, { state: 'cancelled', reason: 'cancelled', message: '已取消', endedAt: this.now() })
      await this.options.store.deletePart(cancelled)
      await this.persist(cancelled, 'cancelled')
      await this.releaseActive(taskId)
      return
    }
    if (completion.state === 'interrupted') {
      if (completion.canResume) {
        const resumable = await this.update(taskId, {
          state: 'interrupted-resumable',
          reason: 'network-interrupted',
          message: '已中断·可恢复',
          receivedBytes: String(completion.receivedBytes),
          totalBytes: String(completion.totalBytes),
          resumeEtag: completion.etag,
          resumeLastModified: completion.lastModified
        })
        await this.persist(resumable, 'interrupted-resumable')
        if (Number(resumable.retryCount) < this.autoResumeLimit) {
          const retried = await this.update(taskId, { retryCount: String(Number(resumable.retryCount) + 1) })
          const backoffIndex = Math.min(Number(retried.retryCount) - 1, this.retryBackoffMs.length - 1)
          setTimeout(() => void this.resume(taskId).catch(() => undefined), this.retryBackoffMs[Math.max(0, backoffIndex)])
        } else if (active.sourceIndex + 1 < active.sources.length) {
          await this.releaseTransfer(active.transfer)
          active.transfer.cancel()
          await this.beginTransfer(resumable, active.resource, active.sources, active.sourceIndex + 1)
        }
        return
      }
      const sourceChanged = task.resumeEtag !== '' && task.resumeEtag !== completion.etag
      if (!sourceChanged && active.sourceIndex + 1 < active.sources.length) {
        await this.releaseTransfer(active.transfer)
        await this.beginTransfer(task, active.resource, active.sources, active.sourceIndex + 1)
        return
      }
      const terminal = await this.update(taskId, {
        state: 'interrupted-terminal',
        reason: sourceChanged ? 'source-changed' : 'network-interrupted',
        message: '已中断·已终止',
        receivedBytes: String(completion.receivedBytes),
        totalBytes: String(completion.totalBytes),
        endedAt: this.now()
      })
      // 终态中断不再保留分段文件;重试会换任务,留着只会成为孤儿磁盘垃圾。
      await this.options.store.deletePart(terminal)
      await this.persist(terminal, 'interrupted-terminal')
      await this.releaseActive(taskId)
      return
    }

    const verifying = await this.update(taskId, {
      state: 'verifying',
      message: '校验中',
      receivedBytes: String(completion.receivedBytes),
      totalBytes: String(completion.totalBytes)
    })
    await this.options.store.promotePart(verifying)
    await this.verify(taskId, active.resource, completion)
    await this.releaseActive(taskId)
  }

  private async verify(taskId: string, resource: DownloadResource, completion: Pick<DownloadCompletion, 'mimeType'>): Promise<void> {
    const controller = new AbortController()
    this.verifications.set(taskId, controller)
    try {
      await this.runVerification(taskId, resource, completion, controller.signal)
    } finally {
      if (this.verifications.get(taskId) === controller) this.verifications.delete(taskId)
    }
  }

  private async runVerification(taskId: string, resource: DownloadResource, completion: Pick<DownloadCompletion, 'mimeType'>, signal: AbortSignal): Promise<void> {
    const task = await this.requireTask(taskId)
    if (completion.mimeType.toLowerCase().includes('html')) {
      await this.fail(taskId, 'not-installer', '不是安装包')
      return
    }
    // 流式哈希:只过固定小缓冲,⛔ 把整个安装包读进内存再算。
    const digest = await this.options.store.hashArtifact(task)
    // 每个会写状态的落点前都要认一次取消:取消态已由 cancel 写好,
    // ⛔ 在它后面再盖一层 ready / 校验不符 / 不是安装包。
    if (signal.aborted) return
    if (digest === undefined) {
      await this.fail(taskId, 'integrity-mismatch', '校验不符')
      return
    }
    const localSha256 = digest.sha256
    let inspection: Awaited<ReturnType<DownloadArtifactInspector['inspect']>>
    try {
      inspection = await this.options.inspector.inspect({ artifactPath: task.artifactPath, format: resource.format ?? 'dmg', signal })
    } catch (error) {
      // 取消导致的中止不是判定结果,直接收手。
      if (signal.aborted) return
      // 超时同样不是判定结果:⛔ 说成「不是安装包」并把客户已经下好的包删掉。
      if (isVerifyTimeout(error)) { await this.failVerifyTimeout(taskId); return }
      await this.fail(taskId, 'not-installer', '不是安装包')
      return
    }
    if (signal.aborted) return
    if (inspection.kind !== 'installer') {
      await this.fail(taskId, 'not-installer', '不是安装包')
      return
    }
    // 三道闸合并重判,出三态。信任根是签名(Developer ID 全串 + Team ID);
    // 快照(sha256,字节数并入其中)只能判「变没变」⛔ 判「可不可信」。
    // ⇒ 先核身份:签名主体或 Team ID 对不上才是安全事件;签名一致但快照变了,
    // 是官方包已更新、我们的记录过期了——这是我们要收到的信号,⛔ 报「校验不符」。
    if (!matchesIdentity(resource, inspection.identity)) {
      await this.fail(taskId, 'identity-mismatch', '身份不符')
      return
    }
    const unchanged =
      localSha256 === resource.recordedSha256 || (resource.officialSha256 !== null && localSha256 === resource.officialSha256)
    if (!unchanged) {
      if (resource.identity === null || resource.identity === undefined) {
        // 没钉签名的条目没有信任根,快照对不上时我们什么都不能断定,保持原判。
        await this.fail(taskId, 'integrity-mismatch', resource.format === 'msix'
          ? '安装包与当前核准版本不一致，可能是官方更新或文件不完整。请使用官方安装助手，或复制问题信息给来信客服。'
          : '校验不符')
        return
      }
      await this.fail(
        taskId,
        'official-build-updated',
        '官方安装包已更新，当前记录需要更新。请复制问题信息给来信客服，确认后再试。',
        'failed-official-build-updated'
      )
      return
    }
    const ready = await this.update(taskId, {
      state: 'ready',
      reason: '',
      message: resource.officialSha256 === null ? '来源与文件核验通过，可以打开安装包' : '官方值一致',
      receivedBytes: String(digest.byteLength),
      totalBytes: String(digest.byteLength),
      localSha256,
      artifactSize: String(digest.byteLength),
      artifactMtimeMs: String(digest.mtimeMs),
      endedAt: this.now()
    })
    await this.persist(ready, 'ready')
  }

  /**
   * 清掉「校验超时」为重试保留、但客户已经不要了的安装包。
   * 保留是给 retry 走同 taskId 重新校验用的;客户改点重新下载(或改用本地文件)时,
   * 新任务有自己的目录,旧目录那份几百 MB 就再没人会碰 ⇒ 建新任务前清掉。
   * ⛔ 顺手清 ready / handed-off-install 的包——那些是客户还要拿来装的。
   */
  private async discardRetainedArtifacts(resourceId: string): Promise<void> {
    for (const task of await this.options.store.list()) {
      if (task.resourceId !== resourceId || task.state !== 'failed' || task.reason !== 'verify-timeout') continue
      await this.options.store.deleteArtifact(task)
      // 文案也要跟着改:包已经不在了,⛔ 还挂着「已下载的文件保留…不用重新下载」。
      await this.persist({
        ...task,
        reason: 'verify-timeout-discarded',
        message: '上次校验超时保留的安装包已清理，因为你选择了重新获取。',
        localSha256: ''
      }, 'verify-timeout-artifact-discarded')
    }
  }

  /** 校验超时专用终态:文件原样留着,重试只重新校验。⛔ 走 fail()——那会 deleteArtifact。 */
  private async failVerifyTimeout(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId)
    // 分段此时已提升成正式文件,deletePart 是空操作;⛔ deleteArtifact。
    await this.options.store.deletePart(task)
    const failed = await this.update(taskId, {
      state: 'failed',
      reason: 'verify-timeout',
      message: '安装包校验超时，已下载的文件保留。请点击重试，会直接重新校验，不用重新下载。',
      endedAt: this.now()
    })
    await this.persist(failed, 'failed-verify-timeout')
    await this.releaseActive(taskId)
  }

  private async fail(taskId: string, reason: string, message: string, eventResult = 'failed'): Promise<void> {
    const task = await this.requireTask(taskId)
    await this.options.store.deletePart(task)
    await this.options.store.deleteArtifact(task)
    const failed = await this.update(taskId, { state: 'failed', reason, message, endedAt: this.now() })
    await this.persist(failed, eventResult)
    await this.releaseActive(taskId)
  }

  /** 进度落盘节流:内存记最新值,每 ≥500ms 写一次;终态迁移自带落盘,不依赖这里。 */
  private recordProgress(taskId: string, receivedBytes: number, totalBytes: number): void {
    const entry = this.progressWrites.get(taskId) ?? { receivedBytes: '', totalBytes: '', dirty: false }
    entry.receivedBytes = String(receivedBytes)
    entry.totalBytes = String(totalBytes)
    entry.dirty = true
    if (entry.timer === undefined) {
      entry.timer = setTimeout(() => { entry.timer = undefined; void this.flushProgress(taskId) }, PROGRESS_PERSIST_INTERVAL_MS)
    }
    this.progressWrites.set(taskId, entry)
  }

  private async flushProgress(taskId: string): Promise<void> {
    const entry = this.progressWrites.get(taskId)
    if (entry === undefined || !entry.dirty || this.disposed) return
    entry.dirty = false
    const { receivedBytes, totalBytes } = entry
    await this.enqueueWrite(taskId, async () => {
      const task = await this.options.store.get(taskId)
      // 只在下载中回写进度;⛔ 把 verifying/ready 等状态用旧记录盖回去(E-7)。
      if (task === undefined || task.state !== 'downloading') return
      await this.options.store.save({ ...task, receivedBytes, totalBytes })
    }).catch(() => undefined)
  }

  private dropScheduledProgress(taskId: string): void {
    const entry = this.progressWrites.get(taskId)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.dirty = false
  }

  /** 同一任务的记录写入串行化:每个写操作排队重新读最新记录再改,⛔ 并发互相覆盖。 */
  private enqueueWrite<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.writeQueues.get(taskId) ?? Promise.resolve()
    const result = tail.then(operation, operation)
    const marker = result.catch(() => undefined)
    this.writeQueues.set(taskId, marker)
    void marker.then(() => {
      if (this.writeQueues.get(taskId) === marker) this.writeQueues.delete(taskId)
    })
    return result
  }

  private async releaseTransfer(transfer: DownloadTransfer): Promise<void> {
    try { await transfer.release?.() } catch { /* 引擎侧释放失败不任务失败 */ }
  }

  private async releaseActive(taskId: string): Promise<void> {
    this.dropScheduledProgress(taskId)
    const active = this.active.get(taskId)
    if (active === undefined) return
    this.active.delete(taskId)
    await this.releaseTransfer(active.transfer)
  }

  private createTask(resource: DownloadResource, state: DownloadState): StoredDownloadTask {
    const taskId = this.taskId()
    const paths = this.taskPaths(taskId, resource)
    return {
      taskId,
      resourceId: resource.id,
      authorizationId: '待接片2',
      state,
      reason: state === 'needs-tunnel' ? 'tunnel-not-connected' : '',
      message: state === 'needs-tunnel' ? '先接通道' : '下载中',
      receivedBytes: '0',
      totalBytes: resource.expectedBytes ?? '0',
      retryCount: '0',
      resumeEtag: '',
      resumeLastModified: '',
      localSha256: '',
      artifactPath: paths.artifactPath,
      partPath: paths.partPath,
      startedAt: this.now(),
      endedAt: '',
      artifactSize: '',
      artifactMtimeMs: ''
    }
  }

  private async update(taskId: string, changes: Partial<StoredDownloadTask>): Promise<StoredDownloadTask> {
    return this.enqueueWrite(taskId, async () => {
      const task = await this.requireTask(taskId)
      const updated = { ...task, ...changes }
      await this.options.store.save(updated)
      return updated
    })
  }

  private async persist(task: StoredDownloadTask, result: string): Promise<void> {
    await this.enqueueWrite(task.taskId, async () => {
      await this.options.store.save(task)
      await this.options.store.appendEvent({
        at: this.now(),
        authorizationId: task.authorizationId,
        software: this.requireResource(task.resourceId).software,
        version: this.requireResource(task.resourceId).version,
        result,
        bytes: task.receivedBytes,
        retryCount: task.retryCount
      })
    })
  }

  private async requireTask(taskId: string): Promise<StoredDownloadTask> {
    const task = await this.options.store.get(taskId)
    if (task === undefined) {
      throw new DownloadManagerError('DOWNLOAD_TASK_NOT_FOUND')
    }
    return task
  }

  private requireResource(resourceId: string): DownloadResource {
    const resource = this.resources.get(resourceId)
    if (resource === undefined) {
      throw new DownloadManagerError('DOWNLOAD_RESOURCE_NOT_FOUND')
    }
    return resource
  }

  private isAllowedUrlChain(urlChain: readonly string[], allowedHosts: readonly string[]): boolean {
    return urlChain.length > 0 && urlChain.every((value) => {
      try {
        return allowedHosts.includes(new URL(value).hostname)
      } catch {
        return false
      }
    })
  }
}

// 签名核验按 Developer ID 全串 + Team ID(目录条目钉死),⛔ 按组织名——实测签名主体是个人名,按组织名核会把正版包拒掉。
function matchesIdentity(resource: DownloadResource, identity: ArtifactIdentity | null): boolean {
  if (resource.identity === null || resource.identity === undefined) {
    return true
  }
  return (
    identity !== null &&
    identity.installerBundleIdentifier === resource.identity.installerBundleIdentifier &&
    identity.signingSubject === resource.identity.signingSubject &&
    identity.architecture === resource.identity.architecture
  )
}
