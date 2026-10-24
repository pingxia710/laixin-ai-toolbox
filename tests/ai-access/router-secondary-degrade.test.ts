import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AiAccessState } from '../../app/main/ai-access/service'
import { AiRouterGateway } from '../../app/main/ai-access/router-gateway'
import type { GatewayFetch } from '../../app/main/ai-access/gateway'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
const token = 'c'.repeat(64)
const deepseekId = 'laixin.deepseek.deepseek-flash'
const zhipuId = 'laixin.zhipu-api.glm-5.3-flash'
const keys = { deepseek: 'fixture-deepseek-key-0123456789', zhipu: 'fixture-zhipu-key-0123456789',
  claude: 'fixture-claude-key-0123456789', hermes: 'fixture-hermes-key-0123456789' }

function occupy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('foreign'))
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function release(occupied: { server: Server }): Promise<void> {
  if (!occupied.server.listening) return Promise.resolve()
  return new Promise((resolve) => occupied.server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const { server, port } = await occupy()
  await release({ server })
  return port
}

function stateFixture(multiPort: number, relayPort: number): AiAccessState {
  return { version: 1, selected: { claude: 'deepseek', hermes: 'deepseek' }, codexMode: 'multi',
    codexMultiRelay: { port: multiPort, identitySecret: 'a'.repeat(64) },
    relay: { port: relayPort, token: 'b'.repeat(64) }, relayShells: ['claude', 'hermes'],
    shellKeys: { codex: { deepseek: keys.deepseek, 'zhipu-api': keys.zhipu },
      claude: { deepseek: keys.claude }, hermes: { deepseek: keys.hermes } },
    codexMultiModelPool: [
      { internalModelId: deepseekId, provider: 'deepseek', model: 'deepseek-flash' },
      { internalModelId: zhipuId, provider: 'zhipu-api', model: 'glm-5.3-flash' }
    ] }
}

function answer(): Response {
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
    choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })
}

async function fixture(fetcher: GatewayFetch = async () => answer()) {
  const blocker = await occupy()
  disposals.push(() => release(blocker))
  const state = stateFixture(await freePort(), blocker.port)
  const upstream = vi.fn(fetcher)
  const router = new AiRouterGateway({ fetch: upstream })
  disposals.push(() => router.stop(0))
  const send = (model = deepseekId) => fetch(`${router.primary.baseUrl}/codex/multi/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model, input: 'fixture' })
  })
  const catalog = async () => {
    const response = await fetch(`${router.primary.baseUrl}/codex/multi/v1/models`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    return (await response.json() as { data: { id: string }[] }).data.map(model => model.id)
  }
  return { blocker, state, upstream, router, send, catalog }
}

// 监听存活不代表模型可用：故障期间必须实际读取目录、请求回答，并核对上游绑定。
describe('independent router secondary listener degrade', () => {
  it('单模型端口被占时多模型目录和请求可用，释放后两类请求都恢复', async () => {
    const { blocker, state, upstream, router, send, catalog } = await fixture()
    await router.start(state, token)
    expect(router.snapshot().secondaryMissing).toBe(true)
    expect(await catalog()).toEqual([deepseekId, zhipuId])
    for (const model of [deepseekId, zhipuId]) {
      const response = await send(model)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('OK')
    }
    expect(upstream.mock.calls.map(([, , route]) => [route?.provider, route?.model, route?.key])).toEqual([
      ['deepseek', 'deepseek-flash', keys.deepseek], ['zhipu-api', 'glm-5.3-flash', keys.zhipu]
    ])

    await release(blocker)
    await router.refresh(state)
    expect(router.snapshot().secondaryMissing).toBeUndefined()
    for (const shell of ['claude', 'hermes'] as const) {
      const path = shell === 'claude' ? 'messages' : 'chat/completions'
      const response = await fetch(`http://127.0.0.1:${state.relay!.port}/${shell}/deepseek/v1/${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${state.relay!.token}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }] })
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('OK')
    }
    const response = await send()
    expect(response.status).toBe(200)
    await response.text()
    expect(upstream.mock.calls.slice(2).map(([, , route]) => route?.key)).toEqual([keys.claude, keys.hermes, keys.deepseek])
  })

  it('冲突期间刷新立即更新后续请求的 Key 和模型目录，在途回答保持原绑定', async () => {
    let finish!: () => void
    let first = true
    const { state, upstream, router, send, catalog } = await fixture(async () => {
      if (!first) return answer()
      first = false
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"before refresh"}\n\n'))
        finish = () => {
          controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'))
          controller.close()
        }
      } }), { headers: { 'content-type': 'text/event-stream' } })
    })
    // 先正常安装模型池，再在刷新时遇到单模型端口冲突，不能留着过期目录或旧 Key。
    await router.start({ ...state, relay: undefined }, token)
    const inFlight = await send()
    expect(inFlight.status).toBe(200)
    const oldText = inFlight.text()
    const replacement = 'fixture-replacement-key-0123456789'
    try {
      await router.refresh({ ...state, codexMultiModelPool: state.codexMultiModelPool!.slice(0, 1),
        shellKeys: { ...state.shellKeys, codex: { deepseek: replacement } } })
      expect(router.snapshot().secondaryMissing).toBe(true)
      expect(await catalog()).toEqual([deepseekId])
      const removed = await send(zhipuId)
      expect(removed.status).toBe(409)
      await removed.text()
      expect(upstream).toHaveBeenCalledTimes(1)
      const next = await send()
      expect(next.status).toBe(200)
      await next.text()
    } finally {
      finish()
      expect(await oldText).toContain('response.completed')
    }
    expect(upstream.mock.calls.map(([, , route]) => route?.key)).toEqual([keys.deepseek, replacement])
  })

  it('解除单模型监听后清除冲突提示，多模型仍能请求', async () => {
    const { state, router, send } = await fixture()
    await router.start(state, token)
    expect(router.snapshot().secondaryMissing).toBe(true)
    await router.refresh({ ...state, relay: undefined })
    expect(router.snapshot().secondaryMissing).toBeUndefined()
    const response = await send()
    expect(response.status).toBe(200)
    await response.text()
  })
})
