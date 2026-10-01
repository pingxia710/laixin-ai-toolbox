import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareSidecar } from '../../scripts/prepare-sidecar.mjs'
import { makeTempDir, removeTempDir } from './helpers'

it('preparing an existing build removes retired download modules and retains platform adapters', () => {
  const root = makeTempDir('sidecar-retired-')
  try {
    mkdirSync(join(root, 'sidecar/shared'), { recursive: true })
    writeFileSync(join(root, 'sidecar/shared/local-bridge.mjs'), 'current relay')
    for (const platform of ['mac', 'win']) {
      const target = join(root, 'sidecar', platform)
      mkdirSync(target)
      for (const name of ['download-concurrency.mjs', 'download-concurrency.d.mts']) writeFileSync(join(target, name), 'retired')
      writeFileSync(join(target, 'platform-adapter.mjs'), 'platform adapter')
    }
    prepareSidecar(root)
    for (const platform of ['mac', 'win']) {
      const target = join(root, 'sidecar', platform)
      expect(existsSync(join(target, 'download-concurrency.mjs'))).toBe(false)
      expect(existsSync(join(target, 'download-concurrency.d.mts'))).toBe(false)
      expect(readFileSync(join(target, 'local-bridge.mjs'), 'utf8')).toBe('current relay')
      expect(readFileSync(join(target, 'platform-adapter.mjs'), 'utf8')).toBe('platform adapter')
    }
  } finally { removeTempDir(root) }
})
