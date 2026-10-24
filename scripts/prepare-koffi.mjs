// Windows 原生调用库 koffi 的 win32-x64 二进制(创始人 09-13「Clash 有的全部加上」:系统代理变更通知
// 改成进程内直接调 InternetSetOptionW,⛔ 再起 PowerShell)。koffi 3.x 把各平台二进制拆成
// @koromix/koffi-<platform>-<arch> 可选依赖,mac 上 npm 只会装 darwin 那份;Windows 那份在这里按版本
// 用 npm pack 取(npm 自校验 integrity),解到 vendor/koffi/win32-x64,打包时随 sidecar/win 一起进 resources。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const koffiVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'koffi', 'package.json'), 'utf8')).version
const pkg = `@koromix/koffi-win32-x64@${koffiVersion}`
const destination = join(root, 'vendor', 'koffi', 'win32-x64')
const marker = join(destination, 'package.json')
if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).version === koffiVersion) {
  process.stdout.write(`koffi win32-x64 ${koffiVersion}: already prepared\n`)
} else {
  const cache = join(root, 'vendor', '.cache')
  mkdirSync(cache, { recursive: true })
  const tarball = execFileSync('npm', ['pack', pkg, '--pack-destination', cache, '--silent'], { encoding: 'utf8', cwd: root }).trim().split('\n').pop()
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['-xzf', join(cache, tarball), '-C', destination, '--strip-components', '1'])
  if (!existsSync(join(destination, 'koffi.node'))) {
    // 包内布局以 package.json 的 main 为准;有的版本把二进制放子目录,这里只要求 package.json 在。
    if (!existsSync(marker)) throw new Error('koffi win32-x64 package incomplete')
  }
  renameSync(marker, `${marker}.tmp`); renameSync(`${marker}.tmp`, marker)
  process.stdout.write(`koffi win32-x64 ${koffiVersion}: prepared from ${tarball}\n`)
}
