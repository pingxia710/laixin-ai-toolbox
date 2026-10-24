import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

const oldKey = 'sk-fixture-old-0123456789'
const newKey = 'sk-fixture-new-0123456789'
const firstModel = 'laixin.deepseek.deepseek-flash'
const gateways: AiGateway[] = []

afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

function state(mode: 'single' | 'multi' = 'single'): AiAccessState {
  return {
    version: 1,
    selected: { codex: 'zhipu-api' },
    codexMode: mode,
    codexMultiRelay: { port: 43210, identitySecret: 'b'.repeat(64) },
    shellKeys: { codex: { deepseek: oldKey, 'zhipu-api': 'sk-fixture-zhipu-0123456789' } },
    codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: firstModel }]
  }
}

function serviceFixture(initial = state(), routerOverrides: Partial<AiRouterController> = {}, writeOverride?: (next: AiAccessState) => Promise<void>) {
  let stored = initial
  const writes: AiAccessState[] = []
  const refresh = vi.fn(async () => true)
  const stop = vi.fn(async () => true)
  const router = {
    refresh,
    stop,
    status: vi.fn(async () => ({ running: initial.codexMode === 'multi', modelCount: initial.codexMultiModelPool?.length ?? 0 })),
    ...routerOverrides
  } as unknown as AiRouterController
  const gateway = new AiGateway()
  vi.spyOn(gateway, 'probe').mockResolvedValue({ ok: true, firstTextMs: 1 })
  const service = new AiAccessService(
    { read: async () => stored, write: async next => {
      if (writeOverride) await writeOverride(next)
      stored = next; writes.push(next)
    } },
    aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })),
    gateway,
    {},
    router
  )
  return { service, gateway, router, refresh, stop, writes, state: () => stored }
}

describe('API-15R-C 模式与模型池事务', () => {
  it('single → multi → single 由受控主进程动作提交，池条目和单模型 selected 始终保留', async () => {
    const f = serviceFixture()
    const api = f.service as unknown as { setCodexMode(mode: 'single' | 'multi'): Promise<unknown> }

    await api.setCodexMode('multi')
    expect(f.state()).toMatchObject({ codexMode: 'multi', selected: { codex: 'zhipu-api' } })
    expect(f.state().codexMultiModelPool).toHaveLength(1)
    expect(f.refresh).toHaveBeenCalledTimes(1)

    await api.setCodexMode('single')
    expect(f.state()).toMatchObject({ codexMode: 'single', selected: { codex: 'zhipu-api' } })
    expect(f.state().codexMultiModelPool).toHaveLength(1)
    expect(f.stop).toHaveBeenCalledTimes(1)
  })

  it('已在 multi 时 setCodexMode 是纯幂等读，后台恢复只能走独立受控修复动作', async () => {
    const status = vi.fn(async () => ({ running: false, modelCount: 1, error: 'not_running' as const }))
    const f = serviceFixture(state('multi'), { status })
    await f.service.setCodexMode('multi')
    expect(f.refresh).not.toHaveBeenCalled()

    const repair = (f.service as unknown as { repairCodexMultiModelRouter?: () => Promise<unknown> }).repairCodexMultiModelRouter
    expect(repair).toBeTypeOf('function')
    if (!repair) return
    await expect(repair.call(f.service)).resolves.toEqual({ repaired: true })
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.state()).toEqual(state('multi'))
  })

  it('修复失败或不可自动恢复时保留原模式、池、绑定和路由', async () => {
    const original = state('multi')
    const failed = serviceFixture(original, {
      status: vi.fn(async () => ({ running: false, modelCount: 1, error: 'stale_route' as const })),
      refresh: vi.fn(async () => false)
    })
    const repairFailed = (failed.service as unknown as { repairCodexMultiModelRouter?: () => Promise<unknown> }).repairCodexMultiModelRouter
    expect(repairFailed).toBeTypeOf('function')
    if (!repairFailed) return
    await expect(repairFailed.call(failed.service)).rejects.toThrow('AI_ROUTER_REFRESH_FAILED')
    expect(failed.state()).toEqual(original)

    for (const error of ['port_conflict', 'protocol_incompatible'] as const) {
      const blocked = serviceFixture(original, { status: vi.fn(async () => ({ running: false, modelCount: 1, error })) })
      const repairBlocked = (blocked.service as unknown as { repairCodexMultiModelRouter: () => Promise<unknown> }).repairCodexMultiModelRouter
      await expect(repairBlocked.call(blocked.service)).resolves.toEqual({ repaired: false, reason: 'manual_intervention_required' })
      expect(blocked.refresh).not.toHaveBeenCalled()
      expect(blocked.state()).toEqual(original)
    }
  })

  it('空池不能切到 multi；启动、停止或状态提交失败均恢复原模式和原路由', async () => {
    const empty = serviceFixture({ ...state(), codexMultiModelPool: [] })
    await expect((empty.service as unknown as { setCodexMode(mode: 'multi'): Promise<unknown> }).setCodexMode('multi'))
      .rejects.toThrow('AI_ACCESS_MULTI_MODEL_POOL_EMPTY')
    expect(empty.state().codexMode).toBe('single')

    const startFailure = serviceFixture(state(), { refresh: vi.fn().mockResolvedValueOnce(false) })
    await expect((startFailure.service as unknown as { setCodexMode(mode: 'multi'): Promise<unknown> }).setCodexMode('multi'))
      .rejects.toThrow('AI_ROUTER_REFRESH_FAILED')
    expect(startFailure.state()).toEqual(state())

    const stopFailure = serviceFixture(state('multi'), { stop: vi.fn().mockResolvedValueOnce(false) })
    await expect((stopFailure.service as unknown as { setCodexMode(mode: 'single'): Promise<unknown> }).setCodexMode('single'))
      .rejects.toThrow('AI_ROUTER_STOP_FAILED')
    expect(stopFailure.state()).toEqual(state('multi'))

    const writeFailure = serviceFixture(state('multi'), {}, async () => { throw new Error('fixture write failed') })
    await expect((writeFailure.service as unknown as { setCodexMode(mode: 'single'): Promise<unknown> }).setCodexMode('single'))
      .rejects.toThrow('fixture write failed')
    expect(writeFailure.state()).toEqual(state('multi'))
    expect(writeFailure.stop).toHaveBeenCalledTimes(1)
    expect(writeFailure.refresh).toHaveBeenCalledWith(state('multi'))
  })

  it('池内编辑可留空复用旧 Key；候选失败保留旧 Key、旧模型、旧路由和单模型 selected', async () => {
    const f = serviceFixture(state('multi'))
    const api = f.service as unknown as {
      configureCodexMultiModel(provider: 'deepseek', key: string, model: string): Promise<unknown>
    }
    vi.mocked(f.gateway.probe).mockResolvedValueOnce({ ok: false, code: 'key_rejected' })
    await api.configureCodexMultiModel('deepseek', newKey, 'deepseek-v4-pro')
    expect(f.state()).toEqual(state('multi'))
    expect(f.refresh).not.toHaveBeenCalled()

    vi.mocked(f.gateway.probe).mockResolvedValueOnce({ ok: true, firstTextMs: 1 })
    await api.configureCodexMultiModel('deepseek', '', 'deepseek-v4-pro')
    expect(f.state().shellKeys?.codex?.deepseek).toBe(oldKey)
    expect(f.state().codexMultiModelPool).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4-pro', internalModelId: 'laixin.deepseek.deepseek-v4-pro' }
    ])
    expect(f.state().selected.codex).toBe('zhipu-api')
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it('移除池内模型会刷新路由并失效旧条目；最后一项移除回到 single、停止路由且保留已存 Key和 selected', async () => {
    const initial: AiAccessState = {
      ...state('multi'),
      shellKeys: { codex: { ...state('multi').shellKeys?.codex, 'zhipu-api': 'sk-fixture-zhipu-0123456789' } },
      codexMultiModelPool: [
        ...(state('multi').codexMultiModelPool ?? []),
        { provider: 'zhipu-api', model: 'glm-5.3-flash', internalModelId: 'laixin.zhipu-api.glm-5.3-flash' }
      ]
    }
    const f = serviceFixture(initial)
    await f.service.removeCodexMultiModel('deepseek')
    expect(f.state()).toMatchObject({ codexMode: 'multi', selected: { codex: 'zhipu-api' },
      codexMultiModelPool: [{ provider: 'zhipu-api' }] })
    expect(f.refresh).toHaveBeenCalledTimes(1)

    await f.service.removeCodexMultiModel('zhipu-api')
    expect(f.state()).toMatchObject({ codexMode: 'single', selected: { codex: 'zhipu-api' }, codexMultiModelPool: [],
      shellKeys: { codex: { deepseek: oldKey, 'zhipu-api': 'sk-fixture-zhipu-0123456789' } } })
    expect(f.stop).toHaveBeenCalledTimes(1)
  })
})

describe('API-15R-C 最近 Desktop 实际模型证据', () => {
  it('普通客户端完整成功但 Desktop attestation 未验证时不返回最近实际模型；验证后返回并随 revision 失效', async () => {
    let verified = false
    const gateway = new AiGateway({
      desktopAttestor: { observe: async () => verified
        ? { status: 'verified', at: '2026-09-27T00:00:00.000Z', reason: 'verified_socket_bound_desktop' }
        : { status: 'unverified', at: null, reason: 'socket_owner_not_codex_desktop' } },
      fetch: async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] })
    })
    gateways.push(gateway)
    await gateway.start(0, 'fixture-client-token-0123456789')
    const route = { provider: 'laixin-multi' as const, models: [{
      internalModelId: firstModel, provider: 'deepseek' as const, model: 'deepseek-flash',
      endpoint: 'https://fixture.invalid/responses', key: oldKey
    }] }
    gateway.setMultiModelRoute(route)
    const call = () => fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-client-token-0123456789' },
      body: JSON.stringify({ model: firstModel, input: 'fixture' })
    })

    expect((await call()).status).toBe(200)
    expect(await (gateway as unknown as { latestMultiModelDesktopUse(): Promise<unknown> }).latestMultiModelDesktopUse()).toBeUndefined()

    verified = true
    expect((await call()).status).toBe(200)
    expect(await (gateway as unknown as { latestMultiModelDesktopUse(): Promise<unknown> }).latestMultiModelDesktopUse()).toEqual({
      provider: 'deepseek', model: 'deepseek-flash', internalModelId: firstModel,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    })

    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [{ ...route.models[0], key: newKey }] })
    expect(await (gateway as unknown as { latestMultiModelDesktopUse(): Promise<unknown> }).latestMultiModelDesktopUse()).toBeUndefined()
  })
})
