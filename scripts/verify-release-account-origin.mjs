import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'

const expectedOrigin = '"https://laixin.work/"'
const sourceVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
const arguments_ = process.argv.slice(2)
const requestedVersion = arguments_[0]?.startsWith('--expected-version=') ? arguments_.shift()?.slice('--expected-version='.length) : undefined
const expectedVersion = requestedVersion ?? sourceVersion
const archives = arguments_

assert.ok(archives.length > 0, 'USAGE: node scripts/verify-release-account-origin.mjs [--expected-version=<source-version-or-prerelease>] <app.asar> [...]')
assert.ok(expectedVersion === sourceVersion || expectedVersion.startsWith(`${sourceVersion}-`), `EXPECTED_VERSION_OUTSIDE_SOURCE_BASE:${expectedVersion}`)

function packagedMainSources(path) {
  const entries = listPackage(path, { isPack: false })
    .map(entry => entry.replace(/^\//, ''))
    .filter(entry => entry === 'out/main/index.js' || /^out\/main\/chunks\/[^/]+\.js$/.test(entry))
  assert.ok(entries.includes('out/main/index.js'), `PACKAGED_MAIN_ENTRY_MISSING:${path}`)
  return entries.map(entry => extractFile(path, entry).toString('utf8'))
}

function matches(sources, expression) {
  return sources.flatMap(source => Array.from(source.matchAll(expression), match => match[1]))
}

for (const archive of archives) {
  const path = resolve(archive)
  const sources = packagedMainSources(path)
  const packagedVersion = JSON.parse(extractFile(path, 'package.json').toString('utf8')).version
  const origins = matches(sources, /new\s+AccountClient\(\s*("(?:[^"\\]|\\.)*")\s*,/g)
  const updateOrigins = matches(sources, /new\s+ToolboxUpdater\(\{[\s\S]*?\borigin:\s*("(?:[^"\\]|\\.)*")/g)
  assert.equal(packagedVersion, expectedVersion, `PACKAGED_VERSION_MISMATCH:${path}`)
  assert.ok(origins.length > 0 && origins.every(origin => origin === expectedOrigin), `ACCOUNT_ORIGIN_MISMATCH:${path}`)
  assert.ok(updateOrigins.length > 0 && updateOrigins.every(origin => origin === expectedOrigin), `UPDATE_ORIGIN_MISMATCH:${path}`)
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  process.stdout.write(`ACCOUNT_UPDATE_ORIGIN_OK version=${packagedVersion} sha256=${sha256} archive=${path}\n`)
}
