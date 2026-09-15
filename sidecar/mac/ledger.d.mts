export declare const ENTRY_STATUS: {
  readonly applied: 'applied'
  readonly restored: 'restored'
  readonly preserved: 'preserved'
  readonly keptModified: 'kept-modified'
  readonly restoreFailed: 'restore-failed'
}

export type EntryStatus = (typeof ENTRY_STATUS)[keyof typeof ENTRY_STATUS]
export declare function isSettledSetting(entry: { status?: unknown }): boolean

export interface SettingEntry {
  readonly id: string
  readonly kind: 'setting'
  readonly service: string
  readonly item: string
  readonly originalValue: unknown
  readonly writtenValue: unknown
  readonly sessionToken: string
  readonly time: number
  readonly status: EntryStatus
  readonly note: string
}

export interface IntentEntry {
  readonly id: string
  readonly kind: 'intent'
  readonly intent: 'connected' | 'user-disconnected' | 'shutdown'
  readonly time: number
}

export type LedgerEntry = SettingEntry | IntentEntry

export declare function ledgerPath(dataDir: string): string
/** 跨进程设置锁:恢复设置、应用设置、账本读改写、状态交接不能跨进程重叠。同进程可重入;持有者进程已死自动破锁;等不到抛 SettingsBusyError。 */
export declare function withSettingsLock<T>(dataDir: string, fn: () => T, options?: { owner?: string; timeoutMs?: number }): T
export declare function settingsLockPath(dataDir: string): string
export declare function holdsSettingsLock(dataDir: string): boolean
/** 进程还在不在:kill(pid,0) 探一下。EPERM = 在但不归我们管,同样算在。非整数/非正数一律 false。 */
export declare function processAlive(pid: unknown): boolean
/** 读锁文件:{ holder, ino };不存在 undefined;内容读不出时 holder 为 undefined。 */
export declare function readSettingsLock(dataDir: string): { holder: { token?: string; pid?: number; owner?: string; at?: number } | undefined; ino: number } | undefined
/** 破遗留锁:原子挪走后核对(令牌 + inode)是不是当初观察到的那把;不是就硬链接还回去并返回 false。 */
export declare function takeOverStaleLock(dataDir: string, observed: ReturnType<typeof readSettingsLock>): boolean
/** 持锁方自检:锁文件仍是自己的(令牌 + inode),否则抛 SettingsLockLostError;不在锁内不检查。 */
export declare function assertSettingsLockHeld(dataDir: string): void
export declare class SettingsBusyError extends Error {
  readonly code: 'SETTINGS_LOCK_BUSY' | 'SETTINGS_LOCK_LOST'
  readonly holder: unknown
}
export declare class SettingsLockLostError extends SettingsBusyError {}
export declare function updateSettingEntry(
  dataDir: string,
  entryId: string,
  patch: { originalValue: unknown; writtenValue?: unknown; time?: number }
): SettingEntry | undefined
export declare function generateSessionToken(now?: () => number): string
export declare function loadLedger(dataDir: string): LedgerEntry[]
export declare function readRecoveryMarker(dataDir: string): string | undefined
export declare function clearRecoveryMarker(dataDir: string): void
// 审计 R1:隔离账本分两档——完整条目原样保留,存疑条目(缺字段但 service/item/originalValue 齐全)一并保留;
// droppedSettings 是损坏到无法识别的设置类条目数,大于 0 时恢复流程不得清标记。
export declare function loadQuarantinedEntries(
  dataDir: string,
  badName: string
): { entries: Array<Record<string, unknown>>; droppedSettings: number } | undefined
export declare function isIntactLedgerEntry(entry: unknown): boolean
export declare class LedgerError extends Error {
  readonly code: string
  constructor(code?: string)
}
export declare function ledgerFailure(dataDir: string): { code: string; message: string } | undefined
export declare const LEDGER_ENTRY_LIMIT: number
export declare function ledgerDiskReads(): number
export declare function loadLedgerCached(dataDir: string): LedgerEntry[]
export declare function ledgerFailureCached(dataDir: string): { code: string; message: string } | undefined
export declare function lastIntentCached(dataDir: string): 'connected' | 'user-disconnected' | 'shutdown' | undefined
export declare function saveLedger(dataDir: string, entries: LedgerEntry[]): void
export declare function appendSettingEntry(
  dataDir: string,
  input: {
    service: string
    item: string
    originalValue: unknown
    writtenValue: unknown
    sessionToken: string
    time: number
  }
): SettingEntry
export declare function appendIntentEntry(
  dataDir: string,
  input: { intent: 'connected' | 'user-disconnected' | 'shutdown'; time: number }
): void
export declare function lastIntent(dataDir: string): 'connected' | 'user-disconnected' | 'shutdown' | undefined
export declare function markEntry(
  dataDir: string,
  entryId: string,
  input: { status: EntryStatus; note?: string }
): LedgerEntry
export declare function pendingSettingEntries(dataDir: string): SettingEntry[]
export declare const OPTIONAL_SETTING_SERVICES: ReadonlySet<string>
export declare function isOptionalSettingService(service: string): boolean
