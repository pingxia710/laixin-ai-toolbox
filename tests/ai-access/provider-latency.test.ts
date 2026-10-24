import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'
import { isProviderShellSupported, modelProviderIds, modelProviders, providerShellContract } from '../../app/shared/model-providers'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerAiAccessActions } from '../../app/main/actions/ai-access'

afterEach(() => vi.restoreAllMocks())
const key = 'sk-isolated-latency-key-1234567890'
function fixture(fetcher: typeof fetch, resolveRoute?: () => { endpoint: string; model: string }) {
  const state: AiAccessState = { version: 1, shellKeys: { codex: { deepseek: key } }, selected: { codex: 'deepseek' } }
  const store = { read: vi.fn(async () => state), write: vi.fn(async () => undefined) }
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined), applyConnection: vi.fn(async () => undefined) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 50 })
  const service = new AiAccessService(store, adapters, gateway, { resolveRoute })
  return { service, gateway, store, adapters }
}
function reply(shell: 'codex' | 'claude' | 'hermes'): Response {
  const frames = shell === 'codex' ? [{ type: 'response.created' }, { type: 'response.output_text.delta', delta: ' ' }, { type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed' }]
    : shell === 'claude' ? [{ type: 'message_start' }, { type: 'content_block_delta', delta: { text: 'OK' } }, { type: 'message_stop' }]
      : [{ choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: { content: 'OK' } }] }, { choices: [{ finish_reason: 'stop' }] }]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('API 响应测速与编辑元数据', () => {
  it.each(aiAccessShells)('%s 通过配对协议发一次请求；只计算首段有效回复，不保存、不切换、不启动监听', async shell => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(shell))
    const f = fixture(fetcher)
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(173)
    const result = await f.service.measureProviderLatency(shell, 'deepseek', key)
    expect(result).toEqual({ ok: true, latencyMs: 73 })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.lastCall!
    expect(url).toBe(modelProviders.deepseek.endpoints[shell])
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, model: modelProviders.deepseek.models[shell] })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.adapters.every(a => a.applyConnection.mock.calls.length === 0 && a.applyDeepSeek.mock.calls.length === 0)).toBe(true)
    expect(f.gateway.baseUrl).toBeNull()
    // 测速不应把旧直连状态伪装成已经接管的本机路由。
    expect((await f.service.status()).shells.codex).toMatchObject({
      selected: null,
      legacyDirect: { provider: 'deepseek', reason: 'not-managed-by-current-gateway' }
    })
    expect(JSON.stringify(f.gateway.snapshot())).not.toContain(key)
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ source: 'test', shell, provider: 'deepseek' })
  })
  it('留空只用当前壳的 Key，不借用别的壳；新输入 Key 只用于本次测试', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply('codex'))
    const f = fixture(fetcher)
    expect(await f.service.measureProviderLatency('hermes', 'deepseek', '')).toMatchObject({ ok: false, code: 'key_missing', latencyMs: null })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await f.service.measureProviderLatency('codex', 'deepseek', '')).toMatchObject({ ok: true })
    const replacement = 'sk-isolated-new-key-1234567890'
    await f.service.measureProviderLatency('codex', 'deepseek', replacement)
    expect(new Headers(fetcher.mock.lastCall![1]?.headers).get('authorization')).toBe(`Bearer ${replacement}`)
    expect(await f.service.providerKey('codex', 'deepseek')).toBe(key)
    expect(f.store.write).not.toHaveBeenCalled()
  })
  it.each([401, 402, 429, 500])('HTTP %s 不显示成功耗时或上游原文', async status => {
    const f = fixture(async () => new Response(`private ${key}`, { status }))
    const result = await f.service.measureProviderLatency('codex', 'deepseek', key)
    expect(result).toMatchObject({ ok: false, latencyMs: null })
    expect(JSON.stringify(result)).not.toContain(key)
  })
  it('空回复、错误流、超时均失败，不能把首包或 HTTP 200 当成功', async () => {
    for (const body of ['data: {"type":"response.completed"}\n\n', 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"error"}\n\n']) {
      const f = fixture(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
      expect(await f.service.measureProviderLatency('codex', 'deepseek', key)).toMatchObject({ ok: false, latencyMs: null })
    }
    const f = fixture(async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(Error('abort')), { once: true }) }))
    expect(await f.service.measureProviderLatency('codex', 'deepseek', key)).toEqual({ ok: false, latencyMs: null, code: 'timeout' })
  })
  it('编辑只读取已原生验收的壳/产品配方而非界面硬编码，不暴露 Key，不请求上游', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const f = fixture(fetcher)
    for (const shell of aiAccessShells) for (const provider of modelProviderIds) {
      if (!isProviderShellSupported(provider, shell)) continue
      const contract = providerShellContract(provider, shell)
      if (contract.status !== 'supported') throw new Error('fixture contract mismatch')
      expect(await f.service.providerConfiguration(shell, provider)).toMatchObject({
        keyUrl: modelProviders[provider].keyUrl, endpoint: contract.endpoint, model: contract.defaultModel,
        models: expect.arrayContaining([...contract.models])
      })
    }
    // 配方可以更新官方端点，但不能把一个不在产品合同里的模型塞进客户配置。
    const updated = fixture(fetcher, () => ({ endpoint: 'https://api.deepseek.com/updated/responses', model: 'updated-model' }))
    expect(await updated.service.providerConfiguration('codex', 'deepseek')).toMatchObject({ endpoint: 'https://api.deepseek.com/updated/responses', model: 'deepseek-flash' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(f.store.write).not.toHaveBeenCalled()
  })
  it('IPC 限定壳/服务商，不接受用户请求地址；测速参数不回传 Key', async () => {
    const f = fixture(async () => reply('codex'))
    const registry = new BridgeRegistry()
    registerAiAccessActions(registry, f.service)
    const params = { shell: 'codex', provider: 'deepseek', key, model: 'deepseek-v4-pro' }
    const result = await registry.execute('aiaccess.measureProviderLatency', params)
    expect(JSON.stringify(result)).not.toContain(key)
    await expect(registry.execute('aiaccess.measureProviderLatency', { ...params, endpoint: 'https://untrusted.example' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
    await expect(registry.execute('aiaccess.providerConfiguration', { shell: 'other', provider: 'deepseek' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.measureProviderLatency', { ...params, provider: 'other' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.measureProviderLatency', { ...params, model: 'kimi-k3' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.configureProvider', { ...params, model: '' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('aiaccess.configureProvider', { ...params, endpoint: 'https://untrusted.example' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
    const configure = vi.spyOn(f.service, 'configureProvider').mockResolvedValueOnce(await f.service.status())
    const configured = await registry.execute('aiaccess.configureProvider', params)
    expect(configure).toHaveBeenCalledWith('codex', 'deepseek', key, 'deepseek-v4-pro')
    expect(JSON.stringify(configured)).not.toContain(key)
  })
})
