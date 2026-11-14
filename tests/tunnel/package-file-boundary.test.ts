import { afterAll, beforeAll, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageEntries } from '../../app/main/tunnel/import-service'
import { MAX_PACKAGE_TOTAL_BYTES } from '../../app/main/tunnel/package-format'
import { UnsafePackageEntry } from '../../app/main/tunnel/tar'

const root = mkdtempSync(join(tmpdir(), 'laixin-package-boundary-'))
const bundle = join(root, 'reader.cjs')
beforeAll(() => {
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  execFileSync(join(repo, 'node_modules/.bin/esbuild'), [join(repo, 'app/main/tunnel/import-service.ts'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`], { stdio: 'pipe' })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('直接选中的软链不能绕过整包大小限制，也不跟随小文件软链', () => {
  for (const size of [1024, MAX_PACKAGE_TOTAL_BYTES + 512]) {
    const target = join(root, `target-${String(size)}.lxtpack`)
    const link = join(root, `link-${String(size)}.lxtpack`)
    writeFileSync(target, Buffer.alloc(size))
    symlinkSync(target, link)
    expect(() => readPackageEntries(link)).toThrow(UnsafePackageEntry)
  }
})

it.skipIf(process.platform === 'win32')('特殊文件在打开前拒绝，不因 FIFO 等待写入而挂起', () => {
  const path = join(root, 'input.fifo')
  execFileSync('/usr/bin/mkfifo', [path])
  const result = spawnSync(process.execPath, ['-e', `
    try { require(process.argv[1]).readPackageEntries(process.argv[2]); process.exitCode = 2 }
    catch (error) { console.log(error.name) }
  `, bundle, path], { timeout: 1500, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('UnsafePackageEntry')
})

it.each(['lstatSync', 'fstatSync'])('在 %s 检查后文件增长，仍受整包读取上限约束', (phase) => {
  const path = join(root, 'growing.lxtpack')
  writeFileSync(path, Buffer.alloc(1024))
  const result = spawnSync(process.execPath, ['-e', `
    const { readPackageEntries } = require(process.argv[1])
    const fs = require('node:fs'), phase = process.argv[4], original = fs[phase]
    fs[phase] = function(path, ...args) {
      const info = original(path, ...args)
      if (phase === 'fstatSync' || path === process.argv[2]) fs.truncateSync(process.argv[2], Number(process.argv[3]))
      return info
    }
    try { readPackageEntries(process.argv[2]); process.exitCode = 2 }
    catch (error) { console.log(error.code) }
  `, bundle, path, String(MAX_PACKAGE_TOTAL_BYTES + 512), phase], { timeout: 1500, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('PACKAGE_TOO_LARGE')
})
