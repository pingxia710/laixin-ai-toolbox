import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isPlatform, isSoftwareId, platforms, softwareIds, type SoftwareId } from '../../app/main/precheck/software-platform'

const execFileAsync = promisify(execFile)
const fixtureSoftware: SoftwareId = 'fixture-second-software'

describe('软件 / 平台维度', () => {
  it('产品软件列表与平台列表只由公共维度导出', () => {
    expect(softwareIds).toEqual(['hermes', 'codex', 'claude'])
    expect(platforms).toEqual(['macos', 'windows'])
    expect(isSoftwareId(fixtureSoftware)).toBe(true)
    expect(isSoftwareId('Fixture Second Software')).toBe(false)
    expect(isPlatform('windows')).toBe(true)
    expect(isPlatform('linux')).toBe(false)
  })

  it('把软件维度退回 Hermes 单值时，依赖第二款 fixture 的编译必须变红', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'laixin-toolbox-software-dimension-'))
    const source = await readFile(resolve('app/main/precheck/software-platform-owner.ts'), 'utf8')
    const marker = 'export type SoftwareId = string'
    const mutated = source.replace(marker, "export type SoftwareId = 'hermes'")

    expect(mutated).not.toBe(source)
    try {
      await writeFile(join(temporaryRoot, 'software-platform-owner.ts'), mutated)
      await writeFile(
        join(temporaryRoot, 'consumer.ts'),
        "import type { SoftwareId } from './software-platform-owner'\nconst second: SoftwareId = 'fixture-second-software'\nvoid second\n"
      )

      const result = await execFileAsync(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'Bundler',
        join(temporaryRoot, 'consumer.ts')
      ], { cwd: temporaryRoot }).then(
        () => undefined,
        (error: unknown) => error
      )

      expect(result).toBeDefined()
      const output = commandOutput(result)
      expect(output).toContain('TS2322')
      expect(output).toContain('fixture-second-software')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})

function commandOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error)
  }
  const output = error as { stdout?: unknown; stderr?: unknown }
  return `${String(output.stdout ?? '')}${String(output.stderr ?? '')}`
}
