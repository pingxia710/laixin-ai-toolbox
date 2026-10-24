import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '验证构建缺少 alpha 动作'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(join(tempRoot, 'app/main/actions/alpha.ts'), 'alpha.echo', 'alpha.absent')
  replaceFileContent(join(tempRoot, 'app/preload/api/alpha.ts'), 'alpha.echo', 'alpha.absent')
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
