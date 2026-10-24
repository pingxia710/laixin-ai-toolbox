import { afterEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async () => undefined)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/laixin-fixture-unused' }, shell: { openExternal } }))

// 复审收尾：restartGateway 处理动作重启的是同端口同令牌的网关，旧令牌并未作废——
// 在飞的客户流式回答应当在短宽限内允许收尾，而不是 drain(0) 立即整批掐断。
// （换端口/令牌轮换路径的立即中止语义不变，不在本测试范围。）
const { BridgeRegistry } = await import('../../app/main/bridge/bridge-registry')
const { registerAiAccessActions } = await import('../../app/main/actions/ai-access')
const { AiAccessService, aiAccessShells } = await import('../../app/main/ai-access/service')
const { AiGateway } = await import('../../app/main/ai-access/gateway')
type Service = InstanceType<typeof AiAccessService>

const services: Service[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); openExternal.mockClear() })

function reply(second: boolean): Response {
  if (second) {
    return new Response([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] })
}

async function fixture() {
  let state = { version: 1 as const, selected: {} as Record<string, string> }
  // hangNext 只拦下一次上游往返：给客户的在飞请求挂着等放行；之后的（重启后的探活）照常回。
  let hangNext = false
  let releaseHanging: ((response: Response) => void) | undefined
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const stream = JSON.parse(String(init?.body)).stream === true
    if (hangNext) {
      hangNext = false
      return new Promise<Response>(resolve => { releaseHanging = resolve })
    }
    return reply(stream)
  })
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn(async () => undefined), captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const store = { read: async () => state as never, write: async (next: never) => { state = next } }
  const service = new AiAccessService(store, adapters, new AiGateway({ fetch: fetcher, timeoutMs: 1_000 }))
  services.push(service)
  const registry = new BridgeRegistry()
  registerAiAccessActions(registry, service, undefined, undefined, undefined, {})
  await service.saveProviderKey('codex', 'deepseek', 'sk-fixture-bridge-remedy-0123456789')
  await service.useProvider('codex', 'deepseek')
  return {
    service, registry, fetcher,
    hangNextClientRequest: () => { hangNext = true },
    releaseClientUpstream: () => releaseHanging?.(reply(true)),
    token: () => (state as unknown as { relay?: { token: string } }).relay!.token
  }
}

describe('restartGateway 处理动作的在飞请求宽限', () => {
  it('同端口同令牌重启时，界内收尾的在飞流式回答不被掐断', async () => {
    const f = await fixture()
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    const callsBefore = f.fetcher.mock.calls.length
    f.hangNextClientRequest()
    const clientRequest = fetch(`${route.baseUrl}/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${f.token()}` }, body: JSON.stringify({ stream: true }) })
    await vi.waitFor(() => expect(f.fetcher.mock.calls.length).toBe(callsBefore + 1))

    const remedy = f.registry.execute('aiaccess.remedy', { shell: 'codex', action: 'restartGateway', provider: 'deepseek' }) as Promise<{ snapshot: string }>
    // 停止流程进入沉降窗口后，在飞回答在界内自然收尾。
    await new Promise(resolve => setTimeout(resolve, 120))
    f.releaseClientUpstream()

    const response = await Promise.race([clientRequest.catch(() => null), new Promise<Response | null>(resolve => setTimeout(() => resolve(null), 2_000))])
    const outcome = JSON.parse((await remedy).snapshot) as { outcome?: string }
    expect(response?.status).toBe(200)
    expect(outcome.outcome).toBe('recovered')
  })
})
