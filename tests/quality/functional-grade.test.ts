import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assessFunctionalLedger, gradeFunctionalModule, validateFunctionalLedger } from '../../scripts/verify-functional-grade.mjs'

const evidencePath = resolve(process.cwd(), 'docs/functional-a-plus-evidence.json')

it('功能账本只评估当前 0.7 功能，并把 NET-01 延期到 0.8、NET-12 交付证据排除', async () => {
  const ledger = validateFunctionalLedger(JSON.parse(await readFile(evidencePath, 'utf8')))
  const report = assessFunctionalLedger(ledger)
  expect(report.functionalModuleCount).toBe(10)
  expect(report.functionalAPlus).toBe(6)
  expect(report.deferredModuleCount).toBe(1)
  expect(report.counts).toMatchObject({ A: 4, 'A+': 6, B: 0, UNQUALIFIED: 0, DEFERRED: 1 })
  expect(report.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'NET-12' })]))
  expect(report.deferred).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'NET-01', targetVersion: '0.8' })]))
})

it('功能 A+ 要求六个功能关卡全部通过', async () => {
  const ledger = validateFunctionalLedger(JSON.parse(await readFile(evidencePath, 'utf8')))
  const module = ledger.modules.find(({ id }) => id === 'NET-04')!
  expect(gradeFunctionalModule(module)).toBe('A+')
  const partial = structuredClone(module)
  partial.gates.boundary = { status: 'partial', evidence: ['controlled'], missing: ['field boundary'] }
  expect(gradeFunctionalModule(partial)).toBe('A')
})

it('拒绝把 package 或 native 关卡混入功能账本', async () => {
  const ledger = JSON.parse(await readFile(evidencePath, 'utf8'))
  ledger.modules[0].gates.boundary.evidence.push('package-sha')
  expect(() => validateFunctionalLedger(ledger)).not.toThrow()
  expect(assessFunctionalLedger(ledger).functionalAPlus).toBe(6)
  expect(assessFunctionalLedger(ledger).excluded).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'NET-12' })]))
})

it('拒绝跳过功能关卡的伪通过', async () => {
  const ledger = JSON.parse(await readFile(evidencePath, 'utf8'))
  const active = ledger.modules.find((entry: { id: string }) => entry.id === 'NET-02')!
  active.gates.normal.status = 'pending'
  active.gates.normal.evidence = []
  active.gates.normal.missing = ['normal runtime']
  expect(gradeFunctionalModule(active)).toBe('UNQUALIFIED')
})

it('功能账本必须声明小白客户、匿名体验和范围边界', async () => {
  const ledger = JSON.parse(await readFile(evidencePath, 'utf8'))
  delete ledger.productScope.anonymousTrial.deviceRule
  expect(() => validateFunctionalLedger(ledger)).toThrow('anonymous trial deviceRule')
})
