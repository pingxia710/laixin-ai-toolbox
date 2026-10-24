import { expect, it } from 'vitest'
import { loadCatalog } from '../../app/main/download/catalog'

const ids = [
  'codex-official-download',
  'claude-code-official-install',
  'hermes-official-download',
  'deepseek-harness-official-install',
  'zcode-official-download',
  'kimi-code-official-install',
  'codex-github',
  'claude-code-github',
  'hermes-github',
  'deepseek-harness-github',
  'kimi-code-github'
] as const

it('下载页和已核对的 GitHub 入口均只打开登记的 HTTPS 官方页面', () => {
  const resources = loadCatalog().resources.filter((resource) => ids.includes(resource.id as (typeof ids)[number]))
  expect(resources.map((resource) => resource.id)).toEqual(ids)
  for (const resource of resources) {
    const page = new URL(resource.officialPageUrl)
    expect(resource.type).toBe('external-entry')
    expect(page.protocol).toBe('https:')
    expect(resource.allowedHosts).toContain(page.hostname)
  }
})

it('Claude Code 的官方入口打开命令行版中文安装页，⛔ 带客户去桌面版下载页（CD-03）', async () => {
  const { defaultRecipes } = await import('../../app/main/recipes/recipes')
  const resource = loadCatalog().resources.find(item => item.id === 'claude-code-official-install')!
  expect(resource.officialPageUrl).toBe('https://code.claude.com/docs/zh-CN/setup')
  expect(resource.officialVersionLabel).toContain('命令行版')
  expect(defaultRecipes.shells['claude-code'].officialPage).toBe('https://code.claude.com/docs/zh-CN/setup')
  for (const url of [resource.officialPageUrl, defaultRecipes.shells['claude-code'].officialPage]) expect(url).not.toContain('claude.com/download')
})
