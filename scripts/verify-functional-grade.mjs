import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FUNCTIONAL_MODULE_IDS = Array.from({ length: 11 }, (_, index) => `NET-${String(index + 1).padStart(2, '0')}`)
export const FUNCTIONAL_GATE_NAMES = ['contract', 'normal', 'failure', 'recovery', 'customerOutcome', 'boundary']
export const VALID_GATE_STATUSES = new Set(['pass', 'partial', 'pending', 'fail'])
export const FUNCTIONAL_GRADES = new Set(['A+', 'A', 'B', 'UNQUALIFIED', 'DEFERRED'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assert(condition, message) {
  if (!condition) throw new Error(`FUNCTIONAL_EVIDENCE_INVALID: ${message}`)
}

function validateGate(gate, moduleId, name) {
  assert(isRecord(gate), `${moduleId}.${name} must be an object`)
  assert(VALID_GATE_STATUSES.has(gate.status), `${moduleId}.${name}.status is invalid`)
  assert(Array.isArray(gate.evidence), `${moduleId}.${name}.evidence must be an array`)
  assert(Array.isArray(gate.missing), `${moduleId}.${name}.missing must be an array`)
  if (gate.status === 'pass') assert(gate.evidence.length > 0, `${moduleId}.${name} cannot pass without evidence`)
  if (gate.status !== 'pass') assert(gate.missing.length > 0, `${moduleId}.${name} needs a missing reason`)
}

export function validateFunctionalLedger(ledger) {
  assert(isRecord(ledger), 'ledger must be an object')
  assert(ledger.schemaVersion === 1, 'schemaVersion must be 1')
  assert(ledger.scope === 'network-function', 'scope must be network-function')
  assert(typeof ledger.version === 'string' && ledger.version.length > 0, 'version is required')
  assert(typeof ledger.evaluatedCommit === 'string' && /^[0-9a-f]{40}$/i.test(ledger.evaluatedCommit), 'evaluatedCommit must be a commit SHA')
  assert(isRecord(ledger.productScope), 'productScope must be an object')
  assert(typeof ledger.productScope.audience === 'string' && ledger.productScope.audience.length > 0, 'productScope.audience is required')
  assert(typeof ledger.productScope.promise === 'string' && ledger.productScope.promise.length > 0, 'productScope.promise is required')
  assert(isRecord(ledger.productScope.anonymousTrial), 'productScope.anonymousTrial must be an object')
  assert(Number.isSafeInteger(ledger.productScope.anonymousTrial.quotaBytes) && ledger.productScope.anonymousTrial.quotaBytes > 0, 'anonymous trial quotaBytes is invalid')
  assert(Number.isSafeInteger(ledger.productScope.anonymousTrial.termHours) && ledger.productScope.anonymousTrial.termHours > 0, 'anonymous trial termHours is invalid')
  assert(typeof ledger.productScope.anonymousTrial.grant === 'string' && ledger.productScope.anonymousTrial.grant.length > 0, 'anonymous trial grant is required')
  assert(typeof ledger.productScope.anonymousTrial.deviceRule === 'string' && ledger.productScope.anonymousTrial.deviceRule.length > 0, 'anonymous trial deviceRule is required')
  assert(typeof ledger.productScope.anonymousTrial.nextState === 'string' && ledger.productScope.anonymousTrial.nextState.length > 0, 'anonymous trial nextState is required')
  assert(ledger.productScope.anonymousTrial.deferredTo === '0.8', 'anonymous trial must be deferred to 0.8')
  assert(Array.isArray(ledger.productScope.inScopeEnvironments), 'productScope.inScopeEnvironments must be an array')
  assert(Array.isArray(ledger.productScope.outOfScope), 'productScope.outOfScope must be an array')
  assert(typeof ledger.productScope.stabilityMonitoring === 'string' && ledger.productScope.stabilityMonitoring.length > 0, 'productScope.stabilityMonitoring is required')
  assert(Array.isArray(ledger.modules), 'modules must be an array')
  assert(ledger.modules.length === FUNCTIONAL_MODULE_IDS.length, `modules must contain exactly ${FUNCTIONAL_MODULE_IDS.length} entries`)
  const ids = ledger.modules.map((module) => module?.id)
  assert(new Set(ids).size === ids.length, 'module ids must be unique')
  assert(JSON.stringify([...ids].sort()) === JSON.stringify(FUNCTIONAL_MODULE_IDS), 'module ids must be NET-01 through NET-11')
  assert(Array.isArray(ledger.excluded), 'excluded must be an array')
  assert(ledger.excluded.some((entry) => entry?.id === 'NET-12'), 'NET-12 must be excluded from the functional grade')
  assert(Array.isArray(ledger.deferred), 'deferred must be an array')
  assert(ledger.deferred.some((entry) => entry?.id === 'NET-01' && entry?.targetVersion === '0.8'), 'NET-01 must be deferred to 0.8')
  assert(isRecord(ledger.operationalEvidence), 'operationalEvidence must be an object')
  assert(ledger.operationalEvidence.status === 'separate', 'operational evidence must remain separate')
  for (const module of ledger.modules) {
    assert(isRecord(module), 'module entry must be an object')
    assert(typeof module.id === 'string', 'module id is required')
    assert(['active', 'deferred'].includes(module.lifecycle), `${module.id}.lifecycle is invalid`)
    assert(typeof module.customerOutcome === 'string' && module.customerOutcome.length > 0, `${module.id}.customerOutcome is required`)
    assert(Array.isArray(module.scenarios) && module.scenarios.length > 0, `${module.id}.scenarios is required`)
    assert(isRecord(module.gates), `${module.id}.gates must be an object`)
    for (const gateName of FUNCTIONAL_GATE_NAMES) validateGate(module.gates[gateName], module.id, gateName)
    assert(Array.isArray(module.missing), `${module.id}.missing must be an array`)
    assert(Array.isArray(module.nextChecks), `${module.id}.nextChecks must be an array`)
  }
  return ledger
}

export function gradeFunctionalModule(module) {
  assert(isRecord(module), 'module must be an object')
  if (module.lifecycle === 'deferred') return 'DEFERRED'
  const gate = (name) => module.gates?.[name]?.status === 'pass'
  if (FUNCTIONAL_GATE_NAMES.every(gate)) return 'A+'
  if (['contract', 'normal', 'failure', 'recovery', 'customerOutcome'].every(gate)) return 'A'
  if (['contract', 'normal', 'failure'].every(gate)) return 'B'
  return 'UNQUALIFIED'
}

export function assessFunctionalLedger(ledger) {
  validateFunctionalLedger(ledger)
  const modules = ledger.modules.map((module) => ({ id: module.id, grade: gradeFunctionalModule(module) }))
  const counts = Object.fromEntries([...FUNCTIONAL_GRADES].map((grade) => [grade, 0]))
  for (const module of modules) counts[module.grade] += 1
  const activeModules = modules.filter(({ grade }) => grade !== 'DEFERRED')
  return {
    scope: ledger.scope,
    version: ledger.version,
    evaluatedCommit: ledger.evaluatedCommit,
    excluded: ledger.excluded,
    deferred: ledger.deferred,
    modules,
    counts,
    functionalAPlus: activeModules.filter(({ grade }) => grade === 'A+').length,
    functionalModuleCount: activeModules.length,
    deferredModuleCount: modules.length - activeModules.length,
    allFunctionalAPlus: activeModules.length > 0 && activeModules.every(({ grade }) => grade === 'A+')
  }
}

export async function readFunctionalLedger(path = resolve(process.cwd(), 'docs/functional-a-plus-evidence.json')) {
  const content = await readFile(path, 'utf8')
  return validateFunctionalLedger(JSON.parse(content))
}

function formatReport(report) {
  const lines = [
    `Functional grade report · ${report.version} · scope=${report.scope}`,
    ...report.modules.map(({ id, grade }) => `${id}: ${grade}`),
    `counts: ${Object.entries(report.counts).map(([grade, count]) => `${grade}=${count}`).join(' ')}`,
    `functional A+: ${report.functionalAPlus}/${report.functionalModuleCount}`,
    `deferred: ${report.deferredModuleCount}`,
    `NET-12: excluded (delivery evidence is separate)`,
    `all functional A+: ${report.allFunctionalAPlus ? 'YES' : 'NO'}`
  ]
  return lines.join('\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const strict = process.argv.includes('--strict-functional-a-plus')
  const json = process.argv.includes('--json')
  const pathArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  try {
    const report = assessFunctionalLedger(await readFunctionalLedger(pathArg ? resolve(process.cwd(), pathArg) : undefined))
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`)
    if (strict && !report.allFunctionalAPlus) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
