import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiRouterGateway, routerRouteIdentity } from '../../app/main/ai-access/router-gateway'
import { activeSingleRouterRoutes } from '../../app/main/ai-access/router-state'
import { chooseAiRouterPort } from '../../app/main/ai-access/router-controller'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway, type GatewayFetch } from '../../app/main/ai-access/gateway'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

const runtimes: AiRouterGateway[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(0) })
const keys = { codex: 'sk-fixture-codex-0123456789', claude: 'sk-fixture-claude-0123456789', hermes: 'sk-fixture-hermes-0123456789' }
async function fixture(separateMulti = false): Promise<AiAccessState> {
  const port = await chooseAiRouterPort()
  return { version: 1, selected: { codex: 'deepseek', claude: 'deepseek', hermes: 'deepseek' },
    relay: { port, token: 'a'.repeat(64) }, relayShells: [...aiAccessShells],
    codexMultiRelay: { port: separateMulti ? await chooseAiRouterPort() : port, identitySecret: 'b'.repeat(64) },
    shellKeys: Object.fromEntries(aiAccessShells.map(shell => [shell, { deepseek: keys[shell] }])) }
}
function answer() {
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })
}
function call(state: AiAccessState, shell: typeof aiAccessShells[number], input = 'fixture'): Promise<Response> {
  const path = shell === 'codex' ? 'responses' : shell === 'claude' ? 'messages' : 'chat/completions'
  return fetch(`http://127.0.0.1:${state.relay!.port}/${shell}/deepseek/v1/${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${state.relay!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', input, messages: [{ role: 'user', content: input }] }) })
}

describe('API-13 one independent process serves existing single-model addresses', () => {
  it('只有已验证的当前隔离路由可以保留网络，换 Key 或解除立即撤销依赖', async () => {
    const state = await fixture()
    const runtime = new AiRouterGateway({ fetch: async () => answer() }, undefined,
      () => ({ activate: async () => undefined, deactivate: async () => undefined, fetch: async () => answer() }))
    runtimes.push(runtime)
    await runtime.start(state, 'c'.repeat(64))
    const route = activeSingleRouterRoutes(state).find(route => route.shell === 'codex')!
    const identity = routerRouteIdentity(route), proxyUrl = 'http://127.0.0.1:43100'
    await runtime.isolation({ shell: 'codex', action: 'activate', proxyUrl, targetIdentity: identity }, state)
    await runtime.isolation({ shell: 'codex', action: 'apply', targetIdentity: identity }, state)
    expect(runtime.networkUse()).toEqual([])
    await runtime.isolation({ shell: 'codex', action: 'probe-accepted', targetIdentity: identity }, state)
    expect(runtime.networkUse()).toEqual([{ proxyUrl, targets: [`${new URL(route.endpoint).hostname}:443`] }])
    await runtime.refresh({ ...state, shellKeys: { ...state.shellKeys, codex: { deepseek: 'sk-fixture-changed-0123456789' } } })
    expect(runtime.networkUse()).toEqual([])
    await runtime.refresh(state)
    await runtime.isolation({ shell: 'codex', action: 'deactivate' }, state)
    expect(runtime.networkUse()).toEqual([])
  })

  it.each([false, true])('三壳在 GUI 退出前后沿用原令牌，各用自己的 Key，兼容旧双端口 %s', async separateMulti => {
    const state = await fixture(separateMulti)
    const upstream = vi.fn<GatewayFetch>(async () => answer())
    const runtime = new AiRouterGateway({ fetch: upstream })
    runtimes.push(runtime)
    await runtime.start(state, 'c'.repeat(64))
    const gui = new AiAccessService({ read: async () => state, write: async () => undefined },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), new AiGateway(), { independentRouting: true },
      {} as AiRouterController)
    for (const shell of aiAccessShells) expect((await call(state, shell)).status).toBe(200)
    await gui.stop()
    for (const shell of aiAccessShells) expect((await call(state, shell)).status).toBe(200)
    expect(upstream.mock.calls.map(([, , route]) => route?.key)).toEqual([...Object.values(keys), ...Object.values(keys)])
    const snapshot = JSON.stringify(runtime.snapshot())
    for (const key of Object.values(keys)) expect(snapshot).not.toContain(key)
    expect(runtime.snapshot().service.routes).toHaveLength(3)
  })

  it('写配置中的壳暂停、其他壳继续；Key 轮换保留在飞快照，失败回滚恢复旧 Key', async () => {
    const original = await fixture()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const seen = new Promise<void>(resolve => { entered = resolve })
    const received: string[] = []
    const runtime = new AiRouterGateway({ fetch: async (_input, init, route) => {
      received.push(route!.key)
      if (String(init?.body).includes('hold')) { entered(); await held }
      return answer()
    } })
    runtimes.push(runtime)
    await runtime.start(original, 'c'.repeat(64))
    const inFlight = call(original, 'codex', 'hold')
    await seen
    await runtime.refresh({ ...original, pendingShells: ['codex'] })
    expect((await call(original, 'codex')).status).toBe(409)
    expect((await call(original, 'hermes')).status).toBe(200)
    const next = { ...original, shellKeys: { ...original.shellKeys, codex: { deepseek: 'sk-fixture-new-0123456789' } } }
    await runtime.refresh(next)
    release()
    expect((await inFlight).status).toBe(200)
    expect((await call(next, 'codex')).status).toBe(200)
    await runtime.refresh(original)
    expect((await call(original, 'codex')).status).toBe(200)
    expect(received).toEqual([keys.codex, keys.hermes, 'sk-fixture-new-0123456789', keys.codex])
  })

  it('退出释放隔离只影响后续请求，已开始的流式回答保留原独立传输直到完成', async () => {
    const state = await fixture()
    let end!: () => void
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"before exit"}\n\n'))
      end = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller.close() }
    } })
    const deactivate = vi.fn(async () => undefined)
    const isolatedFetch = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    const directFetch = vi.fn(async () => answer())
    const runtime = new AiRouterGateway({ fetch: directFetch }, undefined,
      () => ({ activate: async () => undefined, deactivate, fetch: isolatedFetch }))
    runtimes.push(runtime)
    await runtime.start(state, 'c'.repeat(64))
    const route = activeSingleRouterRoutes(state).find(route => route.shell === 'codex')!
    await runtime.isolation({ shell: 'codex', action: 'activate', proxyUrl: 'http://127.0.0.1:43100', targetIdentity: routerRouteIdentity(route) }, state)
    expect(runtime.snapshot().service.routes.find(route => route.shell === 'codex')).not.toHaveProperty('isolated')
    await runtime.isolation({ shell: 'codex', action: 'apply', targetIdentity: routerRouteIdentity(route) }, state)
    const response = await call(state, 'codex')
    const text = response.text()
    await runtime.isolation({ shell: 'codex', action: 'deactivate' }, state)
    expect(deactivate).not.toHaveBeenCalled()
    expect((await call(state, 'hermes')).status).toBe(200)
    end()
    expect(await text).toContain('before exit')
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce())
    expect((await call(state, 'codex')).status).toBe(200)
    expect(isolatedFetch).toHaveBeenCalledOnce()
    expect(directFetch).toHaveBeenCalledTimes(2)
  })

  it('停止期间不能把迟到的隔离传输重新激活成孤儿会话', async () => {
    const state = await fixture()
    let complete!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { complete = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const deactivate = vi.fn(async () => undefined)
    const runtime = new AiRouterGateway({ fetch: async () => answer() }, undefined,
      () => ({ activate: async () => { started(); await pending }, deactivate, fetch: async () => answer() }))
    runtimes.push(runtime)
    await runtime.start(state, 'c'.repeat(64))
    const route = activeSingleRouterRoutes(state)[0]
    const activation = runtime.isolation({ shell: 'codex', action: 'activate', proxyUrl: 'http://127.0.0.1:43100', targetIdentity: routerRouteIdentity(route) }, state)
    const rejection = expect(activation).rejects.toThrow('AI_ROUTER_STOPPING')
    await entered
    await runtime.stop(0)
    complete()
    await rejection
    expect(deactivate).toHaveBeenCalledOnce()
    expect(runtime.snapshot().service.running).toBe(false)
  })
})
