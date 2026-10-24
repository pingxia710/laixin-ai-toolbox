import type { EntryStatus, SettingEntry } from './ledger.d.mts'

export interface RestoreResult {
  readonly reasonCodes?: string[]
  readonly restored: SettingEntry[]
  readonly keptModified: SettingEntry[]
  readonly failed: SettingEntry[]
  /** 注册表已写回但系统变更通知没送达(已开着的软件可能要重开);⛔ 当恢复失败。 */
  notifyFailed?: boolean
}

export interface SettingsAdapter {
  valuesEqual?(left: unknown, right: unknown, ref?: { service: string; item: string }): boolean
  identifyPortOwner?(port: number | undefined, options?: { fresh?: boolean }): { kind: string; pid?: number; name?: string; reason?: string } | undefined
  preserveExternalChanges?(ref: { service: string; item: string }): boolean
  restoredValueMatches?(current: unknown, originalValue: unknown, writtenValue: unknown): boolean
  broadcastSettingsChanged?(): void
  read(itemRef: { service: string; item: string }): unknown
  write(itemRef: { service: string; item: string }, value: unknown): void
}

export interface RecoveryResult {
  recovered: SettingEntry[]
  keptModified: SettingEntry[]
  failed: string[]
  diagnostics: string | undefined
}

export interface RestoreOptions {
  readonly knownOwnPorts?: readonly number[]
}

export declare function ownPortSet(explicit?: readonly number[]): Set<number>
export declare function recoverLedger(dataDir: string, adapter: SettingsAdapter, options?: RestoreOptions): RecoveryResult | undefined
export declare function restoreLedger(dataDir: string, adapter: SettingsAdapter, options?: RestoreOptions): RestoreResult
export declare function rebroadcastSettings(dataDir: string, adapter: SettingsAdapter): boolean
export declare function notifyOwed(dataDir: string): boolean
export declare function markNotifyOwed(dataDir: string, owed: boolean): void
export declare function notifyPendingPath(dataDir: string): string
export declare function unrestoredEntries(dataDir: string): SettingEntry[]
export declare function unrestoredEntriesCached(dataDir: string): SettingEntry[]
export declare function deepEqual(left: unknown, right: unknown): boolean
export type { EntryStatus, SettingEntry }
