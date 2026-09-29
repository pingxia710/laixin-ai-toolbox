import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { AiGateway } from '../../app/main/ai-access/gateway'

const clientToken = 'laixin-multi-client-token-0123456789'
const upstreamA = 'sk-fixture-deepseek-key-0123456789'
const upstreamB = 'sk-fixture-zhipu-api-key-0123456789'
const upstreamC = 'sk-fixture-zhipu-plan-key-01234567890'

type MultiModelRoute = {
  readonly internalModelId: string
  readonly provider: 'deepseek' | 'zhipu-api' | 'zhipu'
  readonly model: string
  readonly endpoint: string
  readonly key: string
}

type MultiGateway = AiGateway & {
  setMultiModelRoute(route: { readonly provider: 'laixin-multi'; readonly models: readonly MultiModelRoute[] } | undefined): void
}

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

function response(): Response {
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] })
}

async function start(fetcher: typeof fetch, models: readonly MultiModelRoute[] = routes): Promise<MultiGateway> {
  const gateway = new AiGateway({ fetch: fetcher }) as MultiGateway
  gateways.push(gateway)
  await gateway.start(0, clientToken)
  gateway.setMultiModelRoute({ provider: 'laixin-multi', models })
  return gateway
}

const routes: readonly MultiModelRoute[] = [
  { internalModelId: 'laixin.deepseek.deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://fixture.invalid/deepseek', key: upstreamA },
  { internalModelId: 'laixin.zhipu-api.glm-5.3-flash', provider: 'zhipu-api', model: 'glm-5.3-flash', endpoint: 'https://fixture.invalid/zhipu-api', key: upstreamB },
  { internalModelId: 'laixin.zhipu.glm-5.3-flash', provider: 'zhipu', model: 'glm-5.3-flash', endpoint: 'https://fixture.invalid/zhipu-plan', key: upstreamC }
]

describe('Codex 来信多模型池', () => {
  it('合并目录列出不同 Key 产品的稳定内部模型 ID；相同显示模型名不串线', async () => {
    const calls: { readonly url: string; readonly init: RequestInit }[] = []
    const gateway = await start(async (url, init) => { calls.push({ url: String(url), init: init! }); return response() })

    const catalog = await fetch(`${gateway.baseUrl}/codex/multi/v1/models`, { headers: { authorization: `Bearer ${clientToken}` } })
    expect(catalog.status).toBe(200)
    expect((await catalog.json()).data.map((entry: { id: string }) => entry.id)).toEqual(routes.map(route => route.internalModelId))

    for (const route of routes) {
      const result = await fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${clientToken}` }, body: JSON.stringify({ model: route.internalModelId, input: 'private prompt' })
      })
      expect(result.status).toBe(200)
    }
    expect(calls.map(call => call.url)).toEqual(routes.map(route => route.endpoint))
    expect(calls.map(call => new Headers(call.init.headers).get('authorization'))).toEqual(routes.map(route => `Bearer ${route.key}`))
    expect(calls.map(call => JSON.parse(String(call.init.body)).model)).toEqual(routes.map(route => route.model))
    expect(JSON.stringify(gateway.snapshot())).not.toContain('private prompt')
    expect(JSON.stringify(gateway.snapshot())).not.toContain(upstreamA)
  })

  it('未知、已移出和缺少模型的请求失败关闭，不接触上游', async () => {
    let calls = 0
    const gateway = await start(async () => { calls += 1; return response() })
    const request = (body: object) => fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${clientToken}` }, body: JSON.stringify(body)
    })

    expect((await request({ model: 'laixin.unknown.model' })).status).toBe(409)
    expect((await request({})).status).toBe(409)
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: routes.slice(1) })
    expect((await request({ model: routes[0].internalModelId })).status).toBe(409)
    expect(calls).toBe(0)
  })

  it('请求开始后固定精确路由快照；更新只影响下一次请求', async () => {
    const calls: RequestInit[] = []
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const gateway = await start(async (_url, init) => {
      calls.push(init!)
      if (calls.length === 1) await waiting
      return response()
    }, [routes[0]])
    const send = () => fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${clientToken}` }, body: JSON.stringify({ model: routes[0].internalModelId })
    })

    const first = send()
    for (let attempt = 0; calls.length === 0 && attempt < 50; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(calls).toHaveLength(1)
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [{ ...routes[0], key: 'sk-fixture-deepseek-replacement-0123456789' }] })
    release()
    expect((await first).status).toBe(200)
    expect((gateway as AiGateway).multiModelClientAcceptances()[routes[0].internalModelId]).toBeUndefined()
    expect((gateway as AiGateway).multiModelClientAttempts()[routes[0].internalModelId]).toBeUndefined()
    expect((await send()).status).toBe(200)
    expect(new Headers(calls[0].headers).get('authorization')).toBe(`Bearer ${upstreamA}`)
    expect(new Headers(calls[1].headers).get('authorization')).toBe('Bearer sk-fixture-deepseek-replacement-0123456789')
    expect((gateway as AiGateway).multiModelClientAcceptances()[routes[0].internalModelId]).toMatchObject({ revision: expect.any(String) })
  })

  it('移除模型后迟到的旧请求不写入当前池证据，保留模型可独立验收', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const gateway = await start(async (url) => {
      calls += 1
      if (String(url).endsWith('/deepseek')) await waiting
      return response()
    }, routes.slice(0, 2))
    const request = (model: string) => fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${clientToken}` }, body: JSON.stringify({ model, input: 'private prompt' })
    })

    const old = request(routes[0].internalModelId)
    for (let attempt = 0; calls === 0 && attempt < 50; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [routes[1]] })
    release()
    expect((await old).status).toBe(200)
    expect(gateway.multiModelClientAcceptances()[routes[0].internalModelId]).toBeUndefined()
    expect(gateway.multiModelClientAttempts()[routes[0].internalModelId]).toBeUndefined()
    expect((await request(routes[1].internalModelId)).status).toBe(200)
    expect(gateway.multiModelClientAcceptances()).toEqual({
      [routes[1].internalModelId]: expect.objectContaining({ model: routes[1].model, routeId: routes[1].internalModelId })
    })
  })

  it('在读取 body 前启动 Desktop socket attestation，未读完 body 绝不请求上游', async () => {
    const attestor = { observe: vi.fn(async () => ({ status: 'unverified' as const, at: null, reason: 'socket_owner_not_found' as const })) }
    let upstreamCalls = 0
    const gateway = new AiGateway({ desktopAttestor: attestor, fetch: async () => { upstreamCalls += 1; return response() } })
    gateways.push(gateway)
    await gateway.start(0, clientToken)
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [routes[0]] })
    const body = JSON.stringify({ model: routes[0].internalModelId, input: 'private prompt' })
    const status = new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${gateway.baseUrl}/codex/multi/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${clientToken}`, 'content-length': Buffer.byteLength(body) }
      }, response => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)) })
      request.once('error', reject)
      request.write(body.slice(0, 1))
      setTimeout(() => request.end(body.slice(1)), 20)
    })

    for (let attempt = 0; attestor.observe.mock.calls.length === 0 && attempt < 50; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2))
    expect(attestor.observe).toHaveBeenCalledTimes(1)
    expect(upstreamCalls).toBe(0)
    expect(await status).toBe(200)
  })

  it('429 只短路同一内部模型；完整回答记录当前模型调用并在读 body 前开始 Desktop attestation', async () => {
    const attestor = { observe: vi.fn(async () => ({ status: 'verified' as const, at: '2026-09-27T00:00:00.000Z', reason: 'verified_socket_bound_desktop' as const })) }
    const calls: string[] = []
    const gateway = new AiGateway({
      desktopAttestor: attestor,
      fetch: async (url) => {
        calls.push(String(url))
        return String(url).endsWith('/deepseek') ? new Response('limited', { status: 429 }) : response()
      }
    }) as MultiGateway & {
      multiModelClientAcceptances(): Readonly<Record<string, { readonly model: string }>>
      multiModelClientAttempts(): Readonly<Record<string, { readonly ok: boolean }>>
      multiModelDesktopRouteAcceptances(): Readonly<Record<string, { readonly status: string }>>
    }
    gateways.push(gateway)
    await gateway.start(0, clientToken)
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: routes.slice(0, 2) })
    const request = (model: string) => fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${clientToken}` }, body: JSON.stringify({ model, input: 'private prompt' })
    })

    expect((await request(routes[0].internalModelId)).status).toBe(429)
    expect((await request(routes[0].internalModelId)).status).toBe(429)
    expect(calls.filter(url => url.endsWith('/deepseek'))).toHaveLength(1)
    expect((await request(routes[1].internalModelId)).status).toBe(200)
    expect(calls.filter(url => url.endsWith('/zhipu-api'))).toHaveLength(1)
    // Each accepted connection starts socket attestation before its body is read, including a
    // locally short-circuited retry; only the two completed upstream outcomes become evidence.
    expect(attestor.observe).toHaveBeenCalledTimes(3)
    expect(gateway.multiModelClientAttempts()[routes[0].internalModelId]).toMatchObject({ ok: false })
    expect(gateway.multiModelClientAcceptances()[routes[1].internalModelId]).toMatchObject({ model: 'glm-5.3-flash' })
    expect(gateway.multiModelDesktopRouteAcceptances()[routes[1].internalModelId]).toMatchObject({ status: 'verified' })
  })
})
