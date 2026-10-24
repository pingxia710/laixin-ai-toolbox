import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// sidecar/shared 是 mac/win 字节级相同文件的唯一源;平台目录(自包含布局,运行与打包按平台整目录取用)
// 由本脚本在测试与构建前复制补齐。平台特有文件不归本脚本管,永不覆盖。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const platforms = ['mac', 'win']

export function prepareSidecar(rootDir = root) {
  const source = join(rootDir, 'sidecar', 'shared')
  let copied = 0
  for (const platform of platforms) {
    const target = join(rootDir, 'sidecar', platform)
    mkdirSync(target, { recursive: true })
    // DL-03: old generated copies must not survive a rebuild after retiring download scheduling.
    for (const retired of ['download-concurrency.mjs', 'download-concurrency.d.mts']) {
      rmSync(join(target, retired), { force: true })
    }
    for (const entry of readdirSync(source)) {
      if (!statSync(join(source, entry)).isFile()) continue
      if (entry === 'README.md') continue // shared 自身说明,非运行文件
      copyFileSync(join(source, entry), join(target, entry))
      copied++
    }
  }
  return copied
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`sidecar: shared → mac/win 共复制 ${prepareSidecar()} 份文件\n`)
}
