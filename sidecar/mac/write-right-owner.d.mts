/** 系统代理写入权的「持有者名片」：互斥体只回答能不能写，名片回答现在是谁在写。
 *  它是辅助信息，⛔ 用它判断对方死活——死活由 WAIT_ABANDONED 说了算。 */
export interface WriteRightOwner {
  pid?: number
  dataDir?: string
  version: string
  runId: string
  resident: boolean
  at?: number
  /** 本次持权令牌:名片与持有者这一轮写出的 state 靠它配对。 */
  token?: string
}

export declare function writeRightDir(platform?: string, env?: Record<string, string | undefined>): string
export declare function writeRightOwnerPath(platform?: string, env?: Record<string, string | undefined>): string
export declare function publishWriteRightOwner(info: Record<string, unknown>, path?: string): boolean
export declare function readWriteRightOwner(path?: string): WriteRightOwner | undefined
export declare function clearWriteRightOwner(pid?: number, path?: string): boolean

export declare function withWriteRight<T>(adapter: unknown, fn: () => T, log?: (line: string) => void):
  { ok: true; value: T } | { ok: false; reason: string }

export interface ResidentSelfHealOutcome {
  restored: number
  keptModified: number
  failed: unknown[]
  unrestored: number
  residentRemoved: boolean
  shouldExit: boolean
  settingsBusy: boolean
  reason: string
}

export declare function guardedResidentSelfHeal(
  adapter: unknown,
  run: () => ResidentSelfHealOutcome,
  log?: (line: string) => void
): ResidentSelfHealOutcome
