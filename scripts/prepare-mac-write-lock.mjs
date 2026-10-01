import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export function prepareMacWriteLock() {
  if (process.platform !== 'darwin') return
  compileNative('mac-write-lock.c', 'write-lock', [])
  compileNative('mac-proxy-helper.m', 'proxy-helper', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'SystemConfiguration'])
}

function compileNative(sourceName, binaryName, flags) {
  const source = join(root, 'native', sourceName)
  const output = join(root, 'sidecar', 'mac', 'bin', binaryName)
  const newestInput = Math.max(statSync(source).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs)
  try { if (statSync(output).mtimeMs >= newestInput) return } catch { /* first build */ }
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  try {
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'x86_64', '-arch', 'arm64',
      '-mmacosx-version-min=12.0', '-O2', '-Wall', '-Wextra', '-Werror', ...flags, source, '-o', temporary], { stdio: 'inherit' })
    renameSync(temporary, output)
  } finally { rmSync(temporary, { force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareMacWriteLock()
