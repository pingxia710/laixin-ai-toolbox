export type FunctionalGateStatus = 'pass' | 'partial' | 'pending' | 'fail'
export type FunctionalGrade = 'A+' | 'A' | 'B' | 'UNQUALIFIED' | 'DEFERRED'

export interface FunctionalGate {
  status: FunctionalGateStatus
  evidence: string[]
  missing: string[]
}

export interface FunctionalModule {
  id: string
  lifecycle: 'active' | 'deferred'
  customerOutcome: string
  scenarios: string[]
  gates: Record<'contract' | 'normal' | 'failure' | 'recovery' | 'customerOutcome' | 'boundary', FunctionalGate>
  missing: string[]
  nextChecks: string[]
}

export interface FunctionalProductScope {
  audience: string
  promise: string
  anonymousTrial: {
    quotaBytes: number
    termHours: number
    grant: string
    deviceRule: string
    nextState: string
    deferredTo: '0.8'
  }
  inScopeEnvironments: string[]
  outOfScope: string[]
  stabilityMonitoring: string
}

export interface FunctionalLedger {
  schemaVersion: 1
  scope: 'network-function'
  version: string
  evaluatedCommit: string
  productScope: FunctionalProductScope
  operationalEvidence: { status: 'separate'; reason: string }
  excluded: Array<{ id: string; reason: string; separateLedger?: string }>
  deferred: Array<{ id: string; targetVersion: '0.8'; reason: string }>
  modules: FunctionalModule[]
}

export interface FunctionalReport {
  scope: 'network-function'
  version: string
  evaluatedCommit: string
  excluded: FunctionalLedger['excluded']
  deferred: FunctionalLedger['deferred']
  modules: Array<{ id: string; grade: FunctionalGrade }>
  counts: Record<FunctionalGrade, number>
  functionalAPlus: number
  functionalModuleCount: number
  deferredModuleCount: number
  allFunctionalAPlus: boolean
}

export function validateFunctionalLedger(ledger: unknown): FunctionalLedger
export function gradeFunctionalModule(module: FunctionalModule): FunctionalGrade
export function assessFunctionalLedger(ledger: FunctionalLedger): FunctionalReport
export function readFunctionalLedger(path?: string): Promise<FunctionalLedger>
