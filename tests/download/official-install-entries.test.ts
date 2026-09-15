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
