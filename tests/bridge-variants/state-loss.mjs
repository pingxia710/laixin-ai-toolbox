import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = 'PAGE_LIFECYCLE_STATE_PRESERVED=FAIL'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(
    join(tempRoot, 'app/renderer/src/pages/alpha.ts'),
    '  unmount: () => {\n',
    '  unmount: () => {\n    state.count = -99\n'
  )
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
