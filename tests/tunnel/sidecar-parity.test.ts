import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

it('shared sidecar 与 mac/win 生成副本保持字节一致', () => {
  const script = fileURLToPath(new URL('../../scripts/verify-sidecar-parity.mjs', import.meta.url))
  expect(() => execFileSync(process.execPath, [script], { encoding: 'utf8' })).not.toThrow()
})

it('平台目录出现 shared 之外的残留文件时门禁失败', async () => {
  const root = mkdtempSync(join(process.cwd(), 'sidecar-parity-'))
  try {
    for (const platform of ['mac', 'win']) {
      cpSync(join(process.cwd(), 'sidecar', 'shared'), join(root, 'sidecar', 'shared'), { recursive: true })
      cpSync(join(process.cwd(), 'sidecar', platform), join(root, 'sidecar', platform), { recursive: true })
    }
    writeFileSync(join(root, 'sidecar', 'win', 'stale-retired-module.mjs'), 'export {}\n')
    const { verifySidecarParity } = await import('../../scripts/verify-sidecar-parity.mjs')
    expect(() => verifySidecarParity(root)).toThrow(/多余文件/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
