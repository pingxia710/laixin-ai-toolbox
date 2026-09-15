import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/laixin-fixture-unused' }, shell: { openExternal: vi.fn(async () => undefined) } }))

const { BridgeRegistry } = await import('../../app/main/bridge/bridge-registry')
const { registerPlanUsageActions } = await import('../../app/main/actions/plan-usage')
const { readPlatformUsage } = await import('../../app/main/ai-access/platform-usage')

const deps = {
  home: '/tmp/laixin-fixture-unused',
  readQuota: async (source: 'zhipu' | 'kimi') => ({ source, quota: null, status: 'key-missing' as const }),
  providerKey: async () => undefined,
  officialPage: (platform: string) => `https://example.invalid/${platform}`,
  readLocal: async () => ({ usage: null, status: 'no-records' as const }),
  now: () => 1_789_000_000_000
}

function fixture() {
  const registry = new BridgeRegistry()
  const opened: string[] = []
  registerPlanUsageActions(registry, deps, async (url) => { opened.push(url) })
  return { registry, opened }
}

describe('用量动作桥', () => {
  it('读一个平台的用量，回来的是可解析的报告', async () => {
    const { registry } = fixture()
    const response = await registry.execute('planusage.read', { platform: 'kimi-code' }) as { snapshot: string }
    expect(JSON.parse(response.snapshot)).toMatchObject({ platform: 'kimi-code', status: 'no-records', officialPage: 'https://example.invalid/kimi-code' })
    expect(await readPlatformUsage('kimi-code', deps)).toMatchObject({ status: 'no-records' })
  })

  it('平台名不认识就拒掉，⛔ 让渲染层拿它当参数乱指', async () => {
    const { registry } = fixture()
    for (const platform of ['codex', '../etc', '']) {
      await expect(registry.execute('planusage.read', { platform })).rejects.toThrow()
    }
  })

  it('打开官方页面的地址由主进程按平台解析，渲染层递不进网址', async () => {
    const { registry, opened } = fixture()
    await registry.execute('planusage.openOfficialPage', { platform: 'zcode' })
    expect(opened).toEqual(['https://example.invalid/zcode'])
    await expect(registry.execute('planusage.openOfficialPage', { platform: 'https://evil.invalid' })).rejects.toThrow()
    expect(opened).toEqual(['https://example.invalid/zcode'])
  })
})
