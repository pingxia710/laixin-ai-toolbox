import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = 'v26.6.1'
const assets = {
  'mac-arm64': ['Xray-macos-arm64-v8a.zip', 'b0c13d8215eea03929c773056dce21e903fe6e7543348f46bb42184190fb5e50'],
  'mac-x64': ['Xray-macos-64.zip', '2636b49efed01ed4fae07d3988241819d89d880c46a353f6526a2e5195c14d06'],
  'win-x64': ['Xray-windows-64.zip', '0a1ee8c8a45e11e865c725db195429c79b52ee960407065089c5be586f343248']
}
const targets = process.argv.slice(2)
if (targets.length === 0) targets.push(process.platform === 'darwin' ? `mac-${process.arch}` : `win-${process.arch}`)
for (const target of targets) {
  const asset = assets[target]
  if (asset === undefined) throw new Error(`Unsupported Xray target: ${target}`)
  const [name, expected] = asset
  const cache = join(root, 'vendor', '.cache')
  const archive = join(cache, `${version}-${name}`)
  mkdirSync(cache, { recursive: true })
  if (!existsSync(archive)) {
    execFileSync('curl', ['--fail', '--location', '--retry', '2', '--max-time', '180', '--output', archive,
      `https://github.com/XTLS/Xray-core/releases/download/${version}/${name}`], { stdio: 'inherit' })
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected) {
    throw new Error(`Xray archive checksum mismatch: ${name}`)
  }
  const destination = join(root, 'vendor', 'xray', target)
  mkdirSync(destination, { recursive: true })
  const executable = target.startsWith('win') ? 'xray.exe' : 'xray'
  execFileSync('unzip', ['-oq', archive, executable, 'geoip.dat', 'geosite.dat', 'LICENSE', '-d', destination])
  for (const required of [executable, 'geoip.dat', 'geosite.dat', 'LICENSE']) {
    if (!existsSync(join(destination, required))) throw new Error(`Xray archive missing required asset: ${required}`)
  }
  if (!target.startsWith('win')) chmodSync(join(destination, executable), 0o755)
  copyFileSync(join(root, 'resources', 'Xray说明.txt'), join(destination, 'Xray说明.txt'))
  console.log(`Xray ${version} ${target}: official archive SHA256 verified`)
}
