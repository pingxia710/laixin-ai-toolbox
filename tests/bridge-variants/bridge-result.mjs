import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '真实 Electron 桥返回异常'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(join(tempRoot, 'app/main/actions/alpha.ts'), "source: 'alpha'", "source: 'broken'")
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
