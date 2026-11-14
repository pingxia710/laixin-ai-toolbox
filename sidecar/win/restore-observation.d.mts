export interface RestoreObservation {
  readonly phase: 'checking' | 'waiting' | 'complete' | 'blocked'
  readonly result: 'unconfirmed' | 'restored' | 'preserved' | 'mixed' | 'not-needed'
  readonly attempts: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly nextRetryAt: number
  readonly lastFailureCode: string
}
export declare const RESTORE_REASONS: Readonly<Record<string, string>>
export declare function safeRestoreReason(code: unknown): string
export declare function readRestoreObservation(value: unknown): RestoreObservation | undefined
export declare function restoreObservationActive(value: unknown, now?: number): boolean
export declare function restoreObservationText(value: unknown, now?: number, activeAllowed?: boolean): string
