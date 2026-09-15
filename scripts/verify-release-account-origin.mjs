import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractFile } from '@electron/asar'

const expectedOrigin = '"https://laixin.net.cn/AI-tools/"'
const expectedVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
const archives = process.argv.slice(2)

assert.ok(archives.length > 0, 'USAGE: node scripts/verify-release-account-origin.mjs <app.asar> [...]')

for (const archive of archives) {
  const path = resolve(archive)
  const main = extractFile(path, 'out/main/index.js').toString('utf8')
  const packagedVersion = JSON.parse(extractFile(path, 'package.json').toString('utf8')).version
  const origin = main.match(/new AccountClient\(\s*([^,]+),/)?.[1]
  assert.equal(packagedVersion, expectedVersion, `PACKAGED_VERSION_MISMATCH:${path}`)
  assert.equal(origin, expectedOrigin, `ACCOUNT_ORIGIN_MISMATCH:${path}`)
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  process.stdout.write(`ACCOUNT_ORIGIN_OK version=${packagedVersion} sha256=${sha256} archive=${path}\n`)
}
