import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import type { DesktopRouteAttestor } from '../../app/main/ai-access/desktop-route-attestation'
import type { CodexDesktopRouteVerification } from '../../app/shared/api-service-types'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function reply(second: boolean): Response {
  if (second) {
    return new Response([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] })
}

function fixture(initial: AiAccessState = { version: 1, selected: {} }, desktopAttestor?: DesktopRouteAttestor) {
  let state = initial
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(JSON.parse(String(init?.body)).stream === true))
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000, ...(desktopAttestor ? { desktopAttestor } : {}) })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  return { service, adapters, fetcher, gateway, store, state: () => state }
}
const stage = async (service: AiAccessService) => (await service.serviceStatus()).usage.find(item => item.shell === 'codex')!

describe('确认软件真的用上了', () => {
  it('测过 / 配置已写 / 已观察到调用 三个时间依次出现，前两步不冒充第三步', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-usage-0123456789')
    expect(await stage(f.service)).toMatchObject({ provider: null, tested: null, configured: null, observedClientCall: null })

    await f.service.testProvider('codex', 'deepseek')
    const tested = await stage(f.service)
    expect(tested.tested).not.toBeNull()
    expect(tested.configured).toBeNull()
    expect(tested.observedClientCall).toBeNull()

    await f.service.useProvider('codex', 'deepseek')
    const configured = await stage(f.service)
    expect(configured).toMatchObject({ provider: 'deepseek' })
    expect(configured.configured).not.toBeNull()
    expect(configured.observedClientCall).toBeNull()
    expect(configured.codexDesktopRoute).toEqual({ status: 'unverified', at: null, reason: 'awaiting_desktop_request' })

    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    const response = await fetch(`${route.baseUrl}/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ stream: true }) })
    expect(response.status).toBe(200); await response.text()

    const used = await stage(f.service)
    expect(used.observedClientCall).not.toBeNull()
    expect(Date.parse(used.tested!)).toBeLessThanOrEqual(Date.parse(used.configured!))
    expect(Date.parse(used.configured!)).toBeLessThanOrEqual(Date.parse(used.observedClientCall!))
    expect(used.codexDesktopRoute).toMatchObject({ status: 'unverified' })
  })

  it('把严格 Desktop socket 证明单独放进 Codex 状态，普通 CLI 客户端调用不会顶替它', async () => {
    const desktopAttestor: DesktopRouteAttestor = {
      observe: vi.fn(async (): Promise<CodexDesktopRouteVerification> => ({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' }))
    }
    const f = fixture({ version: 1, selected: {} }, desktopAttestor)
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-usage-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    await (await fetch(`${route.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}`, 'user-agent': 'Codex Desktop' }, body: JSON.stringify({ stream: true }) })).text()
    await (await fetch(`${f.gateway.baseUrl}/_laixin/codex-desktop-route-status`)).json()

    expect(await stage(f.service)).toMatchObject({
      observedClientCall: expect.any(String),
      codexDesktopRoute: { status: 'verified', reason: 'verified_socket_bound_desktop', at: expect.any(String) }
    })

    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-usage-kimi-0123456789')
    await f.service.useProvider('codex', 'kimi')
    expect((await stage(f.service)).codexDesktopRoute).toEqual({ status: 'unverified', at: null, reason: 'awaiting_desktop_request' })
  })

  it('换一个渠道后「已观察到调用」归零，等这个 AI 下次真的用一次', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-usage-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    await (await fetch(`${route.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ stream: true }) })).text()
    expect((await stage(f.service)).observedClientCall).not.toBeNull()

    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-usage-kimi-0123456789')
    await f.service.useProvider('codex', 'kimi')
    const switched = await stage(f.service)
    expect(switched).toMatchObject({ provider: 'kimi', observedClientCall: null })
    expect(switched.configured).not.toBeNull()
  })

  it('重开工具箱后三态从头来过，只有配置留在盘上', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-usage-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    await f.service.stop()
    const restored = new AiAccessService(f.store, f.adapters, new AiGateway({ fetch: f.fetcher }))
    services.push(restored)
    await restored.initialize()
    expect(await stage(restored)).toMatchObject({ provider: 'deepseek', tested: null, configured: null, observedClientCall: null })
    expect((await restored.serviceStatus()).routes.map(item => item.shell)).toEqual(['codex'])
  })

  it('恢复官方后三态清空，本机服务停了就报本机服务未运行而不是服务商异常', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-usage-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    await f.gateway.stop()
    expect(await f.service.serviceStatus()).toMatchObject({ running: false, startupError: 'local_service_down' })
    await f.service.useOfficial('codex')
    expect(await stage(f.service)).toMatchObject({ provider: null, tested: null, configured: null, observedClientCall: null })
    expect((await f.service.serviceStatus()).startupError).toBeUndefined()
  })
})
