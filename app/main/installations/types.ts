// 逐屏安装引导已退役(创始人 2026-09-11 定:安装用官方原版,不做引导)。
// 引导走了,这几样还在用:DeepSeek 使用验证记录要记「哪台机上哪个软件的哪次安装」。
// ⛔ 把卡集、门、检测器那套类型图一并留下——它们只服务引导。
import { isPlatform } from '../precheck/software-platform'
import type { Platform, SoftwareId } from '../precheck/software-platform'

export type InstallSoftware = SoftwareId
type InstallPlatformFor<T extends Platform> = T extends `${infer Name}os` ? Name : T
/** 安装记录里的平台名沿用 mac/windows;片 2 的规范值 macos 只在读写边界映射,⛔ 让历史记录身份分裂。 */
export type InstallPlatform = InstallPlatformFor<Platform>

export interface InstallationIdentity {
  readonly bundleId: string
  readonly applicationPath: string
  readonly softwareVersion: string
}

export function isInstallPlatform(value: unknown): value is InstallPlatform {
  return typeof value === 'string' && (isPlatform(`${value}os`) || (isPlatform(value) && !value.endsWith('os')))
}

export interface InstallationRecord {
  readonly software: InstallSoftware
  readonly platform: InstallPlatform
  readonly recordedAt: string
  readonly identity: InstallationIdentity
}
