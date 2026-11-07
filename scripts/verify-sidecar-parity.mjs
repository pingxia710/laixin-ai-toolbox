import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const PLATFORM_ONLY = Object.freeze({
  mac: new Set([
    'CONFIG-PACKAGE.md', 'active-network-path.d.mts', 'active-network-path.mjs',
    'adapter-networksetup.mjs', 'connectors.d.mts', 'connectors.mjs',
    'macos-write-right.d.mts', 'macos-write-right.mjs', 'managed-adapter.d.mts',
    'managed-adapter.mjs', 'port-owner.d.mts', 'port-owner.mjs', 'power-events.d.mts',
    'power-events.mjs', 'proxy-privilege.mjs', 'terminal-environment.d.mts', 'terminal-environment.mjs'
  ]),
  win: new Set([
    'adapter-wininet.mjs', 'connectors.d.mts', 'connectors.mjs', 'managed-adapter.d.mts',
    'managed-adapter.mjs', 'port-owner.d.mts', 'port-owner.mjs', 'power-events.d.mts',
    'power-events.mjs', 'terminal-environment.d.mts', 'terminal-environment.mjs',
    'wininet-settings.ps1', 'wininet-values.d.mts', 'wininet-values.mjs',
    'wininet-write-right.d.mts', 'wininet-write-right.mjs'
  ])
})

function filesUnder(directory) {
  const result = []
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) visit(path)
      else result.push(relative(directory, path))
    }
  }
  visit(directory)
  return result
}

const normalizeRelativePath = (entry) => entry.split('\\').join('/')

export function verifySidecarParity(rootDir = root) {
  const shared = join(rootDir, 'sidecar', 'shared')
  const entries = readdirSync(shared).filter((entry) => entry !== 'README.md' && statSync(join(shared, entry)).isFile()).sort()
  const mismatches = []
  for (const platform of ['mac', 'win']) {
    const target = join(rootDir, 'sidecar', platform)
    for (const entry of entries) {
      const sourcePath = join(shared, entry)
      const targetPath = join(target, entry)
      try {
        if (digest(sourcePath) !== digest(targetPath)) mismatches.push(`${platform}/${entry}:内容不一致`)
      } catch { mismatches.push(`${platform}/${entry}:缺失`) }
    }
    const allowed = new Set([...entries, ...PLATFORM_ONLY[platform]])
    for (const entry of filesUnder(target)) {
      const normalized = normalizeRelativePath(entry)
      if (normalized.startsWith('bin/')) continue // platform-native binaries are not shared source.
      if (!allowed.has(normalized)) mismatches.push(`${platform}/${normalized}:多余文件`)
    }
  }
  if (mismatches.length > 0) throw new Error(`SIDECAR_PARITY_FAILED\n${mismatches.join('\n')}`)
  return { files: entries.length, platforms: 2 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifySidecarParity()
  process.stdout.write(`sidecar parity: ${String(result.files)} files × ${String(result.platforms)} platforms\n`)
}
