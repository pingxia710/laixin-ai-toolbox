export interface EvidenceLevel { complete: boolean; evidence: string[]; missing: string[] }
export interface EvidenceModule { id: string; a: EvidenceLevel; b: EvidenceLevel; c: EvidenceLevel; e5: EvidenceLevel }
export interface EvidenceLedger { schemaVersion: 1; version: string; modules: EvidenceModule[] }
export interface GradeReport { version: string; modules: Array<{ id: string; grade: string }>; counts: Record<string, number>; aPlus: boolean }
export function validateEvidenceLedger(ledger: unknown): EvidenceLedger
export function gradeModule(module: Omit<EvidenceModule, 'id'>): string
export function assessLedger(ledger: EvidenceLedger): GradeReport
export function readEvidenceLedger(path?: string): Promise<EvidenceLedger>
