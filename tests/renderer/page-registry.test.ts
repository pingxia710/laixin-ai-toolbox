import { describe, expect, it } from 'vitest'
import { buildPageRegistry } from '../../app/renderer/src/page-registry'
import type { PageModule } from '../../app/renderer/src/pages/types'

const mount = (): void => undefined
const unmount = (): void => undefined

describe('页面注册表', () => {
  it('固定页签顺序，并在同页签按 order 挂载', () => {
    const registry = buildPageRegistry([
      { moduleId: 'beta', tab: 'tunnel', order: 20, mount, unmount },
      { moduleId: 'alpha', tab: 'tunnel', order: 10, mount, unmount }
    ])

    expect(registry.tabIds).toEqual(['dashboard', 'usage', 'platform-layout', 'purchase', 'sharing', 'tunnel', 'referral', 'account', 'settings'])
    expect(registry.modulesFor('tunnel').map((module) => module.moduleId)).toEqual(['alpha', 'beta'])
  })

  it('重复 moduleId 和未知页签都被拒绝', () => {
    const duplicate: PageModule = { moduleId: 'same', tab: 'tunnel', order: 1, mount, unmount }
    expect(() => buildPageRegistry([duplicate, duplicate])).toThrow('PAGE_MODULE_DUPLICATE')
    expect(() =>
      buildPageRegistry([{ moduleId: 'wrong', tab: 'other' as PageModule['tab'], order: 1, mount, unmount }])
    ).toThrow('PAGE_MODULE_TAB_INVALID')
  })
})

describe('pages 目录只放页面模块', () => {
  it('目录里每个文件都要导出 page，否则渲染器启动即崩', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // 仓库路径含中文，URL.pathname 会是百分号编码；必须用 fileURLToPath 还原。
    const dir = fileURLToPath(new URL('../../app/renderer/src/pages/', import.meta.url))
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts') && name !== 'types.ts')
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      // page-registry 用 import.meta.glob 自动收这个目录；放个纯工具模块进来会让整页挂掉。
      expect(await readFile(join(dir, name), 'utf8'), `${name} 不是页面模块，请放到 pages/ 之外`).toContain('export const page')
    }
  })
})
