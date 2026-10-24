import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = 'fixture 监听器生命周期探针返回码异常'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(join(tempRoot, 'app/renderer/src/pages/alpha.ts'), 'listenerCount += 1', 'listenerCount += 0')
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
