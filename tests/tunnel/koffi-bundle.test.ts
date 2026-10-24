// 成品里 Windows 原生通知库的随包规则(GPT-6 复核 f00b1f9):electron-builder 的过滤一旦漏掉 koffi 的任何一个
// 运行时 JS,原生通道在成品里必然加载失败、永远回落 PowerShell,而注入测试测不到。这里不打包,直接拿 package.json
// 里的过滤规则,对 koffi 真实文件树逐个匹配:入口链上的文件一个都不能少,C++ 源码一个都不该带。
// 完整加载链(含 Windows 二进制是 PE)由 scripts/verify-koffi-bundle.mjs 对成品核。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minimatch } from 'minimatch'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const koffiRoot = join(root, 'node_modules', 'koffi')

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [relative(koffiRoot, path)]
  })
}

function bundledByFilter(patterns: readonly string[], file: string): boolean {
  // electron-builder 语义:有 include 模式时只带匹配到的;`!` 开头为排除。
  const includes = patterns.filter((pattern) => !pattern.startsWith('!'))
  const excludes = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))
  const included = includes.length === 0 || includes.some((pattern) => minimatch(file, pattern, { dot: true }))
  return included && !excludes.some((pattern) => minimatch(file, pattern, { dot: true }))
}

describe('koffi 随包规则', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    build: { win: { extraResources: Array<{ from: string; to: string; filter?: string[] }> } }
  }
  const rule = pkg.build.win.extraResources.find((entry) => entry.to === 'sidecar/win/node_modules/koffi/')
  const files = listFiles(koffiRoot)

  it('入口链上的运行时文件一个都不能少', () => {
    expect(rule).toBeDefined()
    // require('koffi') → index.cjs → src/koffi/index.cjs → src/koffi/src/static.cjs(按平台 require @koromix 包)
    for (const required of ['package.json', 'index.cjs', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs', 'src/koffi/src/trampolines.cjs']) {
      expect(files).toContain(required)
      expect(bundledByFilter(rule!.filter ?? [], required), required).toBe(true)
    }
  })

  it('C++ 源码与头文件不随包', () => {
    const sources = files.filter((file) => /\.(cc|hh|h|inc|def|txt)$/.test(file) && file !== 'LICENSE.txt')
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) expect(bundledByFilter(rule!.filter ?? [], source), source).toBe(false)
  })

  it('Windows 二进制包单独随包到 @koromix 目录', () => {
    expect(pkg.build.win.extraResources.some((entry) => entry.to === 'sidecar/win/node_modules/@koromix/koffi-win32-x64/')).toBe(true)
  })
})
