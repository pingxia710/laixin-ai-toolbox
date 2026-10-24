import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { CODEX_ISOLATION_HEALTH_INTERVAL_MS, registerAiAccessActions } from '../../app/main/actions/ai-access'
import { AiAccessService, aiAccessShells, type AiAccessService as AiAccessServiceType } from '../../app/main/ai-access/service'
import { ApplicationIsolationLeaseController, type ApplicationIsolationAdapter } from '../../app/main/ai-access/application-isolation-lease'
import { shellConfigFixture } from './fixtures/shell-config'
import { collectPreloadApis } from '../../app/preload/index'
import * as aiAccessApi from '../../app/preload/api/ai-access'

afterEach(() => { vi.useRealTimers() })

describe('AI 接入后台桥', () => {
  it('账号页只能通过受限的 AI 接入 API 调用本机能力', () => {
    expect(collectPreloadApis({ access: aiAccessApi })).toHaveProperty('aiaccess')
    expect(Object.keys(aiAccessApi.api).sort()).toEqual([
      'aiRouterStatus',
      'cancelClaudeOfficialLogin',
      'cancelCodexOfficialLogin',
      'cancelServiceTests',
      'claudeIsolationStatus',
      'claudeOfficialStatus',
      'codexIsolationStatus',
      'codexOfficialStatus',
      'configureCodexMultiModel',
      'configureProvider',
      'disableClaudeIsolation',
      'disableCodexIsolation',
      'disableHermesIsolation',
      'enableClaudeIsolation',
      'enableCodexIsolation',
      'enableHermesIsolation',
      'environmentChecklist',
      'hermesIsolationStatus',
      'matrixStatus',
      'measureProviderLatency',
      'openProviderConsole',
      'probeMatrix',
      'providerBalance',
      'providerConfiguration',
      'recover',
      'remedy',
      'removeCodexMultiModel',
      'repairCodexMultiModelRouter',
      'restartGuidance',
      'restorePreviousConnection',
      'saveProviderKey',
      'selectConfigurationProject',
      'selectConfigurationTarget',
      'serviceStatus',
      'setCodexMode',
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
      'verifyAndAddCodexMultiModel',
      'verifyConfiguration'
    ])
  })

  it('Codex 隔离桥只回传固定状态，绝不把入口、配置或原始异常交给页面', async () => {
    vi.useFakeTimers()
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const isolation = {
      status: vi.fn(() => ({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 4, available: false, code: 'RESTORED',
        proxyUrl: 'http://127.0.0.1:18080', config: 'private', error: 'raw error' } as const)),
      enable: vi.fn(async () => ({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 5, available: true, code: 'AVAILABLE' } as const)),
      disable: vi.fn(async () => ({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'disable', intentGeneration: 6, available: false, code: 'RESTORED' } as const)),
      recover: vi.fn(async () => ({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 7, available: false, code: 'RESTORED' } as const)),
      reverify: vi.fn(async () => ({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 5, available: false, code: 'TARGET_UNREACHABLE' } as const))
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { codexIsolation: isolation })

    const status = await registry.execute('aiaccess.codexIsolationStatus', undefined) as { snapshot: string }
    await registry.execute('aiaccess.enableCodexIsolation', undefined)
    await vi.advanceTimersByTimeAsync(CODEX_ISOLATION_HEALTH_INTERVAL_MS)
    await registry.execute('aiaccess.disableCodexIsolation', undefined)

    expect(JSON.parse(status.snapshot)).toEqual({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 4, available: false, code: 'RESTORED' })
    expect(status.snapshot).not.toContain('127.0.0.1')
    expect(status.snapshot).not.toContain('raw error')
    expect(isolation.enable).toHaveBeenCalledOnce()
    expect(isolation.disable).toHaveBeenCalledOnce()
    expect(isolation.reverify).toHaveBeenCalledOnce()
  })

  it('Hermes 隔离桥只接受 hermes/model-api-egress/http-connect，并且不泄露入口或六字段', async () => {
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const isolation = {
      status: vi.fn(() => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 2, available: false, code: 'RESTORED', proxyUrl: 'http://127.0.0.1:18080', config: 'model.api_key=private', error: 'raw error' } as const)),
      enable: vi.fn(async () => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 3, available: true, code: 'AVAILABLE' } as const)),
      disable: vi.fn(async () => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'disable', intentGeneration: 4, available: false, code: 'RESTORED' } as const)),
      recover: vi.fn(async () => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 5, available: false, code: 'RESTORED' } as const)),
      reverify: vi.fn(async () => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 3, available: false, code: 'TARGET_UNREACHABLE' } as const))
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { hermesIsolation: isolation })

    const status = await registry.execute('aiaccess.hermesIsolationStatus', undefined) as { snapshot: string }
    await registry.execute('aiaccess.enableHermesIsolation', undefined)
    await registry.execute('aiaccess.disableHermesIsolation', undefined)

    expect(JSON.parse(status.snapshot)).toEqual({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 2, available: false, code: 'RESTORED' })
    expect(status.snapshot).not.toMatch(/127\.0\.0\.1|model\.api_key|raw error/)
    expect(isolation.enable).toHaveBeenCalledOnce()
    expect(isolation.disable).toHaveBeenCalledOnce()
  })

  it('Hermes 配置是软链时，HERMES_HOME 与真身路径不跨状态 IPC', async () => {
    const privateHome = '/customer/private-hermes-home'
    const unsafeStatus = {
      shells: {}, attempt: {
        shell: 'hermes', provider: 'deepseek', ok: false, at: '2026-09-28T00:00:00.000Z', code: 'configuration_failed',
        notice: `配置文件是软链（链接在 ${privateHome}/config.yaml，真身在 /customer/dotfiles/hermes-config.yaml）`
      }, configurationTargets: {
        hermes: {
          shell: 'hermes', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration',
          symlink: { path: `${privateHome}/config.yaml`, target: '/customer/dotfiles/hermes-config.yaml' }
        }
      }
    }
    const service = {
      status: vi.fn(async () => unsafeStatus), saveProviderKey: vi.fn(), useProvider: vi.fn(async () => unsafeStatus), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service)

    const response = await registry.execute('aiaccess.status', undefined) as { snapshot: string }
    const action = await registry.execute('aiaccess.useProvider', { shell: 'hermes', provider: 'deepseek' }) as { snapshot: string }
    for (const snapshot of [response.snapshot, action.snapshot]) {
      expect(snapshot).not.toContain(privateHome)
      expect(snapshot).not.toContain('/customer/dotfiles')
      expect(JSON.parse(snapshot).attempt.notice).toBe('Hermes 的有效受控配置无法确认；没有改写任何配置。')
      expect(JSON.parse(snapshot).configurationTargets.hermes).toEqual({
        shell: 'hermes', scope: 'unknown', override: 'unknown', writable: false, reason: 'symlinked-configuration'
      })
    }
  })

  it('正式 bridge 更换 Hermes Key 前会同步撤销租约，页面不会继续显示 available', async () => {
    const fixture = shellConfigFixture()
    try {
      await fixture.service.useProviderWithKey('hermes', 'deepseek', 'sk-hermes-bridge-original-key-1234567890')
      const egress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
      const isolation = new ApplicationIsolationLeaseController({
        applicationId: 'hermes',
        adapter: fixture.service.createHermesIsolationAdapter(egress),
        system: { snapshot: vi.fn(async () => 'read-only-system-path') },
        entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
      })
      const registry = new BridgeRegistry()
      registerAiAccessActions(registry, fixture.service, undefined, undefined, undefined, { hermesIsolation: isolation })

      await registry.execute('aiaccess.enableHermesIsolation', undefined)
      expect(isolation.status()).toMatchObject({ available: true, code: 'AVAILABLE' })
      fixture.fetcher.mockClear()

      await registry.execute('aiaccess.useProviderWithKey', {
        shell: 'hermes', provider: 'deepseek', key: 'sk-hermes-bridge-replacement-key-1234567890'
      })
      const status = await registry.execute('aiaccess.hermesIsolationStatus', undefined) as { snapshot: string }

      expect(JSON.parse(status.snapshot)).toMatchObject({ available: false, code: 'RESTORED' })
      expect(egress.deactivate).toHaveBeenCalledOnce()
      const calls = fixture.fetcher.mock.calls as unknown as readonly (readonly unknown[])[]
      expect(calls.some(call => (call[2] as { shell?: string; isolated?: boolean } | undefined)?.shell === 'hermes' &&
        (call[2] as { isolated?: boolean }).isolated === true)).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })

  it.each(['restore', 'deactivate', 'clear lease'] as const)(
    'Hermes 隔离的 %s 撤销失败后，重复正式配置操作仍不能绕过 RESTORE_FAILED',
    async (failure) => {
      const fixture = shellConfigFixture()
      try {
        await fixture.service.useProviderWithKey('hermes', 'deepseek', 'sk-hermes-restore-failure-original-key-1234567890')
        const egress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
        const base = fixture.service.createHermesIsolationAdapter(egress)
        const adapter: ApplicationIsolationAdapter = {
          ...base,
          capture: async () => {
            const captured = await base.capture()
            return failure === 'restore'
              ? { ...captured, restoreIfOwned: async () => { throw new Error('fixture restore failed') } }
              : captured
          },
          deactivateEntry: failure === 'deactivate'
            ? async () => { throw new Error('fixture deactivate failed') }
            : base.deactivateEntry,
          clearLease: failure === 'clear lease'
            ? async () => { throw new Error('fixture clear lease failed') }
            : base.clearLease
        }
        const isolation = new ApplicationIsolationLeaseController({
          applicationId: 'hermes', adapter,
          system: { snapshot: vi.fn(async () => 'read-only-system-path') },
          entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
        })
        const registry = new BridgeRegistry()
        registerAiAccessActions(registry, fixture.service, undefined, undefined, undefined, { hermesIsolation: isolation })
        await expect(registry.execute('aiaccess.enableHermesIsolation', undefined)).resolves.toBeDefined()
        expect(isolation.status()).toMatchObject({ available: true, code: 'AVAILABLE' })
        const write = vi.spyOn(fixture.service, 'useProviderWithKey')
        const params = { shell: 'hermes', provider: 'deepseek', key: 'sk-hermes-restore-failure-replacement-key-1234567890' }

        await expect(registry.execute('aiaccess.useProviderWithKey', params)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
        expect(isolation.status()).toMatchObject({ available: false, code: 'RESTORE_FAILED' })
        await expect(registry.execute('aiaccess.useProviderWithKey', params)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
        expect(isolation.status()).toMatchObject({ available: false, code: 'RESTORE_FAILED' })
        expect(write).not.toHaveBeenCalled()
      } finally {
        await fixture.dispose()
      }
    }
  )

  it('Hermes 隔离租约撤销失败时，正式 bridge 不继续写新的 provider 配置', async () => {
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(async () => ({ shells: {} })), useOfficial: vi.fn()
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const isolation = {
      status: vi.fn(() => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 1, available: false, code: 'RESTORE_FAILED' } as const)),
      enable: vi.fn(),
      disable: vi.fn(async () => ({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'disable', intentGeneration: 2, available: false, code: 'RESTORE_FAILED' } as const)),
      recover: vi.fn(), reverify: vi.fn()
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { hermesIsolation: isolation as never })

    await expect(registry.execute('aiaccess.useProvider', { shell: 'hermes', provider: 'deepseek' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(isolation.disable).toHaveBeenCalledOnce()
    expect(service.useProvider).not.toHaveBeenCalled()
  })

  it.each([
    ['缺失 application', { scope: 'model-api-egress' }],
    ['错误 application', { application: 'claude', scope: 'model-api-egress' }],
    ['缺失 scope', { application: 'codex' }],
    ['错误 scope', { application: 'codex', scope: 'all-egress' }]
  ])('Codex 隔离桥对%s fail closed', async (_name, binding) => {
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const malformed = { capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 0, available: false, code: 'RESTORED', ...binding }
    const isolation = { status: vi.fn(() => malformed), enable: vi.fn(async () => malformed), disable: vi.fn(async () => malformed), recover: vi.fn(async () => malformed), reverify: vi.fn(async () => malformed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { codexIsolation: isolation as never })

    await expect(registry.execute('aiaccess.codexIsolationStatus', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  })

  it('Claude 隔离桥只接受 Claude 模型 API 的固定 HTTP/CONNECT 合同，并在官方切换前撤销租约', async () => {
    const useOfficial = vi.fn(async () => ({ shells: {} }))
    const service = {
      status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(),
      useOfficial
    } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const isolation = {
      status: vi.fn(() => ({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 4, available: false, code: 'RESTORED',
        proxyUrl: 'http://127.0.0.1:18080', settings: 'private', key: 'fixture-key', error: 'raw error' } as const)),
      enable: vi.fn(async () => ({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'available', action: 'enable', intentGeneration: 5, available: true, code: 'AVAILABLE' } as const)),
      disable: vi.fn(async () => ({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'disable', intentGeneration: 6, available: false, code: 'RESTORED' } as const)),
      recover: vi.fn(async () => ({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 7, available: false, code: 'RESTORED' } as const)),
      reverify: vi.fn(async () => ({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 5, available: false, code: 'TARGET_UNREACHABLE' } as const))
    }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { claudeIsolation: isolation })

    const status = await registry.execute('aiaccess.claudeIsolationStatus', undefined) as { snapshot: string }
    await registry.execute('aiaccess.enableClaudeIsolation', undefined)
    await registry.execute('aiaccess.useOfficial', { shell: 'claude' })

    expect(JSON.parse(status.snapshot)).toEqual({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 4, available: false, code: 'RESTORED' })
    expect(status.snapshot).not.toContain('127.0.0.1')
    expect(status.snapshot).not.toContain('fixture-key')
    expect(isolation.disable.mock.invocationCallOrder[0]).toBeLessThan(useOfficial.mock.invocationCallOrder[0]!)
  })

  it.each([
    ['Codex', 'codex'],
    ['Claude', 'claude']
  ])('%s 隔离桥拒绝自相矛盾的 available 状态', async (_label, application) => {
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const malformed = { application, scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'health', intentGeneration: 1, available: true, code: 'TARGET_UNREACHABLE' }
    const isolation = { status: vi.fn(() => malformed), enable: vi.fn(async () => malformed), disable: vi.fn(async () => malformed), recover: vi.fn(async () => malformed), reverify: vi.fn(async () => malformed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, application === 'codex' ? { codexIsolation: isolation as never } : { claudeIsolation: isolation as never })

    await expect(registry.execute(application === 'codex' ? 'aiaccess.codexIsolationStatus' : 'aiaccess.claudeIsolationStatus', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  })

  it('Claude 租约恢复失败时阻断官方配置改写，而不把停 transport 误作安全撤销', async () => {
    const useOfficial = vi.fn(async () => ({ shells: {} }))
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const failed = { application: 'claude', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', phase: 'limited', action: 'disable', intentGeneration: 5, available: false, code: 'RESTORE_FAILED' } as const
    const isolation = { status: vi.fn(() => failed), enable: vi.fn(async () => failed), disable: vi.fn(async () => failed), recover: vi.fn(async () => failed), reverify: vi.fn(async () => failed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { claudeIsolation: isolation })

    await expect(registry.execute('aiaccess.useOfficial', { shell: 'claude' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(useOfficial).not.toHaveBeenCalled()
  })

  it.each([
    ['错误 application', { application: 'codex', scope: 'model-api-egress', capability: 'http-connect' }],
    ['错误 scope', { application: 'claude', scope: 'all-egress', capability: 'http-connect' }],
    ['错误 capability', { application: 'claude', scope: 'model-api-egress', capability: 'socks5' }]
  ])('Claude 隔离桥对%s fail closed', async (_name, binding) => {
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const malformed = { mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 0, available: false, code: 'RESTORED', ...binding }
    const isolation = { status: vi.fn(() => malformed), enable: vi.fn(async () => malformed), disable: vi.fn(async () => malformed), recover: vi.fn(async () => malformed), reverify: vi.fn(async () => malformed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { claudeIsolation: isolation as never })

    await expect(registry.execute('aiaccess.claudeIsolationStatus', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  })

  it.each([
    ['错误 application', { application: 'codex', scope: 'model-api-egress', capability: 'http-connect' }],
    ['错误 scope', { application: 'hermes', scope: 'all-egress', capability: 'http-connect' }],
    ['错误 capability', { application: 'hermes', scope: 'model-api-egress', capability: 'socks5' }]
  ])('Hermes 隔离桥对%s fail closed', async (_name, binding) => {
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const malformed = { mode: 'disabled', systemNetwork: 'unmanaged', phase: 'restored', action: 'recover', intentGeneration: 0, available: false, code: 'RESTORED', ...binding }
    const isolation = { status: vi.fn(() => malformed), enable: vi.fn(async () => malformed), disable: vi.fn(async () => malformed), recover: vi.fn(async () => malformed), reverify: vi.fn(async () => malformed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { hermesIsolation: isolation as never })

    await expect(registry.execute('aiaccess.hermesIsolationStatus', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  })

  it.each([
    ['available 却不是 AVAILABLE', { mode: 'disabled', phase: 'restored', available: true, code: 'RESTORED' }],
    ['AVAILABLE 却落在 limited', { mode: 'application-only', phase: 'limited', available: false, code: 'AVAILABLE' }],
    ['RESTORED 却仍是 application-only', { mode: 'application-only', phase: 'available', available: false, code: 'RESTORED' }],
    ['普通错误却不是 application-only/limited', { mode: 'disabled', phase: 'restored', available: false, code: 'TARGET_UNREACHABLE' }]
  ])('Hermes 隔离桥拒绝矛盾状态：%s', async (_name, contradiction) => {
    const service = { status: vi.fn(async () => ({ shells: {} })), saveProviderKey: vi.fn(), useProvider: vi.fn(), useOfficial: vi.fn() } as unknown as Pick<AiAccessServiceType, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
    const malformed = { application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', systemNetwork: 'unmanaged', action: 'health', intentGeneration: 1, ...contradiction }
    const isolation = { status: vi.fn(() => malformed), enable: vi.fn(async () => malformed), disable: vi.fn(async () => malformed), recover: vi.fn(async () => malformed), reverify: vi.fn(async () => malformed) }
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, service, undefined, undefined, undefined, { hermesIsolation: isolation as never })

    await expect(registry.execute('aiaccess.hermesIsolationStatus', undefined)).rejects.toMatchObject({ code: 'ACTION_FAILED' })
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
