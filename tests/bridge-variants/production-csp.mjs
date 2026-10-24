import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '生产构建缺少官网群码清单 CSP'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(join(tempRoot, 'app/renderer/src/csp.ts'),
    "const groupEntryOrigin = 'https://laixin.work'", "const groupEntryOrigin = \"'none'\"")
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
