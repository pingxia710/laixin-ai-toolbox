import { describe, expect, it } from 'vitest'
import { applicationMenuTemplate } from '../../app/main/desktop/app-menu'

const flat = (menus: ReturnType<typeof applicationMenuTemplate>) => menus.flatMap((menu) => {
  const submenu = (menu as { submenu?: unknown }).submenu
  return Array.isArray(submenu) ? submenu : []
})

describe('生产应用菜单(中文精简)', () => {
  it('macOS:应用/编辑/显示/窗口全中文,退出在应用菜单,不出现 reload/devtools', () => {
    const menus = applicationMenuTemplate('darwin')
    expect(menus.map((menu) => (menu as { label?: string }).label)).toEqual(['来信 AI 工具箱', '编辑', '显示', '窗口'])
    const items = flat(menus) as Array<{ label?: string; role?: string; accelerator?: string }>
    expect(items.some((item) => item.role === 'quit' && item.label === '退出来信 AI 工具箱')).toBe(true)
    expect(items.some((item) => item.role === 'copy')).toBe(true)
    expect(items.some((item) => item.role === 'paste')).toBe(true)
    expect(items.some((item) => item.label === '放大' && item.role === 'zoomIn')).toBe(true)
    const serialized = JSON.stringify(menus)
    expect(serialized).not.toMatch(/reload|devtools|forceReload/i)
    expect(serialized).not.toMatch(/CmdOrCtrl\+R|F12/)
    expect(items.every((item) => !item.accelerator)).toBe(true)
  })

  it('Windows:无应用菜单(首项即编辑),同样不带 reload/devtools', () => {
    const menus = applicationMenuTemplate('win32')
    expect(menus.map((menu) => (menu as { label?: string }).label)).toEqual(['编辑', '显示', '窗口'])
    const serialized = JSON.stringify(menus)
    expect(serialized).not.toMatch(/reload|devtools|forceReload/i)
    expect(serialized).not.toMatch(/CmdOrCtrl\+R|F12/)
  })
})
