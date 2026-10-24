import type { SettingsAdapter } from './restore.d.mts'

export declare const RESIDENT_LABEL: string
export declare function macAgentPath(home?: string, label?: string): string
export declare function residentBinaryMissing(execPath: string | undefined, exists?: (path: string) => boolean): boolean

export interface ResidentIntegrityReading {
  /** 连续探不到的次数已到宽限上限 = 可以认定「程序被删了」。 */
  readonly missing: boolean
  readonly misses: number
  readonly absent: string[]
}

export interface ResidentIntegrityCheck {
  check(): ResidentIntegrityReading
  reset(): void
  readonly misses: number
}

export declare function createResidentIntegrityCheck(options: {
  paths: readonly string[] | string
  /** 连续多少次探不到才算数（默认 3）。与调用方的轮询间隔相乘 = 宽限时长。 */
  threshold?: number
  exists?: (path: string) => boolean
}): ResidentIntegrityCheck

export interface ResidentRemoval {
  readonly removed: boolean
  readonly reason: string
}

export declare function removeResident(options?: {
  label?: string
  home?: string
  platform?: NodeJS.Platform | string
  run?: (file: string, args: readonly string[]) => unknown
}): ResidentRemoval

export interface ResidentSelfHealOutcome {
  readonly restored: number
  readonly keptModified: number
  readonly failed: string[]
  readonly unrestored: number
  readonly residentRemoved: boolean
  /** true = 已还干净并卸掉常驻，调用方可以 process.exit(0)；false = 留在原地下一轮再试。 */
  readonly shouldExit: boolean
  readonly settingsBusy: boolean
  readonly reason: string
}

export declare function runResidentSelfHeal(options: {
  dataDir: string
  adapter: SettingsAdapter
  label?: string
  home?: string
  platform?: NodeJS.Platform | string
  run?: (file: string, args: readonly string[]) => unknown
  /** 取跨进程设置锁的等待上限（默认 20 秒）。等不到照实回报 settingsBusy，由调用方下一轮再试。 */
  lockTimeoutMs?: number
  log?: (line: string) => void
}): ResidentSelfHealOutcome
