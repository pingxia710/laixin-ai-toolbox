import { describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

describe('GUI owns multi-model state changes', () => {
  it('移除一个模型只刷新 headless；移除最后一个模型停止独立常驻', async () => {
    let state: AiAccessState = { version: 1, selected: {}, codexMode: 'multi',
      codexMultiRelay: { port: 43210, identitySecret: 'b'.repeat(64) },
      shellKeys: { codex: { deepseek: 'sk-fixture-deepseek-0123456789', 'zhipu-api': 'sk-fixture-zhipu-api-0123456789' } },
      codexMultiModelPool: [
        { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' },
        { provider: 'zhipu-api', model: 'glm-5.3-flash', internalModelId: 'laixin.zhipu-api.glm-5.3-flash' }
      ] }
    const refresh = vi.fn(async () => true)
    const stop = vi.fn(async () => true)
    const router = { refresh, stop, status: async () => ({ running: true, modelCount: 1,
      pid: 123, port: 43210, path: '/private/router', token: 'fixture-local-token' }) } as unknown as AiRouterController
    const service = new AiAccessService({ read: async () => state, write: async next => { state = next } },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), undefined, {}, router)
    await service.removeCodexMultiModel('deepseek')
    expect(state.codexMultiModelPool?.map(entry => entry.provider)).toEqual(['zhipu-api'])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    await service.removeCodexMultiModel('zhipu-api')
    expect(state.codexMode).toBe('single')
    expect(state.codexMultiModelPool).toEqual([])
    expect(stop).toHaveBeenCalledTimes(1)
    const safe = await service.aiRouterStatus()
    expect(safe).toEqual({ running: true, modelCount: 0, catalog: { state: 'missing' } })
    expect(JSON.stringify(safe)).not.toMatch(/sk-fixture|123|43210|private|fixture-local-token/)
  })

  it('更换池内 Key 后通知路由；通知失败则回滚加密状态与旧快照', async () => {
    const oldKey = 'sk-fixture-old-0123456789'
    const newKey = 'sk-fixture-new-0123456789'
    let state: AiAccessState = { version: 1, selected: {}, codexMode: 'multi',
      codexMultiRelay: { port: 43210, identitySecret: 'b'.repeat(64) },
      shellKeys: { codex: { deepseek: oldKey } },
      codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }] }
    const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const gateway = new AiGateway()
    vi.spyOn(gateway, 'probe').mockResolvedValue({ ok: true, firstTextMs: 1 })
    const service = new AiAccessService({ read: async () => state, write: async next => { state = next } },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), gateway, {},
      { refresh } as unknown as AiRouterController)
    await expect(service.verifyAndSaveProviderKey('codex', 'deepseek', newKey)).rejects.toThrow('AI_ROUTER_REFRESH_FAILED')
    expect(state.shellKeys?.codex?.deepseek).toBe(oldKey)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresh.mockResolvedValue(true)
    await service.verifyAndSaveProviderKey('codex', 'deepseek', newKey)
    expect(state.shellKeys?.codex?.deepseek).toBe(newKey)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('切回官方时停止路由失败则保持多模型状态并恢复原连接', async () => {
    let state: AiAccessState = { version: 1, selected: { codex: 'official' }, codexMode: 'multi',
      codexMultiRelay: { port: 43210, identitySecret: 'b'.repeat(64) },
      shellKeys: { codex: { deepseek: 'sk-fixture-old-0123456789' } },
      codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }] }
    const rollback = vi.fn(async () => undefined)
    const stop = vi.fn(async () => false)
    const service = new AiAccessService({ read: async () => state, write: async next => { state = next } },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined,
        activateOfficial: async () => undefined, captureConnection: async () => rollback })), undefined, {},
      { stop } as unknown as AiRouterController)
    await expect(service.useOfficial('codex')).rejects.toThrow('AI_ROUTER_STOP_FAILED')
    expect(state.codexMode).toBe('multi')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
  })
})
