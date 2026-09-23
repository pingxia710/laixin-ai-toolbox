import { supportDiagnosticAttemptLimit, type DiagnosticSoftware, type NetworkDiagnosticReport } from '../../network-diagnostics-types'
import type { FaultRecord } from '../../shared/fault-log-types'

export interface DiagnosticSessionReference {
  readonly id: string
  readonly software: DiagnosticSoftware
  readonly checkedAt: number
}

let latest: DiagnosticSessionReference | undefined

export interface DiagnosticRunSnapshot {
  readonly id: string
  readonly software: DiagnosticSoftware
  readonly text: string
  readonly collectedAt: string
  readonly errors: readonly string[]
  readonly faults: readonly FaultRecord[]
  readonly network: NetworkDiagnosticReport
  readonly attempts: readonly DiagnosticAttempt[]
  readonly attemptsTotal: number
  readonly attemptsComplete: boolean
}

export interface DiagnosticAttempt {
  readonly at: string
  readonly software: string
  readonly action: string
  readonly outcome: string
  readonly detail?: string
}

export function parseDiagnosticRunSnapshot(snapshot: string): DiagnosticRunSnapshot {
  const value = JSON.parse(snapshot) as DiagnosticRunSnapshot
  if (!value || !/^DG-[A-F0-9]{6}-[A-F0-9]{6}$/.test(value.id) ||
      !['codex', 'claude', 'hermes'].includes(value.software) || typeof value.text !== 'string' || value.text.length > 200_000 ||
      typeof value.collectedAt !== 'string' || !Array.isArray(value.errors) || value.errors.some((item) => typeof item !== 'string') ||
      !Array.isArray(value.faults) || !Array.isArray(value.attempts) || value.attempts.length > supportDiagnosticAttemptLimit || value.attempts.some((item) =>
        !item || !Number.isFinite(Date.parse(item.at)) || typeof item.software !== 'string' || item.software.length > 80 ||
        typeof item.action !== 'string' || item.action.length > 80 || typeof item.outcome !== 'string' || item.outcome.length > 80 ||
        (item.detail !== undefined && (typeof item.detail !== 'string' || item.detail.length > 160))) ||
      !Number.isSafeInteger(value.attemptsTotal) || value.attemptsTotal < value.attempts.length || value.attemptsTotal > 1_000 ||
      typeof value.attemptsComplete !== 'boolean' ||
      !value.network || value.network.software !== value.software || !Number.isSafeInteger(value.network.checkedAt)) {
    throw new Error('DIAGNOSTIC_SESSION_INVALID')
  }
  return value
}

export function rememberDiagnosticSession(session: DiagnosticSessionReference): void {
  latest = { ...session }
}

export function currentDiagnosticSession(): DiagnosticSessionReference | undefined {
  return latest && { ...latest }
}

export function forgetDiagnosticSession(id?: string): void {
  if (id === undefined || latest?.id === id) latest = undefined
}
