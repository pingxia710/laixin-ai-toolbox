import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '预期构建失败但通过:Subsequent property declarations'

export function mutateVerificationProject(tempRoot) {
  const path = join(tempRoot, 'tests/fixtures/duplicate-preload-namespace.ts')
  replaceFileContent(path, "namespace = 'app'", "namespace = 'app_duplicate'")
  replaceFileContent(path, 'readonly app: ConflictingAppApi', 'readonly appDuplicate: ConflictingAppApi')
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
