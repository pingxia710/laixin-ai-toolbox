import type { Platform } from '../precheck/software-platform'
import type { Architecture } from '../precheck/types'

// RETIRE01/03:下载引擎与任务存储已退役,目录只承载 external-entry;本文件只剩安装入口目录类型。
export type DownloadArchitecture = Exclude<Architecture, 'unknown'>

export interface ResourceApproval {
  readonly approvedAt: string
  readonly approvedBy: string
  readonly sourceBuild: string
  // 核准语义写死:核准的是这一次下载的那个包,⛔ 它装出来的版本(stub 总装最新,版本钉不住)。
  readonly scope: string
}

export interface DownloadResource {
  readonly id: string
  readonly software: string
  readonly platform: Platform
  readonly architecture: DownloadArchitecture
  readonly type: 'external-entry'
  readonly officialPageUrl: string
  readonly allowedHosts: readonly string[]
  readonly version: string
  readonly officialVersionLabel: string
  readonly approval: ResourceApproval
}

export interface DownloadCatalog {
  readonly catalogVersion: string
  readonly resources: readonly DownloadResource[]
}
