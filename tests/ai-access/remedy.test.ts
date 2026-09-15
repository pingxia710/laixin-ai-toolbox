import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function reply(second: boolean): Response {
  if (second) {
    return new Response([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] })
}

function fixture(initial: AiAccessState = { version: 1, selected: {} }) {
  let state = initial
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(JSON.parse(String(init?.body)).stream === true))
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000 })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  return { service, adapters, fetcher, gateway, store, state: () => state }
}

async function connected() {
  const f = fixture()
  await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-remedy-0123456789')
  await f.service.useProvider('codex', 'deepseek')
  return f
}

describe('处理动作与自动复验', () => {
  it('本机服务被杀之后，重启本机 API 服务能复验通过，端口与所选模型不变', async () => {
    const f = await connected()
    const before = await f.service.serviceStatus()
    await f.gateway.stop()
    expect(await f.service.serviceStatus()).toMatchObject({ running: false, startupError: 'local_service_down' })

    const result = await f.service.remedy('codex', 'restartGateway')
    expect(result).toMatchObject({ shell: 'codex', provider: 'deepseek', action: 'restartGateway', outcome: 'recovered' })
    expect(result.code).toBeUndefined()
    const after = await f.service.serviceStatus()
    expect(after.running).toBe(true)
    expect(after.baseUrl).toBe(before.baseUrl)
    expect(after.routes).toEqual(before.routes)
    expect(after.startupError).toBeUndefined()
    expect(f.state().selected.codex).toBe('deepseek')
  })

  it('Key 是错的：重新测试之后仍然判成 Key 未通过，⛔ 因为命令跑完就说修好了', async () => {
    const f = await connected()
    f.fetcher.mockResolvedValue(new Response('{"error":{"type":"authentication_error"}}', { status: 401 }))
    const result = await f.service.remedy('codex', 'retest')
    expect(result).toMatchObject({ action: 'retest', outcome: 'still_failing', code: 'key_rejected', next: 'openConsole' })
    expect(result.message).toContain('Key')
  })

  it('本机服务重启成功但上游仍然不通，结论是仍有问题而不是已恢复', async () => {
    const f = await connected()
    await f.gateway.stop()
    f.fetcher.mockResolvedValue(new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 }))
    const result = await f.service.remedy('codex', 'restartGateway')
    expect(result).toMatchObject({ outcome: 'still_failing', code: 'balance_or_access', next: 'openConsole' })
    expect((await f.service.serviceStatus()).running).toBe(true)
  })

  it('重新写入配置：写不进去就报配置失败，写得进去就复验通过', async () => {
    const f = await connected()
    f.adapters[0].applyConnection.mockRejectedValueOnce(new Error('private disk detail'))
    const failed = await f.service.remedy('codex', 'reapply')
    expect(failed).toMatchObject({ action: 'reapply', outcome: 'still_failing', code: 'configuration_failed' })
    expect(JSON.stringify(failed)).not.toContain('private disk detail')

    const ok = await f.service.remedy('codex', 'reapply')
    expect(ok).toMatchObject({ outcome: 'recovered' })
    expect(f.adapters[0].applyConnection).toHaveBeenCalled()
  })

  it('恢复官方配置只说明已切回，不冒充官方登录可用', async () => {
    const f = await connected()
    const result = await f.service.remedy('codex', 'useOfficial')
    expect(result).toMatchObject({ action: 'useOfficial', outcome: 'unknown', provider: null })
    expect(result.message).toContain('试一次')
    expect(f.state().selected.codex).toBe('official')
  })

  it('连服务商都指不出来时才说不能确认，不乱报已恢复', async () => {
    const f = fixture()
    expect(await f.service.remedy('hermes', 'retest')).toMatchObject({ outcome: 'unknown', code: 'not_configured', provider: null })
  })

  it('第一次「启用」就失败：selected 还是空，处理动作也要对着这次失败的那家办', async () => {
    // 客户从「官方」点 DeepSeek 启用 → 上游 401 → 探测失败，selected 不会切过去，仍是空。
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-firstenable-0123456789')
    f.fetcher.mockResolvedValue(new Response('{"error":{"type":"authentication_error"}}', { status: 401 }))
    await f.service.useProvider('codex', 'deepseek').catch(() => undefined)
    expect(f.state().selected.codex ?? null).not.toBe('deepseek')

    // 不带 provider：主进程只能看 selected，于是把客户正站在的那一页判成「没在用模型 API」。
    expect(await f.service.remedy('codex', 'retest')).toMatchObject({ outcome: 'unknown', code: 'not_configured', provider: null })
    // 带上这次失败针对的服务商：必须真的对着 DeepSeek 复验并给出判类。
    const aimed = await f.service.remedy('codex', 'retest', 'deepseek')
    expect(aimed).toMatchObject({ shell: 'codex', provider: 'deepseek', outcome: 'still_failing', code: 'key_rejected' })
    expect(aimed.code).not.toBe('not_configured')
  })

  it('本机服务重启不了（端口被占）：先自动换端口自愈，落不了地就报后续动作，⛔ 死循环同一个按钮（第 4 轮）', async () => {
    const f = await connected()
    const port = Number(new URL((await f.service.serviceStatus()).baseUrl!).port)
    await f.gateway.stop()
    const blocker = new AiGateway({ fetch: f.fetcher })
    await blocker.start(port, 'laixin-fixture-blocker-token-0123456789')
    try {
      const result = await f.service.remedy('codex', 'restartGateway')
      expect(result.outcome).toBe('still_failing')
      expect(result.message).toContain('端口')
      // 桩适配器核不出配置，换端口回写落不了地：路由保持暂停，下一步指向「重新写入配置」，
      // ⛔ 再把客户指回同一个永远不会成功的「重启」按钮。
      expect(result.code).toBe('configuration_interrupted')
      expect(result.next).toBe('reapply')
      // 自愈本身是真的：网关已换到新端口重新起来了。
      const baseUrl = (await f.service.serviceStatus()).baseUrl
      expect(baseUrl).not.toBeNull()
      expect(Number(new URL(baseUrl!).port)).not.toBe(port)
    } finally { await blocker.stop() }
  })
})

describe('复验只认这次动作之后的结果', () => {
  it('动作提前失败时，旧的成功记录不能被当成「已恢复」', async () => {
    const f = await connected()
    expect((await f.service.serviceStatus()).checks[0]).toMatchObject({ ok: true })
    // 保存的 Key 不见了：动作在发出任何请求之前就失败，这次没有新的复验结果。
    const read = f.store.read
    f.store.read = async () => ({ ...(await read()), shellKeys: {} })
    const result = await f.service.remedy('codex', 'reapply')
    expect(result).toMatchObject({ outcome: 'unknown', code: 'unknown' })
    expect(result.message).toContain('没能复验出结果')
    expect(f.fetcher.mock.calls.length).toBe(2)
  })
})
