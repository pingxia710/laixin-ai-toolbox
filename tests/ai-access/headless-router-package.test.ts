import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  main: string
  scripts: Record<string, string>
  build: { files: string[]; mac: { target: string[] }; win: { target: { target: string; arch: string[] }[] } }
}

describe('API-15R-B 三平台候选打包结构', () => {
  it('Mac arm64、Mac x64、Windows 均从同一包内入口分流到 headless 模块', () => {
    expect(packageJson.main).toBe('./out/main/index.js')
    expect(packageJson.build.files).toContain('out/**/*')
    expect(packageJson.build.mac.target).toEqual(expect.arrayContaining(['dmg', 'dir']))
    expect(packageJson.build.win.target).toEqual(expect.arrayContaining([{ target: 'nsis', arch: ['x64'] }]))
    expect(packageJson.scripts['build:mac']).toContain('electron-builder --mac --arm64')
    // RETIRE02:Intel 构建线已停发,脚本不得回流(日常钉子在 tests/site/intel-line-retired.test.ts)
    expect(packageJson.scripts['build:mac-intel']).toBeUndefined()
    expect(packageJson.scripts['build:pilot']).toContain('electron-builder --win --x64')
    const main = readFileSync(resolve('out/main/index.js'), 'utf8')
    const chunks = readdirSync(resolve('out/main/chunks'))
    expect(main).toContain('--laixin-ai-router')
    expect(main).toContain('cn.laixin.toolbox.ai-router')
    expect(main).toContain('RestartOnFailure')
    expect(main).toContain('--laixin-codex-provider-key')
    expect(chunks.some(name => name.startsWith('headless-router-') && name.endsWith('.js'))).toBe(true)
    expect(chunks.some(name => name.startsWith('gui-') && name.endsWith('.js'))).toBe(true)
    for (const name of chunks.filter(name => name.startsWith('headless-router-'))) {
      const headless = readFileSync(resolve('out/main/chunks', name), 'utf8')
      expect(headless).not.toContain('BrowserWindow')
      expect(headless).not.toContain('DesktopRuntime')
      expect(headless).not.toContain('new Tray')
    }
    const guiChunk = resolve('out/main/chunks', chunks.find(name => name.startsWith('gui-'))!)
    const gui = readFileSync(guiChunk, 'utf8')
    expect(gui).toContain('../../preload/index.js')
    expect(gui).toContain('../../renderer/index.html')
    expect(existsSync(join(dirname(guiChunk), '../../preload/index.js'))).toBe(true)
    expect(existsSync(join(dirname(guiChunk), '../../renderer/index.html'))).toBe(true)
  })
})
