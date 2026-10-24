import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway, type GatewayRoute } from '../../app/main/ai-access/gateway'

const token = 'laixin-api14-client-token-0123456789'
const key = 'sk-api14-upstream-key-0123456789'
const gateways: AiGateway[] = []
const upstreams: Server[] = []
type UpstreamHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(upstreams.splice(0).map(upstream => new Promise<void>(resolve => upstream.close(() => resolve()))))
})

async function startUpstream(handler: UpstreamHandler): Promise<string> {
  const upstream = createServer(handler)
  upstreams.push(upstream)
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => { upstream.off('error', reject); resolve() })
  })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('UPSTREAM_PORT_UNAVAILABLE')
  return `http://127.0.0.1:${address.port}/responses`
}

async function start(route: GatewayRoute, fetcher?: typeof fetch, timeoutMs?: number): Promise<AiGateway> {
  const gateway = new AiGateway({ ...(fetcher ? { fetch: fetcher } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
  gateways.push(gateway)
  await gateway.start(0, token)
  gateway.setRoutes([route])
  return gateway
}

function request(gateway: AiGateway, provider = 'deepseek', body = '{"input":[]}', signal?: AbortSignal): Promise<Response> {
  return fetch(`${gateway.baseUrl}/codex/${provider}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal
  })
}

function completedAnswer(): string {
  return 'data: {"type":"response.output_text.delta","delta":"恢复成功"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
}

describe('Codex 限流到期后的受控恢复', () => {
  it('只让一个客户实际请求确认恢复；同绑定并发请求继续短路，成功后才全部放行', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let upstreamCalls = 0
    let inFlight = 0
    let maximumInFlight = 0
    let recoveryStarted!: () => void
    const recoveryHasStarted = new Promise<void>(resolve => { recoveryStarted = resolve })
    let releaseRecovery!: () => void
    const recoveryMayFinish = new Promise<void>(resolve => { releaseRecovery = resolve })
    let recovering = false
    let recovered = false
    let limitedAgain = false
    const endpoint = await startUpstream(async (req, res) => {
      req.resume()
      upstreamCalls += 1
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      try {
        if (upstreamCalls === 1) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"rate limited"}}')
          return
        }
        if (!recovering) {
          recovering = true
          recoveryStarted()
          await recoveryMayFinish
          recovered = true
        }
        if (!recovered || limitedAgain) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"still limited"}}')
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(completedAnswer())
      } finally {
        inFlight -= 1
      }
    })
    const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint, key }
    const gateway = await start(route)

    expect((await request(gateway)).status).toBe(429)
    expect(upstreamCalls).toBe(1)

    now += 30_000
    const recoveringRequest = request(gateway)
    await recoveryHasStarted
    const waitingClients = [request(gateway), request(gateway)]
    try {
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(upstreamCalls).toBe(2)
      expect(maximumInFlight).toBe(1)

      releaseRecovery()
      expect((await recoveringRequest).status).toBe(200)
      expect(await Promise.all(waitingClients.map(response => response.then(item => item.status)))).toEqual([429, 429])
      expect((await request(gateway)).status).toBe(200)
      expect(upstreamCalls).toBe(3)
      limitedAgain = true
      expect((await request(gateway)).status).toBe(429)
      expect((await request(gateway)).status).toBe(429)
      expect(upstreamCalls).toBe(4)
    } finally {
      releaseRecovery()
      await Promise.allSettled([recoveringRequest, ...waitingClients])
    }
  })

  it('换绑定后，旧绑定迟到的限流结果不会短路新绑定', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let releaseOldRecovery!: () => void
    const oldRecoveryMayFinish = new Promise<void>(resolve => { releaseOldRecovery = resolve })
    let oldRecoveryStarted!: () => void
    const oldRecoveryHasStarted = new Promise<void>(resolve => { oldRecoveryStarted = resolve })
    let oldCalls = 0
    const oldEndpoint = await startUpstream(async (req, res) => {
      req.resume()
      oldCalls += 1
      if (oldCalls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"rate limited"}}')
        return
      }
      oldRecoveryStarted()
      await oldRecoveryMayFinish
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"still limited"}}')
    })
    let newCalls = 0
    const newEndpoint = await startUpstream((req, res) => {
      req.resume()
      newCalls += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completedAnswer())
    })
    const oldRoute: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: oldEndpoint, key }
    const newRoute: GatewayRoute = { shell: 'codex', provider: 'kimi', model: 'kimi-for-coding', endpoint: newEndpoint, key: `${key}-new` }
    const gateway = await start(oldRoute)

    expect((await request(gateway)).status).toBe(429)
    now += 30_000
    const oldRecovery = request(gateway)
    await oldRecoveryHasStarted
    try {
      gateway.setRoutes([newRoute])
      releaseOldRecovery()
      expect((await oldRecovery).status).toBe(429)
      expect((await request(gateway, 'kimi')).status).toBe(200)
      expect((await request(gateway, 'kimi')).status).toBe(200)
      expect(newCalls).toBe(2)
    } finally {
      releaseOldRecovery()
      await oldRecovery.catch(() => undefined)
    }
  })

  it('合法 custom_tool_call 仍能接收工具结果并在最终回答后记为已使用', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let calls = 0
    const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://fixture.example/responses', key }
    const gateway = await start(route, async () => {
      calls += 1
      if (calls === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
      if (calls === 2) return Response.json({
        status: 'completed', output: [{ type: 'custom_tool_call', call_id: 'call-apply-1', name: 'apply_patch', input: '*** Begin Patch\\n*** End Patch' }]
      })
      return new Response(completedAnswer(), { headers: { 'content-type': 'text/event-stream' } })
    })

    expect((await request(gateway)).status).toBe(429)
    now += 30_000
    const toolTurn = await request(gateway)
    expect(toolTurn.status).toBe(200)
    expect(gateway.clientAcceptances()).toEqual({})
    const finalTurn = await request(gateway, 'deepseek', JSON.stringify({
      input: [{ type: 'custom_tool_call_output', call_id: 'call-apply-1', output: 'applied' }]
    }))
    expect(finalTurn.status).toBe(200)
    expect(calls).toBe(3)
    expect(gateway.clientAcceptances().codex).toMatchObject({ provider: 'deepseek', model: 'fixture-model' })
  })

  it.each(['cancelled', 'timed-out', 'local-busy', 'malformed-body', 'incomplete-stream'] as const)(
    '恢复请求 %s 后，下一次仍只允许一个请求取得恢复资格', async outcome => {
      let now = 1_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      let phase: 'limited' | 'failed-recovery' | 'next-recovery' = 'limited'
      let calls = 0
      let inFlight = 0
      let maximumInFlight = 0
      let failedRecoveryStarted!: () => void
      const failedRecoveryHasStarted = new Promise<void>(resolve => { failedRecoveryStarted = resolve })
      let nextRecoveryStarted!: () => void
      const nextRecoveryHasStarted = new Promise<void>(resolve => { nextRecoveryStarted = resolve })
      let releaseNextRecovery!: () => void
      const nextRecoveryMayFinish = new Promise<void>(resolve => { releaseNextRecovery = resolve })
      const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://fixture.example/responses', key }
      const gateway = await start(route, async (_url, init) => {
        calls += 1
        if (phase === 'limited') return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        if (phase === 'failed-recovery') {
          failedRecoveryStarted()
          if (outcome === 'incomplete-stream') {
            return new Response('data: {"type":"response.output_text.delta","delta":"not completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          }
          return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        }
        inFlight += 1
        maximumInFlight = Math.max(maximumInFlight, inFlight)
        nextRecoveryStarted()
        await nextRecoveryMayFinish
        inFlight -= 1
        return new Response(completedAnswer(), { headers: { 'content-type': 'text/event-stream' } })
      }, outcome === 'timed-out' ? 20 : undefined)

      expect((await request(gateway)).status).toBe(429)
      now += 30_000
      if (outcome === 'local-busy') {
        const internals = gateway as unknown as { controllers: Set<AbortController> }
        for (let index = 0; index < 16; index += 1) internals.controllers.add(new AbortController())
        expect((await request(gateway)).status).toBe(503)
        internals.controllers.clear()
      } else if (outcome === 'malformed-body') {
        expect((await request(gateway, 'deepseek', '{')).status).toBe(400)
      } else {
        phase = 'failed-recovery'
        const controller = new AbortController()
        const failedRecovery = request(gateway, 'deepseek', '{"input":[]}', outcome === 'cancelled' ? controller.signal : undefined)
        const failedRecoveryResult = failedRecovery.catch(error => error)
        if (outcome === 'cancelled') {
          await failedRecoveryHasStarted
          controller.abort()
          expect(await failedRecoveryResult).toBeInstanceOf(Error)
          await vi.waitFor(() => expect(gateway.snapshot().requests[0]?.code).toBe('client_aborted'))
        } else {
          const response = await failedRecovery
          const body = await response.text()
          expect(outcome === 'timed-out' ? response.status : body.includes('invalid_reply')).toBe(outcome === 'timed-out' ? 504 : true)
        }
      }

      phase = 'next-recovery'
      const callsBeforeNextRecovery = calls
      const pending = [request(gateway), request(gateway), request(gateway)]
      try {
        await nextRecoveryHasStarted
        await new Promise(resolve => setTimeout(resolve, 25))
        expect({ calls: calls - callsBeforeNextRecovery, maximumInFlight }).toEqual({ calls: 1, maximumInFlight: 1 })
        releaseNextRecovery()
        const statuses = await Promise.all(pending.map(async response => (await response).status))
        expect(statuses.filter(status => status === 200)).toHaveLength(1)
        expect(statuses.filter(status => status === 429)).toHaveLength(2)
        expect((await request(gateway)).status).toBe(200)
      } finally {
        releaseNextRecovery()
        await Promise.allSettled(pending)
      }
    }
  )

  it('畸形恢复请求后，真实 loopback 上游仍只接收一个新的恢复请求', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let calls = 0
    let inFlight = 0
    let maximumInFlight = 0
    let recoveryStarted!: () => void
    const recoveryHasStarted = new Promise<void>(resolve => { recoveryStarted = resolve })
    let releaseRecovery!: () => void
    const recoveryMayFinish = new Promise<void>(resolve => { releaseRecovery = resolve })
    const endpoint = await startUpstream(async (req, res) => {
      req.resume()
      calls += 1
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"rate limited"}}')
        return
      }
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      recoveryStarted()
      try {
        await recoveryMayFinish
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(completedAnswer())
      } finally {
        inFlight -= 1
      }
    })
    const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint, key }
    const gateway = await start(route)

    expect((await request(gateway)).status).toBe(429)
    now += 30_000
    expect((await request(gateway, 'deepseek', '{')).status).toBe(400)
    const pending = [request(gateway), request(gateway), request(gateway)]
    try {
      await recoveryHasStarted
      await new Promise(resolve => setTimeout(resolve, 25))
      expect({ calls, maximumInFlight }).toEqual({ calls: 2, maximumInFlight: 1 })
      releaseRecovery()
      const statuses = await Promise.all(pending.map(async response => (await response).status))
      expect(statuses.filter(status => status === 200)).toHaveLength(1)
      expect(statuses.filter(status => status === 429)).toHaveLength(2)
      expect((await request(gateway)).status).toBe(200)
    } finally {
      releaseRecovery()
      await Promise.allSettled(pending)
    }
  })

  it('取消和超时都会释放恢复资格，不留下永久短路', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    for (const outcome of ['cancelled', 'timed-out'] as const) {
      let calls = 0
      let recoveryStarted!: () => void
      const recoveryHasStarted = new Promise<void>(resolve => { recoveryStarted = resolve })
      let upstreamAborted!: () => void
      const upstreamWasAborted = new Promise<void>(resolve => { upstreamAborted = resolve })
      const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://fixture.example/responses', key }
      const gateway = await start(route, async (_url, init) => {
        calls += 1
        if (calls === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        if (calls === 2) {
          recoveryStarted()
          return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
            upstreamAborted()
            reject(new Error('aborted'))
          }, { once: true }))
        }
        return new Response(completedAnswer(), { headers: { 'content-type': 'text/event-stream' } })
      }, outcome === 'timed-out' ? 20 : undefined)

      expect((await request(gateway)).status).toBe(429)
      now += 30_000
      const clientController = new AbortController()
      const recovery = request(gateway, 'deepseek', '{"input":[]}', outcome === 'cancelled' ? clientController.signal : undefined)
      const recoveryFailure = recovery.catch(error => error)
      await recoveryHasStarted
      if (outcome === 'cancelled') clientController.abort()
      await upstreamWasAborted
      if (outcome === 'cancelled') expect(await recoveryFailure).toBeInstanceOf(Error)
      else expect((await recovery).status).toBe(504)
      expect((await request(gateway)).status).toBe(200)
      expect(calls).toBe(3)
    }
  })

  it('本机并发槽已满时不遗留恢复资格', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let calls = 0
    const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://fixture.example/responses', key }
    const gateway = await start(route, async () => {
      calls += 1
      return calls === 1
        ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        : new Response(completedAnswer(), { headers: { 'content-type': 'text/event-stream' } })
    })

    expect((await request(gateway)).status).toBe(429)
    now += 30_000
    const internals = gateway as unknown as { controllers: Set<AbortController> }
    for (let index = 0; index < 16; index += 1) internals.controllers.add(new AbortController())
    expect((await request(gateway)).status).toBe(503)
    internals.controllers.clear()
    expect((await request(gateway)).status).toBe(200)
    expect(calls).toBe(2)
  })

  it('网关停止后重启不会保留旧短路', async () => {
    let calls = 0
    const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://fixture.example/responses', key }
    const gateway = await start(route, async () => {
      calls += 1
      return calls === 1
        ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        : new Response(completedAnswer(), { headers: { 'content-type': 'text/event-stream' } })
    })

    expect((await request(gateway)).status).toBe(429)
    await gateway.stop()
    await gateway.start(0, token)
    gateway.setRoutes([route])
    expect((await request(gateway)).status).toBe(200)
    expect(calls).toBe(2)
  })
})
