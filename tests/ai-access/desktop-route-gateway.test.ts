import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway, type GatewayRoute } from '../../app/main/ai-access/gateway'
import type { DesktopRouteAttestor } from '../../app/main/ai-access/desktop-route-attestation'
import type { CodexDesktopRouteVerification } from '../../app/shared/api-service-types'

const token = 'laixin-desktop-route-client-token-0123456789'
const key = 'sk-desktop-route-upstream-key-0123456789'
const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://api.deepseek.com/fixture', key }
const gateways: AiGateway[] = []
const successfulSse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

async function started(attestor: DesktopRouteAttestor, response = successfulSse): Promise<AiGateway> {
  const gateway = new AiGateway({
    fetch: async () => new Response(response, { headers: { 'content-type': 'text/event-stream' } }),
    desktopAttestor: attestor
  })
  gateways.push(gateway)
  await gateway.start(0, token)
  gateway.setRoutes([route])
  return gateway
}

async function clientCall(gateway: AiGateway, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ input: 'private prompt' })
  })
}

describe('Codex Desktop gateway proof', () => {
  it('只有完整回答与经过 socket 绑定的官方桌面证明同时成立才写 Desktop verified', async () => {
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({
      status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop',
      pid: 777, executable: '/Applications/ChatGPT.app', socket: '127.0.0.1:43100', headers: { authorization: key }
    } as CodexDesktopRouteVerification)) }
    const gateway = await started(attestor)

    expect(await (await clientCall(gateway)).text()).toBe(successfulSse)
    expect(gateway.clientAcceptances().codex).toMatchObject({ provider: 'deepseek' })
    const result = await (await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)).json() as Record<string, unknown>

    expect(result).toMatchObject({ status: 'verified', reason: 'verified_socket_bound_desktop', at: expect.any(String) })
    expect(Object.keys(result).sort()).toEqual(['at', 'reason', 'status'])
    expect(attestor.observe).toHaveBeenCalledWith(expect.objectContaining({ localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }))
    expect(JSON.stringify(result)).not.toContain(key)
    expect(JSON.stringify(result)).not.toContain('private prompt')
    expect(JSON.stringify(result)).not.toContain('ChatGPT.app')
  })

  it('CLI/User-Agent/人工标记都不会覆盖严格 attestor 的未验证结果', async () => {
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({ status: 'unverified', at: null, reason: 'socket_owner_not_codex_desktop' })) }
    const gateway = await started(attestor)

    await clientCall(gateway, { 'user-agent': 'Codex Desktop', 'x-manual-desktop-claim': 'true' })
    const result = await (await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)).json()

    expect(result).toEqual({ status: 'unverified', at: null, reason: 'socket_owner_not_codex_desktop' })
  })

  it('attestor 传来的非标准时间不会被回显到 Desktop 状态', async () => {
    const secret = 'sk-desktop-time-must-not-escape'
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({
      status: 'verified', at: `Sep 13 2026 (${secret})`, reason: 'verified_socket_bound_desktop'
    })) }
    const gateway = await started(attestor)

    await clientCall(gateway)
    const result = await (await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)).json()

    expect(result).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('没有完整文本回答时，即使 attestor 声称成功也不能变为 Desktop pass', async () => {
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })) }
    const toolOnly = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const gateway = await started(attestor, toolOnly)

    await clientCall(gateway)
    const result = await (await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)).json()

    expect(result).toEqual({ status: 'unverified', at: null, reason: 'incomplete_answer' })
  })

  it('换当前路由会立即作废上一条 Desktop proof，状态端点不接受查询参数或跨站读取', async () => {
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })) }
    const gateway = await started(attestor)
    await clientCall(gateway)
    await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)
    expect(gateway.codexDesktopRouteAcceptance().status).toBe('verified')

    gateway.setRoutes([{ ...route, model: 'next-model' }])
    expect(gateway.codexDesktopRouteAcceptance()).toEqual({ status: 'unverified', at: null, reason: 'awaiting_desktop_request' })
    expect((await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status?claim=1`)).status).toBe(405)
    expect((await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`, { headers: { origin: 'https://example.test' } })).status).toBe(403)
  })

  it('配置被外部改动后会作废当前路由的客户端和桌面验收，直到重新写入并重新调用', async () => {
    const attestor: DesktopRouteAttestor = { observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })) }
    const gateway = await started(attestor)
    await clientCall(gateway)
    await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)
    expect(gateway.clientAcceptances().codex).toMatchObject({ provider: 'deepseek' })
    expect(gateway.codexDesktopRouteAcceptance().status).toBe('verified')

    gateway.invalidateClientAcceptance('codex')

    expect(gateway.clientAcceptances().codex).toBeUndefined()
    expect(gateway.codexDesktopRouteAcceptance()).toEqual({ status: 'unverified', at: null, reason: 'awaiting_desktop_request' })
  })

  it('外改发生在旧请求与 Desktop 核对完成前时，旧请求完成也不能把验收写回', async () => {
    const upstream = deferred<Response>()
    const upstreamStarted = deferred<void>()
    const attestation = deferred<CodexDesktopRouteVerification>()
    const gateway = new AiGateway({
      fetch: async () => { upstreamStarted.resolve(); return await upstream.promise },
      desktopAttestor: { observe: async () => await attestation.promise }
    })
    gateways.push(gateway)
    await gateway.start(0, token)
    gateway.setRoutes([route])

    const request = clientCall(gateway)
    await upstreamStarted.promise
    gateway.invalidateClientAcceptance('codex')
    upstream.resolve(new Response(successfulSse, { headers: { 'content-type': 'text/event-stream' } }))
    attestation.resolve({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })
    await (await request).text()
    await fetch(`${gateway.baseUrl}/_laixin/codex-desktop-route-status`)

    expect(gateway.clientAcceptances().codex).toBeUndefined()
    expect(gateway.codexDesktopRouteAcceptance()).toEqual({ status: 'unverified', at: null, reason: 'awaiting_desktop_request' })
  })
})
