import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const styles = readFileSync(new URL('../../app/renderer/src/styles.css', import.meta.url), 'utf8')

const rootBlock = /:root\s*\{[^}]*\}/.exec(styles)?.[0] ?? ''

it('字体栈抽成变量,Windows 西文首选 Segoe UI 且先于中文字体', () => {
  expect(rootBlock).toContain('--font-sans:')
  const sans = /--font-sans:([^;]+);/.exec(rootBlock)?.[1] ?? ''
  expect(sans).toContain('"Segoe UI"')
  expect(sans.indexOf('"Segoe UI"')).toBeLessThan(sans.indexOf('"Microsoft YaHei"'))
  expect(rootBlock).toContain('font-family: var(--font-sans)')
})

it('等宽字体抽成 --font-mono,恢复码输入使用等宽栈', () => {
  expect(rootBlock).toContain('--font-mono:')
  expect(styles).toContain('font: 16px/1.7 var(--font-mono)')
})

it('全局数字使用 tabular-nums,金额与百分比不跳动', () => {
  expect(rootBlock).toContain('font-variant-numeric: tabular-nums')
})
