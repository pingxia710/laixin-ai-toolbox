import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MODULE_IDS = Array.from({ length: 12 }, (_, index) => `NET-${String(index + 1).padStart(2, '0')}`)
export const VALID_GRADES = new Set(['A', 'B', 'C', 'A+'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assert(condition, message) {
  if (!condition) throw new Error(`ABC_EVIDENCE_INVALID: ${message}`)
}

function validateLevel(level, moduleId, name) {
  assert(isRecord(level), `${moduleId}.${name} must be an object`)
  assert(typeof level.complete === 'boolean', `${moduleId}.${name}.complete must be boolean`)
  assert(Array.isArray(level.evidence), `${moduleId}.${name}.evidence must be an array`)
  assert(Array.isArray(level.missing), `${moduleId}.${name}.missing must be an array`)
  if (level.complete) assert(level.evidence.length > 0, `${moduleId}.${name} cannot be complete without evidence`)
}

export function validateEvidenceLedger(ledger) {
  assert(isRecord(ledger), 'ledger must be an object')
  assert(ledger.schemaVersion === 1, 'schemaVersion must be 1')
  assert(typeof ledger.version === 'string' && ledger.version.length > 0, 'version is required')
  assert(Array.isArray(ledger.modules), 'modules must be an array')
  assert(ledger.modules.length === MODULE_IDS.length, `modules must contain exactly ${MODULE_IDS.length} entries`)
  const ids = ledger.modules.map((module) => module?.id)
  assert(new Set(ids).size === ids.length, 'module ids must be unique')
  assert(JSON.stringify([...ids].sort()) === JSON.stringify(MODULE_IDS), 'module ids must be NET-01 through NET-12')
  for (const module of ledger.modules) {
    assert(isRecord(module), 'module entry must be an object')
    assert(typeof module.id === 'string', 'module id is required')
    for (const level of ['a', 'b', 'c', 'e5']) validateLevel(module[level], module.id, level)
    for (const [higher, lower] of [['b', 'a'], ['c', 'b'], ['e5', 'c']]) {
      assert(!module[higher].complete || module[lower].complete, `${module.id}.${higher} cannot be complete before ${lower}`)
    }
  }
  return ledger
}

export function gradeModule(module) {
  assert(isRecord(module), 'module must be an object')
  if (!module.a?.complete) return 'UNQUALIFIED'
  if (!module.b?.complete) return 'A'
  if (!module.c?.complete) return 'B'
  if (!module.e5?.complete) return 'C'
  return 'A+'
}

export function assessLedger(ledger) {
  validateEvidenceLedger(ledger)
  const modules = ledger.modules.map((module) => ({ id: module.id, grade: gradeModule(module) }))
  const counts = Object.fromEntries([...VALID_GRADES, 'UNQUALIFIED'].map((grade) => [grade, 0]))
  for (const module of modules) counts[module.grade] += 1
  return { version: ledger.version, modules, counts, aPlus: modules.every(({ grade }) => grade === 'A+') }
}

export async function readEvidenceLedger(path = resolve(process.cwd(), 'docs/abc-a-plus-evidence.json')) {
  const content = await readFile(path, 'utf8')
  return validateEvidenceLedger(JSON.parse(content))
}

function formatReport(report) {
  const lines = [`ABC grade report · ${report.version}`, ...report.modules.map(({ id, grade }) => `${id}: ${grade}`),
    `counts: ${Object.entries(report.counts).map(([grade, count]) => `${grade}=${count}`).join(' ')}`, `A+: ${report.aPlus ? 'YES' : 'NO'}`]
  return lines.join('\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const strict = process.argv.includes('--strict-a-plus')
  const json = process.argv.includes('--json')
  const pathArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  try {
    const report = assessLedger(await readEvidenceLedger(pathArg ? resolve(process.cwd(), pathArg) : undefined))
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`)
    if (strict && !report.aPlus) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
