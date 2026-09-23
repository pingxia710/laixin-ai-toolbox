import { describe, expect, it, vi } from 'vitest'
import { defaultRecipes } from '../../app/main/recipes/recipes'
import { ShellInventory, commandCandidates } from '../../app/main/shells/inventory'

/** 只看文件在不在：exec 一被调用就算失败，保证识别过程不运行任何程序。 */
function inventory(platform: 'darwin' | 'win32', files: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const present = new Set(files)
  const exec = vi.fn(async () => { throw new Error('claude edition detection must not execute programs') })
  const fetch = vi.fn(async () => { throw new Error('claude edition detection must not use the network') })
  const home = platform === 'win32' ? 'C:\\Users\\customer' : '/Users/customer'
  const inv = new ShellInventory({
    platform, home, env: { PATH: platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin', ...env },
    recipes: () => defaultRecipes, exec, exists: async path => present.has(path), fetch: fetch as unknown as typeof globalThis.fetch,
    trustedVersion: async () => undefined
  })
  return { inv, exec, fetch }
}

describe('认出客户装的是 Claude 桌面版还是 Claude Code 命令行版（CD-02）', () => {
  it('Windows 商店版与旧安装版桌面版都能认出；没有命令行版时 cli 为 false', async () => {
    const store = inventory('win32', ['C:\\Users\\customer\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc'])
    await expect(store.inv.claudeEditions()).resolves.toEqual({ cli: false, desktop: true })
    const squirrel = inventory('win32', ['D:\\Profiles\\customer\\Local\\AnthropicClaude\\claude.exe'], { LOCALAPPDATA: 'D:\\Profiles\\customer\\Local' })
    await expect(squirrel.inv.claudeEditions()).resolves.toEqual({ cli: false, desktop: true })
    expect(store.exec).not.toHaveBeenCalled()
    expect(store.fetch).not.toHaveBeenCalled()
  })

  it('Mac 的 Claude.app 认作桌面版；官方安装位置或 PATH 上的 claude 认作命令行版', async () => {
    await expect(inventory('darwin', ['/Applications/Claude.app/Contents/Info.plist']).inv.claudeEditions())
      .resolves.toEqual({ cli: false, desktop: true })
    await expect(inventory('darwin', ['/Users/customer/Applications/Claude.app/Contents/Info.plist', '/Users/customer/.local/bin/claude']).inv.claudeEditions())
      .resolves.toEqual({ cli: true, desktop: true })
    // npm 全局安装在 PATH 目录里放的是 claude.cmd；候选路径取生产同一个函数，避免测试自己拼分隔符。
    const npmEnv = { PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\customer\\AppData\\Roaming' }
    const npmShim = commandCandidates('claude', 'win32', 'C:\\Users\\customer', npmEnv).find(candidate => candidate.includes('npm') && candidate.endsWith('claude.cmd'))!
    expect(npmShim).toBeDefined()
    await expect(inventory('win32', [npmShim], npmEnv).inv.claudeEditions()).resolves.toEqual({ cli: true, desktop: false })
  })

  it('商店版桌面版在 PATH 上注册的 Claude.exe 执行别名不算命令行版', async () => {
    const env = { PATH: 'C:\\Windows\\System32;C:\\Users\\customer\\AppData\\Local\\Microsoft\\WindowsApps', LOCALAPPDATA: 'C:\\Users\\customer\\AppData\\Local' }
    const alias = commandCandidates('claude', 'win32', 'C:\\Users\\customer', env).find(candidate => candidate.includes('WindowsApps') && candidate.endsWith('claude.exe'))!
    expect(alias).toBeDefined()
    const { inv } = inventory('win32', [alias, 'C:\\Users\\customer\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc'], env)
    await expect(inv.claudeEditions()).resolves.toEqual({ cli: false, desktop: true })
    expect(await inv.inspect('claude-code')).toMatchObject({ installed: false, claudeDesktop: true })
  })

  it('两样都没装、或只有别家软件时不误报桌面版', async () => {
    await expect(inventory('win32', ['C:\\Users\\customer\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0']).inv.claudeEditions())
      .resolves.toEqual({ cli: false, desktop: false })
    await expect(inventory('darwin', ['/Applications/ChatGPT.app/Contents/Info.plist']).inv.claudeEditions())
      .resolves.toEqual({ cli: false, desktop: false })
  })

  it('「检测版本」结果只在 Claude Code 条目带上桌面版事实', async () => {
    const { inv } = inventory('darwin', ['/Applications/Claude.app/Contents/Info.plist'])
    const claude = await inv.inspect('claude-code')
    expect(claude).toMatchObject({ installed: false, claudeDesktop: true })
    expect(await inv.inspect('codex')).not.toHaveProperty('claudeDesktop')
  })
})
