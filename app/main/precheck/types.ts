export type { Platform, SoftwareId } from './software-platform'

import type { Platform, SoftwareId } from './software-platform'
export type Architecture = 'arm64' | 'x86_64' | 'unknown'
export type SupportStatus = 'supported' | 'unsupported' | 'unknown'

// 安装身份表的证据等级(裁定:每条带证据等级):measured = 有一次真装记录做出处;unverified = 未核(当刻三条全是它)。
export type IdentityEvidence = 'measured' | 'unverified'

// 身份的形状按平台/来源判别(裁定 §6.1,照 collect-win.ts 的形态);证据等级与降级方向平台无关。
// ⛔ 另立一张 Windows 表(两套三态必然分叉);⛔ 把 Windows 形状塞进 bundleId(一个字段装两种东西)。
export type InstallationIdentityShape =
  | { readonly kind: 'mac-bundle'; readonly bundleId: string; readonly applicationName?: string }
  | { readonly kind: 'win-store'; readonly identity: string; readonly packageName: string }
  | {
      readonly kind: 'win-uninstall'
      readonly identity: string
      readonly registryKey: string
      readonly publisher: string
      readonly displayName: string
    }

export type Captured<T> =
  | { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: string }

export interface InstallationTrace {
  readonly bundleId: string
  readonly version: Captured<string>
  readonly path: string
  readonly mtimeMs: number
  // 匹配到的那条身份表记录的证据等级(任何形状都带);缺这个字段的痕迹一律按「未核」进三态。
  readonly identityEvidence?: IdentityEvidence
}

// 装在预期位置、但标识不在安装身份表里的应用(三态之「不知道②」的读数来源;读不到标识时 bundleId 为 undefined)。
export interface UnidentifiedApplication {
  readonly software: SoftwareId
  readonly bundleId: string | undefined
  readonly path: string
}

// 安装身份表的一条规则 = installationIdentityRules 注入源的单元:调用方按它做识别,⛔ 直接读支持表原始记录——证据等级才不会被读丢。
export interface InstallationIdentityRule {
  readonly software: SoftwareId
  readonly platform: Platform
  readonly architecture: SupportRecord['architecture']
  readonly identity: InstallationIdentityShape
  readonly identityEvidence: IdentityEvidence
  // measured 必有出处(怎么测的);没有出处,后人会照 Codex 的测法去「补」Hermes,把安装器标识当本体标识。
  readonly identityEvidenceSource: string | undefined
}

export interface ProxyServiceSettings {
  readonly service: string
  readonly web: boolean
  readonly secureWeb: boolean
  readonly socks: boolean
  readonly autoProxy: boolean
}

export interface ConnectivityResult {
  readonly reachable: boolean
  readonly reason?: string
}

export interface ConnectivityFacts {
  readonly domestic: ConnectivityResult
  readonly external: ConnectivityResult
}

export interface RequiredPermissions {
  readonly canReadWriteOwnDataDirectory: boolean
  readonly userRole: 'standard' | 'administrator' | 'unknown'
}

export interface ManagedEnvironment {
  readonly managed: boolean
  readonly policyNames: readonly string[]
}

export interface PrecheckFacts {
  readonly collectedAt: string
  readonly collectorVersion: string
  readonly platform: Platform
  readonly systemVersion: Captured<string>
  readonly architecture: Captured<Architecture>
  readonly memoryBytes: Captured<number>
  readonly availableDiskBytes: Captured<number>
  readonly installations: Captured<Readonly<Partial<Record<SoftwareId, InstallationTrace>>>>
  readonly unidentifiedApplications: Captured<readonly UnidentifiedApplication[]>
  readonly hermesCommand: Captured<boolean>
  readonly proxySettings: Captured<readonly ProxyServiceSettings[]>
  readonly requiredPermissions: Captured<RequiredPermissions>
  readonly managedEnvironment: Captured<ManagedEnvironment>
  readonly connectivity: ConnectivityFacts
}

export interface SupportRecord {
  readonly software: SoftwareId
  readonly platform: Platform
  readonly architecture: Exclude<Architecture, 'unknown'>
  readonly support: SupportStatus
  readonly open: boolean
  readonly approvedOn: string
  readonly identity: InstallationIdentityShape | undefined
  readonly identityEvidence: IdentityEvidence | undefined
  readonly identityEvidenceSource: string | undefined
  readonly evidence: string
}

export interface SupportMatrix {
  readonly version: string
  readonly approvedOn: string
  readonly records: readonly SupportRecord[]
}

export type DisplayKind = 'installable' | 'detected' | 'unverified' | 'unsupported' | 'later' | 'undetectable'

export interface SoftwareAssessment {
  readonly software: SoftwareId
  readonly support: SupportStatus
  readonly open: boolean
  readonly collectionStatus: 'available' | 'unavailable'
  readonly installation: InstallationTrace | undefined
  readonly hermesCommand: Captured<boolean> | undefined
  readonly displayKind: DisplayKind
  readonly displayLine: string
  readonly basis: string
}

export interface PrecheckReport {
  readonly state: 'complete'
  readonly collectedAt: string
  readonly collectorVersion: string
  readonly platform: Platform
  readonly architecture: Architecture | undefined
  readonly topNotice: string | undefined
  readonly software: readonly SoftwareAssessment[]
  readonly systemVersion: Captured<string>
  readonly memoryBytes: Captured<number>
  readonly availableDiskBytes: Captured<number>
  readonly requiredPermissions: Captured<RequiredPermissions>
  readonly managedEnvironment: Captured<ManagedEnvironment>
  readonly connectivity: ConnectivityFacts
}

export interface NotRunReport {
  readonly state: 'not-run'
}

export type StoredPrecheckReport = PrecheckReport | NotRunReport

export interface PrecheckBridgeResponse {
  readonly snapshot: string
}
