import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assessNativeEvidence, validateNativeEvidence } from '../../scripts/verify-native-evidence.mjs'
import type { NativeCase, NativeEvidence } from '../../scripts/verify-native-evidence.mjs'

const base = JSON.parse(readFileSync(new URL('../../docs/0.7.4-native-evidence.json', import.meta.url), 'utf8')) as NativeEvidence

function passedCase(item: NativeCase, checks: Record<string, boolean>): NativeCase {
  return { ...item, status: 'passed', packageSha256: base.package.windowsSha256, evidence: ['native-log'], checks }
}

describe('0.7.4 native evidence gate', () => {
  it('keeps the pending four-case matrix at C=NO', () => {
    expect(assessNativeEvidence(base)).toMatchObject({ c: false, counts: { pending: 4, passed: 0 } })
  })

  it('requires every post-test check before a case can pass', () => {
    const record = structuredClone(base)
    record.cases = record.cases.map((item) => passedCase(item, {}))
    expect(() => validateNativeEvidence(record)).toThrow('checks.installDirectoryRemoved')
  })

  it('recognizes C only when all four cases pass with the tested package hash', () => {
    const record = structuredClone(base)
    const checks = {
      installDirectoryRemoved: true, uninstallRegistryRemoved: true, productTasksRemoved: true, startMenuRemoved: true,
      proxyEnvironmentRestored: true, port18080Closed: true, roamingRetained: true
    }
    record.cases = record.cases.map((item) => passedCase(item, checks))
    expect(assessNativeEvidence(record)).toMatchObject({ c: true, counts: { passed: 4 } })
  })
})
