import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../app/main/ai-access/service'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function fixture(initial: AiAccessState) {
  let state = initial
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }]
  }))
  const adapters = aiAccessShells.map(shell => ({
    shell,
    applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined))
  }))
  const gateway = new AiGateway({ fetch: fetcher })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  return { service: service as AiAccessService & {
    verifyAndAddCodexMultiModel(provider: 'deepseek' | 'zhipu-api' | 'zhipu', key: string): Promise<unknown>
    codexMultiModelConnection(): Promise<{ readonly baseUrl: string; readonly model: string; readonly models: readonly string[] } | undefined>
  }, gateway, fetcher, state: () => state }
}

describe('Codex 多模型池服务状态', () => {
  it('验证并加入第二家 Key 不改变单模型选择；目录快照、网关和状态共用同一精确映射', async () => {
    const oldKey = 'sk-fixture-single-deepseek-0123456789'
    const f = fixture({ version: 1, selected: { codex: 'deepseek' }, shellKeys: { codex: { deepseek: oldKey } } })

    await f.service.verifyAndAddCodexMultiModel('deepseek', oldKey)
    await f.service.verifyAndAddCodexMultiModel('zhipu-api', 'sk-fixture-multi-zhipu-api-0123456789')

    expect(f.state().selected.codex).toBe('deepseek')
    expect(f.state()).toMatchObject({ codexMode: 'multi', codexMultiModelPool: [
      { provider: 'deepseek', internalModelId: 'laixin.deepseek.deepseek-flash', model: 'deepseek-flash' },
      { provider: 'zhipu-api', internalModelId: 'laixin.zhipu-api.glm-5.3-flash', model: 'glm-5.3-flash' }
    ] })
    const safeStatus = await f.service.status()
    expect(safeStatus).toMatchObject({ codexMultiModel: { mode: 'multi', models: f.state().codexMultiModelPool } })
    expect(JSON.stringify(safeStatus)).not.toContain(oldKey)
    const connection = await f.service.codexMultiModelConnection()
    expect(connection).toMatchObject({ model: 'laixin.deepseek.deepseek-flash', models: f.state().codexMultiModelPool!.map(entry => entry.internalModelId) })
    // The native picker is now the actual app-server `model/list`; this only proves the gateway
    // route and installer receive the exact same pool snapshot, never a gateway /models substitute.
    expect(connection!.models).toEqual(f.state().codexMultiModelPool!.map(entry => entry.internalModelId))
  })

  it('失败验证不覆盖旧 Key 或已加入的池条目', async () => {
    const oldKey = 'sk-fixture-existing-deepseek-0123456789'
    const f = fixture({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: oldKey } },
      codexMode: 'multi',
      codexMultiModelPool: [{ provider: 'deepseek', internalModelId: 'laixin.deepseek.deepseek-flash', model: 'deepseek-flash' }]
    } as AiAccessState)
    f.fetcher.mockResolvedValueOnce(new Response('no', { status: 401 }))

    await f.service.verifyAndAddCodexMultiModel('deepseek', 'sk-fixture-rejected-deepseek-0123456789')

    expect(f.state().shellKeys?.codex?.deepseek).toBe(oldKey)
    expect(f.state().codexMultiModelPool).toEqual([{ provider: 'deepseek', internalModelId: 'laixin.deepseek.deepseek-flash', model: 'deepseek-flash' }])
  })

  it('池内模型缺少本地 Key 时不暴露路由，也不会请求上游', async () => {
    const f = fixture({
      version: 1,
      selected: {},
      codexMode: 'multi',
      codexMultiModelPool: [{ provider: 'deepseek', internalModelId: 'laixin.deepseek.deepseek-flash', model: 'deepseek-flash' }]
    })

    await f.service.initialize()
    expect(await f.service.codexMultiModelConnection()).toBeUndefined()
    const relay = f.state().relay!
    const response = await fetch(`${f.gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'laixin.deepseek.deepseek-flash', input: 'ping' })
    })

    expect(response.status).toBe(409)
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})
