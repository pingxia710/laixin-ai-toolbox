export interface NativeCase {
  id: string
  network: 'connected' | 'disconnected'
  app: 'open' | 'exited'
  status: 'pending' | 'passed' | 'safe-failure' | 'failed'
  evidence: string[]
  packageSha256?: string
  failureCode?: string
  checks?: Record<string, boolean>
}
export interface NativeEvidence { schemaVersion: 1; version: '0.7.4'; package: { windowsSha256: string }; cases: NativeCase[] }
export interface NativeReport { version: '0.7.4'; counts: Record<string, number>; c: boolean }
export function validateNativeEvidence(record: unknown): NativeEvidence
export function assessNativeEvidence(record: NativeEvidence): NativeReport
export function readNativeEvidence(path?: string): Promise<NativeEvidence>
