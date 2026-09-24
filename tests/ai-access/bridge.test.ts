import { describe, expect, it, vi } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerAiAccessActions } from '../../app/main/actions/ai-access'
import { AiAccessService, aiAccessShells, type AiAccessService as AiAccessServiceType } from '../../app/main/ai-access/service'
import { collectPreloadApis } from '../../app/preload/index'
import * as aiAccessApi from '../../app/preload/api/ai-access'

describe('AI 接入后台桥', () => {
  it('账号页只能通过受限的 AI 接入 API 调用本机能力', () => {
    expect(collectPreloadApis({ access: aiAccessApi })).toHaveProperty('aiaccess')
    expect(Object.keys(aiAccessApi.api).sort()).toEqual([
      'cancelClaudeOfficialLogin',
      'cancelCodexOfficialLogin',
      'cancelServiceTests',
      'claudeOfficialStatus',
      'codexOfficialStatus',
      'configureProvider',
      'environmentChecklist',
      'matrixStatus',
      'measureProviderLatency',
      'openProviderConsole',
      'probeMatrix',
      'providerBalance',
      'providerConfiguration',
      'recover',
      'remedy',
      'restartGuidance',
      'restorePreviousConnection',
      'saveProviderKey',
      'selectConfigurationProject',
      'selectConfigurationTarget',
      'serviceStatus',
      'startClaudeOfficialLogin',
      'startCodexOfficialLogin',
      'status',
      'submitClaudeLoginCode',
      'testProvider',
      'usageReceipt',
      'usageReceiptSave',
      'useOfficial',
      'useProvider',
      'useProviderWithKey',
      'verifyConfiguration'
    ])
  })

  it('重启提示经受限桥接：不回传进程细节或本机环境内容', async () => {
    const secret = 'fixture-key-and-proxy-address-must-not-cross-ipc'
    const restart = vi.fn(async () => ({ shell: 'codex' as const, process: 'running' as const, message: secret, pid: 99 }))
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { restartGuidance: { read: restart } })

    const guidance = await registry.execute('aiaccess.restartGuidance', { shell: 'codex' }) as { snapshot: string }
    expect(JSON.parse(guidance.snapshot)).toEqual({
      shell: 'codex', process: 'running', message: '检测到 Codex 正在运行。请彻底退出（Mac 请用“退出”或 ⌘Q）并重新打开 Codex 终端或 ChatGPT/Codex 桌面版，再发送一条消息。'
    })
    expect(guidance.snapshot).not.toContain(secret)

    await expect(registry.execute('aiaccess.restartGuidance', { shell: 'codex', pid: '99' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })

  it('27 条环境清单是固定公开说明，桥上不带能力实现细节或客户状态', async () => {
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)

    const response = await registry.execute('aiaccess.environmentChecklist', undefined) as { snapshot: string }
    const checklist = JSON.parse(response.snapshot) as Array<Record<string, unknown>>
    expect(checklist).toHaveLength(27)
    expect(checklist[0]).toEqual(expect.objectContaining({ id: 1, title: expect.any(String), detection: expect.any(Object), handling: expect.any(Object), safetyBoundaryReason: expect.any(String) }))
    expect(Object.keys(checklist[0]).sort()).toEqual(['detection', 'handling', 'id', 'safetyBoundaryReason', 'title'])
    expect(response.snapshot).not.toContain('capabilities')
    await expect(registry.execute('aiaccess.environmentChecklist', { id: 1 })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })

  it('只向界面返回脱敏状态，Key 只作为一次写入参数进入服务', async () => {
    const key = 'sk-toolbox-fixture-key-1234567890'
    const service = {
      status: vi.fn(async () => ({ shells: {} })),
      saveProviderKey: vi.fn(async () => ({ shells: {} })),
      useProvider: vi.fn(async () => ({ shells: {} }))
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)

    const saved = await registry.execute('aiaccess.saveProviderKey', { shell: 'claude', provider: 'kimi', key }) as { snapshot: string }
    await registry.execute('aiaccess.useProvider', { provider: 'kimi', shell: 'claude' })

    expect(service.saveProviderKey).toHaveBeenCalledWith('claude', 'kimi', key)
    expect(service.useProvider).toHaveBeenCalledWith('claude', 'kimi')
    expect(saved.snapshot).not.toContain(key)
  })

  it('拒绝未知壳和越界参数', async () => {
    const service = {
      status: vi.fn(async () => ({ shells: {} })),
      saveProviderKey: vi.fn(), useProvider: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)

    await expect(registry.execute('aiaccess.useProvider', { provider: 'kimi', shell: 'other' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.useOfficial', { shell: 'other' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.useProvider', { provider: 'other', shell: 'codex' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    const key = 'sk-toolbox-fixture-key-1234567890'
    await expect(registry.execute('aiaccess.saveProviderKey', { provider: 'kimi', key })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
    await expect(registry.execute('aiaccess.saveProviderKey', { provider: 'kimi', shell: 'other', key })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(service.saveProviderKey).not.toHaveBeenCalled()
    await expect(registry.execute('aiaccess.saveProviderKey', { shell: 'codex', provider: 'kimi', key, extra: true })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })

  it('Codex 官方登录只回传当前状态，不把授权地址或登录态带回界面', async () => {
    const service = {
      status: vi.fn(async () => ({ shells: {} })),
      saveProviderKey: vi.fn(), useProvider: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const login = {
      status: vi.fn(() => ({ status: 'idle' as const })),
      start: vi.fn(async () => ({ status: 'pending' as const })),
      cancel: vi.fn(async () => ({ status: 'idle' as const }))
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, login)

    const response = await registry.execute('aiaccess.startCodexOfficialLogin', undefined) as { snapshot: string }
    expect(login.start).toHaveBeenCalledOnce()
    expect(response.snapshot).toBe('{"status":"pending"}')
  })

  it('模型 API 页可通过受限动作恢复官方配置', async () => {
    const service = {
      status: vi.fn(), saveProviderKey: vi.fn(), useProvider: vi.fn(), cancelTests: vi.fn(() => 0),
      useOfficial: vi.fn(async () => ({ shells: {
        codex: { selected: null, officialAvailable: true, providerKeys: { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false } },
        claude: { selected: 'official' as const, officialAvailable: true, providerKeys: { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false } },
        hermes: { selected: null, officialAvailable: false, providerKeys: { deepseek: false, 'zhipu-api': false, zhipu: false, moonshot: false, kimi: false } }
      } }))
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)
    await registry.execute('aiaccess.useOfficial', { shell: 'claude' })
    expect(service.useOfficial).toHaveBeenCalledWith('claude')
  })

  it('桥只允许 Claude Code 确认项目级目标，Codex 项目诊断不能变成写入目标', async () => {
    const selected: string[] = []
    const state = { version: 1 as const, selected: {} }
    const service = new AiAccessService(
      { read: async () => state, write: async () => undefined },
      aiAccessShells.map(shell => ({
        shell,
        applyDeepSeek: async () => undefined,
        configurationTargetStatus: async () => shell === 'codex'
          ? ({ shell, scope: 'user' as const, override: 'none' as const, writable: true, reason: 'project-configuration-ignored' as const })
          : ({ shell, scope: 'project' as const, override: 'project' as const, writable: false, reason: 'project-config-overrides-user' as const }),
        selectConfigurationTarget: async (scope: 'user' | 'project') => {
          selected.push(`${shell}:${scope}`)
          return { shell, scope, override: 'project' as const, writable: scope === 'project', reason: 'project-config-overrides-user' as const }
        }
      }))
    )
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)

    await expect(registry.execute('aiaccess.selectConfigurationTarget', { shell: 'codex', scope: 'project' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(selected).toEqual([])
    const response = JSON.parse(((await registry.execute('aiaccess.selectConfigurationTarget', { shell: 'claude', scope: 'project' })) as { snapshot: string }).snapshot)
    expect(selected).toEqual(['claude:project'])
    expect(response.configurationTargets.claude).toEqual(expect.objectContaining({ shell: 'claude', scope: 'project', writable: true }))
    await expect(registry.execute('aiaccess.selectConfigurationTarget', { shell: 'codex', scope: 'everywhere' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.selectConfigurationTarget', { shell: 'codex', scope: 'project', path: '/private' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })
})
