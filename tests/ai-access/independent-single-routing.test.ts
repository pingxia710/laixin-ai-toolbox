import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

const gateways: AiGateway[] = []
afterEach(async () => { for (const gateway of gateways.splice(0)) await gateway.stop() })

function fixture(multi = false, pending = false) {
  let state: AiAccessState = { version: 1, selected: { codex: 'deepseek', hermes: 'deepseek' },
    relay: { port: 43211, token: 'a'.repeat(64) }, relayShells: ['codex', 'hermes'],
    ...(pending ? { pendingShells: ['codex', 'hermes'] as const } : {}),
    ...(multi ? { codexMode: 'multi' as const, codexMultiModelPool: [{ provider: 'deepseek' as const, model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }] } : {}),
    shellKeys: { codex: { deepseek: 'sk-fixture-codex-0123456789' }, hermes: { deepseek: 'sk-fixture-hermes-0123456789' } } }
  const gateway = new AiGateway()
  gateways.push(gateway)
  const start = vi.spyOn(gateway, 'start')
  vi.spyOn(gateway, 'probe').mockResolvedValue({ ok: true })
  const stop = vi.fn(async () => true)
  const refresh = vi.fn<(state: AiAccessState) => Promise<boolean>>(async () => true)
  const ensureReady = vi.fn(async (current: AiAccessState) => ({
    baseUrl: `http://127.0.0.1:${current.codexMultiRelay!.port}`,
    runtime: { port: current.codexMultiRelay!.port, token: 'b'.repeat(64), pid: 123, bootId: 'c'.repeat(32) }
  }))
  const service = new AiAccessService({ read: async () => state, write: async next => { state = next } },
    aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined,
      captureConnection: async () => async () => undefined, deactivateToolboxConnection: async () => undefined })),
    gateway, { independentRouting: true }, { ensureReady, refresh, stop, probe: async () => true,
      gatewaySnapshot: async () => undefined } as unknown as AiRouterController)
  return { service, start, stop, refresh, ensureReady, state: () => state }
}

describe('API-13 independent single-model runtime', () => {
  it('旧单模型配置在初始化时交给独立路由，原端口、令牌和 Key 保留，GUI 不监听', async () => {
    const f = fixture()
    await f.service.initialize()
    expect(f.refresh).toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.state().relay).toEqual({ port: 43211, token: 'a'.repeat(64) })
    expect(f.state().shellKeys?.hermes?.deepseek).toBe('sk-fixture-hermes-0123456789')
    await f.service.stop()
    expect(f.stop).not.toHaveBeenCalled()
    await f.service.initialize()
    expect(f.start).not.toHaveBeenCalled()
  })

  it('解除 Codex 单模型不停止仍被 Hermes 使用的独立路由', async () => {
    const f = fixture()
    await f.service.initialize()
    await f.service.useOfficial('codex')
    expect(f.state().selected.hermes).toBe('deepseek')
    expect(f.state().relayShells).toEqual(['hermes'])
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.refresh).toHaveBeenCalled()
  })

  it('解除最后客户端后重开 GUI 不唤起空路由，已存 Key 和端口仍保留', async () => {
    const f = fixture()
    await f.service.initialize()
    await f.service.useOfficial('codex')
    await f.service.useOfficial('hermes')
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.state().relayShells).toEqual([])
    expect(f.state().shellKeys?.hermes?.deepseek).toBe('sk-fixture-hermes-0123456789')
    expect(f.state().relay?.port).toBe(43211)
    await f.service.stop()
    f.ensureReady.mockClear()
    f.refresh.mockClear()
    await f.service.initialize()
    expect(f.ensureReady).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })

  it('未完成配置的客户端重开时仍保留独立路由的暂停回应', async () => {
    const f = fixture(false, true)
    await f.service.initialize()
    expect(f.refresh).toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.state().pendingShells).toEqual(['codex', 'hermes'])
  })

  it('独立路由更新失败仍保留旧 Key，并向路由恢复旧绑定', async () => {
    const f = fixture()
    await f.service.initialize()
    f.refresh.mockResolvedValueOnce(false).mockResolvedValue(true)
    await expect(f.service.verifyAndSaveProviderKey('codex', 'deepseek', 'sk-fixture-new-0123456789')).rejects.toThrow('AI_ROUTER_REFRESH_FAILED')
    expect(f.state().shellKeys?.codex?.deepseek).toBe('sk-fixture-codex-0123456789')
    expect(f.refresh.mock.calls.at(-1)?.[0].shellKeys?.codex?.deepseek).toBe('sk-fixture-codex-0123456789')
  })

  it.each(['official', 'remove'] as const)('解除 Codex 多模型或移除最后模型时 Hermes 保持接入：%s', async action => {
    const f = fixture(true)
    await f.service.initialize()
    if (action === 'official') await f.service.useOfficial('codex')
    else await f.service.removeCodexMultiModel('deepseek')
    expect(f.state().selected.hermes).toBe('deepseek')
    expect(f.state().relayShells).toContain('hermes')
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.refresh.mock.calls.at(-1)?.[0].codexMode).toBe('single')
  })
})
