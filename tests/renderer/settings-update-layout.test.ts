import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const styles = readFileSync(new URL('../../app/renderer/src/styles.css', import.meta.url), 'utf8')

const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
}

it('更新图标与下载按钮使用同一个主蓝色', () => {
  expect(rule('.update-dialog-mark')).toContain('background: var(--accent)')
})

it('更新弹窗把底部操作区固定在可视范围内，更新说明单独滚动', () => {
  expect(rule('.update-dialog')).toContain('height: min(680px, calc(100dvh - 40px))')
  expect(rule('.update-dialog[open]')).toContain('grid-template-rows: auto minmax(0, 1fr) auto')

  const content = rule('.update-dialog-content')
  expect(content).toContain('min-height: 0')
  expect(content).toContain('grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto')

  const notes = rule('.update-dialog-notes')
  expect(notes).toContain('min-height: 0')
  expect(notes).toContain('overflow: auto')
})
