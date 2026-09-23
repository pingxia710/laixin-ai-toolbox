import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState, type AiAccessShell } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

const oldKey = 'sk-fixture-old-kimi-key-012345'
const newKey = 'sk-fixture-new-kimi-key-0123456'

function reply(shell: AiAccessShell, second: boolean): Response {
  if (second) {
    const frames = shell === 'codex' ? [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 21, output_tokens: 2 } } }]
      : shell === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 2 } }]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const body = shell === 'codex' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }
    : shell === 'claude' ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] }
  return Response.json(body)
}

/** 与 service-routing 同一形态的隔离夹具；上游状态码可在用例中途切换。 */
function fixture(initial: AiAccessState) {
  let state = initial
  let upstreamStatus = 200
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (upstreamStatus !== 200) return new Response('private provider detail', { status: upstreamStatus })
    const endpoint = String(url)
    const shell = endpoint.endsWith('/responses') ? 'codex' : endpoint.endsWith('/messages') ? 'claude' : 'hermes'
    return reply(shell, JSON.parse(String(init?.body)).stream === true)
  })
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000 })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  return { service, adapters, fetcher, gateway, state: () => state, setUpstreamStatus: (next: number) => { upstreamStatus = next } }
}

describe('快捷表单换 Key 的原子性（API-06 复核）', () => {
  it('未启用来源换 Key 成功：客户已存的非默认模型保持不变，新 Key 生效且真正到达上游', async () => {
    const f = fixture({ version: 1, selected: {},
      shellKeys: { claude: { kimi: oldKey } },
      shellModels: { claude: { kimi: 'k3-256k' } } })
    const status = await f.service.useProviderWithKey('claude', 'kimi', newKey)
    expect(status.attempt).toMatchObject({ ok: true, shell: 'claude', provider: 'kimi' })
    const state = f.state()
    // 新 Key 落盘、配置写入；模型仍是 k3-256k，⛔ 被默认 kimi-for-coding 盖掉。
    expect(state.shellKeys?.claude?.kimi).toBe(newKey)
    expect(state.shellModels?.claude?.kimi).toBe('k3-256k')
    expect(state.selected.claude).toBe('kimi')
    expect(f.adapters[1].applyConnection.mock.lastCall?.[1].model).toBe('k3-256k')
    // 真实客户端调用到达上游时带的是新 Key，且模型仍是已存的 k3-256k。
    const token = state.relay?.token
    expect(typeof token).toBe('string')
    await fetch(`${f.gateway.baseUrl!}/claude/kimi/v1/messages?beta=true`, {
      method: 'POST', headers: { authorization: `Bearer ${token!}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unknown-model', messages: [] })
    })
    expect(f.fetcher.mock.lastCall?.[1]?.headers).toMatchObject({ authorization: `Bearer ${newKey}` })
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('k3-256k')
  })

  it('未启用来源换 Key 探测失败：新 Key ⛔ 留在本地，原 Key、原模型、原状态全部原样', async () => {
    const f = fixture({ version: 1, selected: {},
      shellKeys: { claude: { kimi: oldKey } },
      shellModels: { claude: { kimi: 'k3-256k' } } })
    f.setUpstreamStatus(401)
    const status = await f.service.useProviderWithKey('claude', 'kimi', newKey)
    expect(status.attempt).toMatchObject({ ok: false, shell: 'claude', provider: 'kimi', code: 'key_rejected' })
    const state = f.state()
    expect(state.shellKeys?.claude?.kimi).toBe(oldKey)
    expect(state.shellModels?.claude?.kimi).toBe('k3-256k')
    expect(state.selected.claude).toBeUndefined()
    expect(state.relayShells).toBeUndefined()
    // 候选 Key 没有出现在任何持久状态里；也没有产生任何路由。
    expect(JSON.stringify(state)).not.toContain(newKey)
    expect(f.gateway.snapshot().routes.find(route => route.shell === 'claude')).toBeUndefined()
    expect(f.adapters[1].applyConnection).not.toHaveBeenCalled()
  })

  it('已启用来源换 Key 失败：原路由、原 Key、原模型、客户端令牌全部保持不变', async () => {
    const f = fixture({ version: 1, selected: { claude: 'kimi' },
      shellKeys: { claude: { kimi: oldKey } },
      shellModels: { claude: { kimi: 'k3-256k' } } })
    const enabled = await f.service.useProvider('claude', 'kimi')
    expect(enabled.attempt).toMatchObject({ ok: true })
    const liveRouteBefore = f.gateway.snapshot().routes.find(route => route.shell === 'claude')
    expect(liveRouteBefore).toBeDefined()
    f.setUpstreamStatus(401)
    const status = await f.service.useProviderWithKey('claude', 'kimi', newKey)
    expect(status.attempt).toMatchObject({ ok: false, code: 'key_rejected' })
    const state = f.state()
    expect(state.shellKeys?.claude?.kimi).toBe(oldKey)
    expect(state.shellModels?.claude?.kimi).toBe('k3-256k')
    expect(state.selected.claude).toBe('kimi')
    expect(JSON.stringify(state)).not.toContain(newKey)
    // 现役路由纹丝没动：绑定不换、配置不重写（applyConnection 未再被调用）。
    expect(f.gateway.snapshot().routes.find(route => route.shell === 'claude')).toEqual(liveRouteBefore)
    expect(f.adapters[1].applyConnection).toHaveBeenCalledTimes(1)
  })
})
