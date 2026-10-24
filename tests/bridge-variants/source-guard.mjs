import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '守卫在位的来源探针返回码异常'

export function mutateVerificationProject(tempRoot) {
  replaceFileContent(
    join(tempRoot, 'app/main/bridge/source-guard.ts'),
    '  return (\n    senderFrame !== null &&\n    senderFrame === owner.mainFrame &&\n    sourceIdentity(senderFrame.url) === sourceIdentity(entryUrl)\n  )',
    '  return true'
  )
}

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}
