import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NATIVE_CASE_IDS = ['U-01', 'U-02', 'U-03', 'U-04']
export const NATIVE_STATUSES = new Set(['pending', 'passed', 'safe-failure', 'failed'])
export const NATIVE_CHECKS = [
  'installDirectoryRemoved',
  'uninstallRegistryRemoved',
  'productTasksRemoved',
  'startMenuRemoved',
  'proxyEnvironmentRestored',
  'port18080Closed',
  'roamingRetained'
]

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function assert(condition, message) { if (!condition) throw new Error(`NATIVE_EVIDENCE_INVALID: ${message}`) }

export function validateNativeEvidence(record) {
  assert(isRecord(record), 'record must be an object')
  assert(record.schemaVersion === 1, 'schemaVersion must be 1')
  assert(record.version === '0.7.4', 'version must be 0.7.4')
  assert(isRecord(record.package), 'package is required')
  assert(typeof record.package.windowsSha256 === 'string' && /^[0-9a-f]{64}$/i.test(record.package.windowsSha256), 'package.windowsSha256 must be a SHA-256')
  assert(Array.isArray(record.cases), 'cases must be an array')
  assert(record.cases.length === NATIVE_CASE_IDS.length, `cases must contain exactly ${NATIVE_CASE_IDS.length} entries`)
  const ids = record.cases.map((item) => item?.id)
  assert(JSON.stringify(ids) === JSON.stringify(NATIVE_CASE_IDS), 'cases must be ordered U-01 through U-04')
  for (const item of record.cases) {
    assert(isRecord(item), 'case must be an object')
    assert(item.network === 'connected' || item.network === 'disconnected', `${item.id}.network is invalid`)
    assert(item.app === 'open' || item.app === 'exited', `${item.id}.app is invalid`)
    assert(NATIVE_STATUSES.has(item.status), `${item.id}.status is invalid`)
    assert(Array.isArray(item.evidence), `${item.id}.evidence must be an array`)
    if (item.status === 'pending') {
      assert(item.evidence.length === 0, `${item.id} pending case cannot claim evidence`)
      continue
    }
    assert(item.evidence.length > 0, `${item.id} completed case requires evidence`)
    assert(item.packageSha256 === record.package.windowsSha256, `${item.id} package hash must match the package section`)
    if (item.status === 'passed') {
      assert(isRecord(item.checks), `${item.id}.checks is required for passed cases`)
      for (const key of NATIVE_CHECKS) assert(item.checks[key] === true, `${item.id}.checks.${key} must be true`)
    } else {
      assert(typeof item.failureCode === 'string' && item.failureCode.length > 0, `${item.id}.failureCode is required for ${item.status}`)
    }
  }
  return record
}

export function assessNativeEvidence(record) {
  validateNativeEvidence(record)
  const counts = Object.fromEntries([...NATIVE_STATUSES].map((status) => [status, 0]))
  for (const item of record.cases) counts[item.status]++
  return { version: record.version, counts, c: record.cases.every((item) => item.status === 'passed') }
}

export async function readNativeEvidence(path = resolve(process.cwd(), 'docs/0.7.4-native-evidence.json')) {
  return validateNativeEvidence(JSON.parse(await readFile(path, 'utf8')))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const strict = process.argv.includes('--strict-c')
  const pathArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  try {
    const report = assessNativeEvidence(await readNativeEvidence(pathArg ? resolve(process.cwd(), pathArg) : undefined))
    process.stdout.write(`native evidence · ${report.version} · C=${report.c ? 'YES' : 'NO'} · ${Object.entries(report.counts).map(([status, count]) => `${status}=${count}`).join(' ')}\n`)
    if (strict && !report.c) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
