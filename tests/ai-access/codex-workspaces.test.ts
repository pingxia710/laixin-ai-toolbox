import { describe, expect, it, vi } from 'vitest'
import { CodexWorkspaceService } from '../../app/main/ai-access/codex-workspaces'
import type { CodexCommand } from '../../app/main/codex-usage/runtime'
import type { CodexWorkspaceOfficialModel } from '../../app/main/ai-access/codex-workspace-config'
import type { CodexWorkspaceSource } from '../../app/main/ai-access/codex-workspace-sources'
import type { AiAccessStatus } from '../../app/main/ai-access/service'

function fixture() {
  const access = {
    codexOfficialLoginRoot: vi.fn(async () => '/customer/.codex'),
    codexMultiModelConnection: vi.fn<() => Promise<{ baseUrl: string; model: string; models: string[] } | undefined>>(async () => ({ baseUrl: 'http://127.0.0.1:43123/codex/multi/v1', model: 'laixin.deepseek.deepseek-flash', models: ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash'] })),
    status: vi.fn(async (): Promise<AiAccessStatus> => ({
      officialAuthentication: { codex: { state: 'official', reason: 'chatgpt-session' } },
      shells: { codex: { selected: 'official' } } as AiAccessStatus['shells']
    })),
    useOfficial: vi.fn(async (): Promise<AiAccessStatus> => ({
      officialAuthentication: { codex: { state: 'official', reason: 'chatgpt-session' } },
      shells: { codex: { selected: 'official' } } as AiAccessStatus['shells']
    }))
  }
  const findCommand = vi.fn<() => Promise<CodexCommand | null>>(async () => ({ executable: '/trusted/codex', args: ['app-server', '--listen', 'stdio://'] }))
  const officialModels = [officialModel('gpt-6-astra'), officialModel('gpt-6-sol')]
  const readOfficialModels = vi.fn(async () => officialModels)
  const installProviders = vi.fn(async () => undefined)
  const launch = vi.fn(async (command: CodexCommand, input: { codexHome: string; source: CodexWorkspaceSource }) => {
    void command; void input
    return { threadId: '01999999-1111-7111-8111-111111111111' }
  })
  const openExternal = vi.fn(async (url: string) => { void url })
  const service = new CodexWorkspaceService({ access, findCommand, readOfficialModels, installProviders, launch, openExternal })
  return { service, access, findCommand, readOfficialModels, installProviders, launch, openExternal, officialModels }
}

describe('Codex 单 provider 对话编排', () => {
  it('官方对话保持独立：不读多模型连接、不写第三方 provider 表', async () => {
    const f = fixture()
    await expect(f.service.open('official')).resolves.toEqual({ ok: true, source: 'official', code: 'opened' })
    expect(f.access.codexMultiModelConnection).not.toHaveBeenCalled()
    expect(f.readOfficialModels).not.toHaveBeenCalled()
    expect(f.installProviders).not.toHaveBeenCalled()
    expect(f.access.useOfficial).not.toHaveBeenCalled()
    expect(f.launch.mock.calls[0]?.[1].source).toMatchObject({ provider: 'openai' })
  })

  it('只创建一个 laixin-multi 对话，首轮使用池中模型且不切换官方或单模型选择', async () => {
    const f = fixture()
    await expect(f.service.open('multi')).resolves.toEqual({ ok: true, source: 'multi', code: 'opened' })
    expect(f.installProviders).toHaveBeenCalledWith('/customer/.codex', {
      baseUrl: 'http://127.0.0.1:43123/codex/multi/v1', model: 'laixin.deepseek.deepseek-flash',
      models: ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash']
    }, f.officialModels)
    expect(f.launch.mock.calls[0]?.[1].source).toMatchObject({
      provider: 'laixin-multi', model: 'laixin.deepseek.deepseek-flash'
    })
    expect(f.access.useOfficial).not.toHaveBeenCalled()
    expect(f.openExternal).toHaveBeenCalledWith('codex://threads/01999999-1111-7111-8111-111111111111')
  })

  it('模型池为空或 Codex 未安装时不写配置、不建线程', async () => {
    const empty = fixture()
    empty.access.codexMultiModelConnection.mockResolvedValueOnce(undefined)
    await expect(empty.service.open('multi')).resolves.toEqual({ ok: false, source: 'multi', code: 'model_pool_empty' })
    expect(empty.installProviders).not.toHaveBeenCalled()
    expect(empty.launch).not.toHaveBeenCalled()

    const missing = fixture()
    missing.findCommand.mockResolvedValueOnce(null)
    await expect(missing.service.open('multi')).resolves.toEqual({ ok: false, source: 'multi', code: 'codex_not_installed' })
    expect(missing.access.codexMultiModelConnection).not.toHaveBeenCalled()
  })

  it('并发打开仍串行化，且绝不创建按供应商固定的三个对话', async () => {
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
    await Promise.all(['multi', 'multi'].map(source => f.service.open(source)))
    expect(f.launch.mock.calls.map(call => call[1].source.provider)).toEqual(['laixin-multi', 'laixin-multi'])
    expect(maximum).toBe(1)
  })
})

function officialModel(slug: string): CodexWorkspaceOfficialModel {
  return { slug, catalog: { slug } }
}
