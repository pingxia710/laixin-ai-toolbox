import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '预期构建失败但通过:PAGE_MODULE_DUPLICATE'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(
    join(tempRoot, 'electron.vite.config.ts'),
    'if (earlier !== undefined) {',
    "if (earlier !== undefined && errorCode !== 'PAGE_MODULE_DUPLICATE') {"
  )
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
