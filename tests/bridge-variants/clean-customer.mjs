import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const expectedFailure = '干净客户构建仍包含示例模块'

export function mutateCleanCustomerProject(cleanRoot) {
  const path = join(cleanRoot, 'app/renderer/src/platform/install-card.ts')
  const source = readFileSync(path, 'utf8')
  const expected = '工具箱提供官方下载入口。'
  if (!source.includes(expected)) {
    throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, 'alpha.echo.'))
}
