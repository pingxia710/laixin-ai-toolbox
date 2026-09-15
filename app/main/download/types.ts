import type { Platform, SoftwareId } from '../precheck/software-platform'
import type { Architecture } from '../precheck/types'

export type DownloadResourceType = 'download' | 'external-entry'
export type DownloadFormat = 'dmg' | 'zip' | 'pkg' | 'exe' | 'msix'
export type DownloadArchitecture = Exclude<Architecture, 'unknown'>

export interface DownloadSource {
  readonly id: string
  readonly assetUrl: string
  readonly allowedHosts: readonly string[]
  readonly network: 'direct' | 'tunnel'
}

export interface ResourceApproval {
  readonly approvedAt: string
  readonly approvedBy: string
  readonly sourceBuild: string
  // 核准语义写死:核准的是这一次下载的那个包,⛔ 它装出来的版本(stub 总装最新,版本钉不住)。
  readonly scope: string
}

// 目录条目的身份 = 两种语义两个字段,⛔ 同名混装:
// installerBundleIdentifier = dmg 内那个应用(= 安装器)的标识,下载核验只核它 + 签名;
// installedBundleIdentifier = 装好之后 /Applications 里那个应用的标识,当刻 null = 未核(真机实测后回填,接支持表三态)。
// ⛔ 拿 installerBundleIdentifier 去核安装结果——它永远不会匹配装好的应用。
export interface ExpectedIdentity {
  readonly installerBundleIdentifier: string
  readonly installedBundleIdentifier: string | null
  readonly signingSubject: string
  readonly architecture: DownloadArchitecture
  // 钉死:厂商换签名证书时我们会拒掉正版包——此条需要有人维护(换证书后实测并更新条目)。
  readonly maintenanceNote?: string
}

export interface DownloadResource {
  readonly id: string
  readonly software: SoftwareId
  readonly platform: Platform
  readonly architecture: DownloadArchitecture
  readonly type: DownloadResourceType
  readonly officialPageUrl: string
  readonly assetUrl?: string
  // Every source supplies the same approved version and artifact identity.
  readonly sources?: readonly DownloadSource[]
  readonly allowedHosts: readonly string[]
  readonly version: string
  readonly officialVersionLabel: string
  readonly format?: DownloadFormat
  readonly expectedBytes?: string
  readonly officialSha256?: string | null
  readonly recordedSha256?: string
  readonly identity?: ExpectedIdentity | null
  readonly approval: ResourceApproval
}

export interface DownloadCatalog {
  readonly catalogVersion: string
  readonly resources: readonly DownloadResource[]
}

export type DownloadState =
  | 'not-downloaded'
  | 'needs-tunnel'
  | 'downloading'
  | 'interrupted-resumable'
  | 'interrupted-terminal'
  | 'cancelled'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'handed-off-install'

export interface StoredDownloadTask {
  readonly taskId: string
  readonly resourceId: string
  readonly authorizationId: string
  readonly state: DownloadState
  readonly reason: string
  readonly message: string
  readonly receivedBytes: string
  readonly totalBytes: string
  readonly retryCount: string
  readonly resumeEtag: string
  readonly resumeLastModified: string
  readonly localSha256: string
  readonly artifactPath: string
  readonly partPath: string
  readonly startedAt: string
  readonly endedAt: string
  // 核验通过时记录的文件体积与 mtime;启动恢复据此跳过大安装包重哈希。
  readonly artifactSize?: string
  readonly artifactMtimeMs?: string
}

export type DownloadTaskSnapshot = StoredDownloadTask

/** 流式计算的安装包摘要;⛔ 把大安装包整读进内存。 */
export interface ArtifactDigest {
  readonly byteLength: number
  readonly sha256: string
  readonly mtimeMs: number
}

export interface DownloadTaskStore {
  save(task: StoredDownloadTask): Promise<void>
  get(taskId: string): Promise<StoredDownloadTask | undefined>
  list(): Promise<StoredDownloadTask[]>
  appendEvent(event: Record<string, string>): Promise<void>
  promotePart(task: StoredDownloadTask): Promise<void>
  deletePart(task: StoredDownloadTask): Promise<void>
  deleteArtifact(task: StoredDownloadTask): Promise<void>
  artifactStatus(task: StoredDownloadTask): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>
  hashArtifact(task: StoredDownloadTask): Promise<ArtifactDigest | undefined>
}

export interface TunnelSnapshot {
  readonly state: 'connected' | 'stopped'
  readonly localProxyUrl: string | undefined
}

export interface ArtifactIdentity {
  readonly installerBundleIdentifier: string
  readonly signingSubject: string
  readonly architecture: string
}

// 校验子进程超时的受控码。超时是「判不出来」,⛔ 与「判定不是安装包 / 校验不通过」混为一谈——
// 后者会删掉已核验失败的文件让客户重下(Codex 的 dmg 约 640MB),而超时时文件多半好端端的。
export const DOWNLOAD_VERIFY_TIMEOUT = 'DOWNLOAD_VERIFY_TIMEOUT'

export function isVerifyTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === DOWNLOAD_VERIFY_TIMEOUT
}

export interface DownloadArtifactInspector {
  // signal:校验期取消时用它杀掉在跑的子进程(hdiutil / codesign / PlistBuddy)。
  // ⛔ 无取消通道——客户会永远停在「校验中」,界面上没有任何按钮能退出。
  inspect(input: { readonly artifactPath: string; readonly format: DownloadFormat; readonly signal?: AbortSignal }): Promise<{
    readonly kind: 'installer' | 'not-installer'
    readonly identity: ArtifactIdentity | null
  }>
}
