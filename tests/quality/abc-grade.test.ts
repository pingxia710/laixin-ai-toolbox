import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assessLedger, gradeModule, validateEvidenceLedger } from '../../scripts/verify-abc-grade.mjs'

const evidencePath = resolve(process.cwd(), 'docs/abc-a-plus-evidence.json')

it('当前 0.7.4 账本包含十二个模块，并如实停在 B 层', async () => {
  const ledger = validateEvidenceLedger(JSON.parse(await readFile(evidencePath, 'utf8')))
  const report = assessLedger(ledger)
  expect(report.modules).toHaveLength(12)
  expect(report.counts).toMatchObject({ A: 0, B: 12, C: 0, 'A+': 0, UNQUALIFIED: 0 })
  expect(report.aPlus).toBe(false)
})

it('等级按累积证据逐级推进，缺少 E4/E5 不得报 A+', () => {
  const base = {
    a: { complete: true, evidence: ['a'], missing: [] },
    b: { complete: true, evidence: ['b'], missing: [] },
    c: { complete: false, evidence: [], missing: ['native'] },
    e5: { complete: false, evidence: [], missing: ['customer'] }
  }
  expect(gradeModule(base)).toBe('B')
  expect(gradeModule({ ...base, c: { complete: true, evidence: ['c'], missing: [] } })).toBe('C')
  expect(gradeModule({ ...base, c: { complete: true, evidence: ['c'], missing: [] }, e5: { complete: true, evidence: ['e5'], missing: [] } })).toBe('A+')
})

it('拒绝缺少证据的伪完成账本', () => {
  const module = {
    id: 'NET-01', a: { complete: true, evidence: [], missing: [] }, b: { complete: true, evidence: ['b'], missing: [] },
    c: { complete: false, evidence: [], missing: ['native'] }, e5: { complete: false, evidence: [], missing: ['customer'] }
  }
  expect(() => validateEvidenceLedger({ schemaVersion: 1, version: '0.7.4', modules: Array.from({ length: 12 }, (_, index) => ({ ...module, id: `NET-${String(index + 1).padStart(2, '0')}` })) })).toThrow('ABC_EVIDENCE_INVALID')
})

it('拒绝跳过前置层级的矛盾账本', () => {
  const module = {
    id: 'NET-01',
    a: { complete: true, evidence: ['a'], missing: [] },
    b: { complete: false, evidence: [], missing: ['package'] },
    c: { complete: true, evidence: ['c'], missing: [] },
    e5: { complete: true, evidence: ['e5'], missing: [] }
  }
  expect(() => validateEvidenceLedger({ schemaVersion: 1, version: '0.7.4', modules: Array.from({ length: 12 }, (_, index) => ({ ...module, id: `NET-${String(index + 1).padStart(2, '0')}` })) })).toThrow('cannot be complete before')
})
