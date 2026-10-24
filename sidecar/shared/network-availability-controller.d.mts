export type AvailabilityAction = 'inspect' | 'reuse' | 'takeover' | 'reclaim' | 'restore'

export interface AvailabilityIntent {
  readonly id: string
  readonly generation: number
}

export interface AvailabilityIdentity {
  readonly id: string
  readonly kind?: string
  readonly target?: string
}

export interface AvailabilityOperation {
  readonly blocked?: false
  readonly id: string
  readonly action: AvailabilityAction
  readonly intent: AvailabilityIntent
  readonly conflict: AvailabilityIdentity
  readonly path: AvailabilityIdentity
  readonly snapshot?: { readonly id: string; readonly value: unknown }
  readonly lease?: { readonly id: string; readonly owner?: string; readonly expiresAt?: number }
  readonly writes: number
  readonly writtenValue?: unknown
  cancelled: boolean
  written: boolean
  recoveryCause?: string
}

export interface AvailabilityState {
  readonly status: string
  readonly intentGeneration: number
  readonly action?: AvailabilityAction
  readonly code?: string
  readonly lastAction?: { readonly action: AvailabilityAction; readonly writes: number }
}

export declare const AVAILABILITY_ACTIONS: readonly AvailabilityAction[]
export declare const AVAILABILITY_STATUSES: readonly string[]

export declare class NetworkAvailabilityController {
  constructor(options?: { now?: () => number; maxReclaims?: number })
  readonly state: AvailabilityState
  beginIntent(input: { id: string }): AvailabilityIntent
  isCurrent(operation: AvailabilityOperation | undefined): boolean
  start(input: {
    intent: AvailabilityIntent
    action: AvailabilityAction
    conflict: AvailabilityIdentity
    path: AvailabilityIdentity
    snapshot?: { id: string; value: unknown }
    lease?: { id: string; owner?: string; expiresAt?: number }
    writtenValue?: unknown
    restriction?: string
  }): AvailabilityOperation | { blocked: true; status: 'limited'; action: AvailabilityAction; code: string }
  markWritten(operation: AvailabilityOperation): boolean
  fail(operation: AvailabilityOperation, code: string): { ok: boolean; status: string; code?: string }
  complete(operation: AvailabilityOperation, input: { readbackMatches: boolean; targetReachable: boolean; conflict: AvailabilityIdentity; path: AvailabilityIdentity }): { ok: boolean; status: string; code?: string }
  cancel(operation: AvailabilityOperation, stage: string): { ok: boolean; status: string; code?: string }
  recover(operation: AvailabilityOperation, input: { currentValue: unknown; readbackMatches: boolean }): { ok: boolean; status: string; code?: string; preservedExternal?: boolean; restoreValue?: unknown }
  finishRecovery(operation: AvailabilityOperation, input: { readbackMatches: boolean; preservedExternal?: boolean }): { ok: boolean; status: string; code?: string }
}
