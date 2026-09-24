import { describe, expect, it, vi } from 'vitest'
import { CodexWorkspaceService } from '../../app/main/ai-access/codex-workspaces'
import type { CodexCommand } from '../../app/main/codex-usage/runtime'
import type { CodexWorkspaceSource } from '../../app/main/ai-access/codex-workspace-sources'
import type { AiAccessProvider, AiAccessShell, AiAccessStatus } from '../../app/main/ai-access/service'

function fixture() {
  const access = {
    codexOfficialLoginRoot: vi.fn(async () => '/customer/.codex'),
    providerKey: vi.fn(async (shell: AiAccessShell, provider: AiAccessProvider): Promise<string | undefined> => {
      void shell; void provider
      return 'sk-saved-fixture-key-1234567890'
    }),
    verifyAndSaveProviderKey: vi.fn(async (_shell: AiAccessShell, provider: AiAccessProvider): Promise<AiAccessStatus> =>
      ({ attempt: { shell: 'codex', provider, ok: true, at: '2026-09-24T00:00:00.000Z' }, shells: {} as AiAccessStatus['shells'] }))
  }
  const findCommand = vi.fn(async () => ({ executable: '/trusted/codex', args: ['app-server', '--listen', 'stdio://'] }))
  const installProviders = vi.fn(async () => undefined)
  const launch = vi.fn(async (command: CodexCommand, input: { codexHome: string; source: CodexWorkspaceSource }) => {
    void command; void input
    return { threadId: '01999999-1111-7111-8111-111111111111' }
  })
  const openExternal = vi.fn(async (url: string) => { void url })
  const service = new CodexWorkspaceService({ access: access as never, findCommand, installProviders, launch, openExternal })
  return { service, access, findCommand, installProviders, launch, openExternal }
}

describe('Codex 四来源工作窗口编排', () => {
  it('官方窗口不读 Key、不写 API 来源表，直接创建 openai 线程', async () => {
    const f = fixture()
    await expect(f.service.open('official')).resolves.toEqual({ ok: true, source: 'official', code: 'opened' })
    expect(f.access.providerKey).not.toHaveBeenCalled()
    expect(f.access.verifyAndSaveProviderKey).not.toHaveBeenCalled()
    expect(f.installProviders).not.toHaveBeenCalled()
    expect(f.launch.mock.calls[0]?.[1].source).toMatchObject({ provider: 'openai' })
    expect(f.openExternal).toHaveBeenCalledWith('codex://threads/01999999-1111-7111-8111-111111111111')
  })

  it('已有 Key 时只登记来源表并创建对应线程，不切换全局来源', async () => {
    const f = fixture()
    await expect(f.service.open('moonshot')).resolves.toMatchObject({ ok: true, source: 'moonshot' })
    expect(f.access.providerKey).toHaveBeenCalledWith('codex', 'moonshot')
    expect(f.installProviders).toHaveBeenCalledWith('/customer/.codex')
    expect(f.launch.mock.calls[0]?.[1].source).toMatchObject({ provider: 'laixin-kimi-api', model: 'kimi-k3' })
  })

  it('缺 Key 和错误 Key 均不写配置、不建线程、不打开 Codex', async () => {
    const missing = fixture()
    missing.access.providerKey.mockResolvedValueOnce(undefined)
    await expect(missing.service.open('deepseek')).resolves.toEqual({ ok: false, source: 'deepseek', code: 'key_missing' })
    expect(missing.installProviders).not.toHaveBeenCalled()
    expect(missing.launch).not.toHaveBeenCalled()

    const rejected = fixture()
    rejected.access.verifyAndSaveProviderKey.mockResolvedValueOnce({
      attempt: { shell: 'codex', provider: 'deepseek', ok: false, code: 'key_rejected' }, shells: {}
    } as never)
    await expect(rejected.service.open('deepseek', 'sk-rejected-fixture-key-1234567890')).resolves
      .toEqual({ ok: false, source: 'deepseek', code: 'key_rejected' })
    expect(rejected.installProviders).not.toHaveBeenCalled()
    expect(rejected.launch).not.toHaveBeenCalled()
    expect(rejected.openExternal).not.toHaveBeenCalled()
  })

  it('四个并发点击各带固定 provider，并按序创建以避开同一 CODEX_HOME 首次初始化竞争', async () => {
    const f = fixture()
    let active = 0
    let maximum = 0
    f.launch.mockImplementation(async (command, input) => {
      void command; void input
      active += 1; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { threadId: `01999999-1111-7111-8111-11111111111${String(f.launch.mock.calls.length)}` }
    })
    await Promise.all(['official', 'deepseek', 'moonshot', 'zhipu-api'].map(source => f.service.open(source)))
    expect(f.launch.mock.calls.map(call => call[1].source.provider)).toEqual([
      'openai', 'laixin-deepseek', 'laixin-kimi-api', 'laixin-zhipu-api'
    ])
    expect(maximum).toBe(1)
  })
})
