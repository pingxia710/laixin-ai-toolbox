import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AiGateway, type GatewayRoute } from '../../app/main/ai-access/gateway'

const token = 'laixin-fixture-client-token-0123456789'
const key = 'sk-fixture-upstream-key-0123456789'
type Json = Record<string, unknown>
const routes: GatewayRoute[] = ['codex', 'claude', 'hermes'].map(shell => ({ shell: shell as GatewayRoute['shell'], provider: 'deepseek', model: 'fixture-model', endpoint: 'https://api.deepseek.com/fixture', key }))
const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(g => g.stop())) })
async function start(fetcher: typeof fetch, timeoutMs = 500) {
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs })
  gateways.push(gateway)
  await gateway.start(0, token)
  gateway.setRoutes(routes)
  return gateway
}
describe('本机 API 服务', () => {
  it('拒绝未授权请求、网页跨站请求和未知路径，不接触上游', async () => {
    let calls = 0
    const g = await start(async () => { calls++; return new Response('{}') })
    expect((await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${g.baseUrl}/codex/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(404)
    expect((await fetch(`${g.baseUrl}/proxy?url=https://evil.example`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect(calls).toBe(0)
  })
  it('三个壳都把客户端令牌换成上游 Key，固定模型，并保留上游已验证支持的扩展字段', async () => {
    const received: { url: string; init: RequestInit }[] = []
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":4}}}\n\n'
    const g = await start(async (url, init) => { received.push({ url: String(url), init: init! }); return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) })
    for (const [shell, path] of [['codex','responses'], ['claude','messages'], ['hermes','chat/completions']]) {
      const response = await fetch(`${g.baseUrl}/${shell}/deepseek/v1/${path}${shell === 'claude' ? '?beta=true' : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', cookie: 'never-forward', 'anthropic-beta': 'unstable-feature', 'user-agent': 'native-client-fixture' }, body: JSON.stringify({ model: 'old-model', stream: true, context_management: { edit: 'private' }, tools: [{ type: 'function', name: 'example', cache_control: { type: 'ephemeral' } }], input: 'private prompt' }) })
      expect(await response.text()).toBe(sse)
    }
    expect(received).toHaveLength(3)
    for (const call of received) {
      const headers = new Headers(call.init.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${key}`)
      expect(headers.has('cookie')).toBe(false)
      expect(headers.get('anthropic-beta')).toBe('unstable-feature')
      expect(headers.get('user-agent')).toBe('native-client-fixture')
      expect(call.init.redirect).toBe('error')
      expect(JSON.parse(String(call.init.body))).toMatchObject({ model: 'fixture-model', stream: true, context_management: { edit: 'private' }, tools: [{ name: 'example', cache_control: { type: 'ephemeral' } }] })
    }
    const summary = g.snapshot()
    expect(summary.requests).toHaveLength(3)
    expect(summary.requests[0]).toMatchObject({ ok: true, inputTokens: 12, outputTokens: 4, source: 'client' })
    expect(JSON.stringify(summary)).not.toMatch(/private prompt|never-forward|fixture-upstream-key|fixture-client-token/)
  })
  it('200 但 SSE 错误或流未结束不算成功；隐藏上游错误原文', async () => {
    const g = await start(async () => new Response('data: {"type":"error","error":{"message":"private upstream detail"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const body = await response.text()
    expect(body).toContain('服务商返回异常')
    expect(body).not.toContain('private upstream detail')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'upstream_error' })
    expect(JSON.stringify(g.snapshot())).not.toContain('private upstream detail')
  })
  it('只有结束标记而没有模型文字的 JSON/SSE 都不能算接通或点亮客户端验收', async () => {
    const jsonGateway = await start(async () => Response.json({ status: 'completed', output: [] }))
    const jsonResponse = await fetch(`${jsonGateway.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(jsonResponse.status).toBe(502)
    expect(await jsonResponse.text()).toContain('接口没有返回有效模型回复')
    expect(jsonGateway.snapshot().requests[0]).toMatchObject({ ok: false, code: 'invalid_reply' })
    expect(jsonGateway.clientAcceptances()).toEqual({})

    const sseGateway = await start(async () => new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
    const sseResponse = await fetch(`${sseGateway.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    // A stream can already have committed its 200 header; its terminal local SSE error is the
    // protocol-safe failure signal, and the record remains failed.
    expect(await sseResponse.text()).toContain('invalid_reply')
    expect(sseGateway.snapshot().requests[0]).toMatchObject({ ok: false, code: 'invalid_reply' })
    expect(sseGateway.clientAcceptances()).toEqual({})
  })
  it.each([
    {
      shell: 'codex' as const,
      path: 'responses',
      sse: 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"customer_tool","arguments":"{}"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    },
    {
      shell: 'claude' as const,
      path: 'messages',
      sse: 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-1","name":"customer_tool","input":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    },
    {
      shell: 'hermes' as const,
      path: 'chat/completions',
      sse: 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"customer_tool","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    }
  ])('$shell 的完整工具调用 SSE 会透传给客户端，但不标记为已收到模型回答', async ({ shell, path, sse }) => {
    const g = await start(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/${shell}/deepseek/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(sse)
    expect(g.snapshot().requests[0]).toMatchObject({ shell, source: 'client', ok: true })
    expect(g.clientAcceptances()).toEqual({})
  })
  it.each([
    {
      shell: 'codex' as const,
      path: 'responses',
      sse: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"正在调用工具"}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"customer_tool","arguments":"{}"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    },
    {
      shell: 'claude' as const,
      path: 'messages',
      sse: 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":"正在调用工具"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-1","name":"customer_tool","input":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    },
    {
      shell: 'hermes' as const,
      path: 'chat/completions',
      sse: 'data: {"choices":[{"delta":{"content":"正在调用工具","tool_calls":[{"id":"call-1","function":{"name":"customer_tool","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    }
  ])('$shell 的带文字工具调用回合也不会误标为完整回答', async ({ shell, path, sse }) => {
    const g = await start(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/${shell}/deepseek/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(sse)
    expect(g.snapshot().requests[0]).toMatchObject({ shell, source: 'client', ok: true })
    expect(g.clientAcceptances()).toEqual({})
  })
  it('探测首程必须恰好获得一个 toolbox_probe 调用，两个调用不会假绿', async () => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      return Response.json({
        status: 'completed', output: [
          { type: 'function_call', name: 'toolbox_probe', call_id: 'call-1', arguments: '{}' },
          { type: 'function_call', name: 'toolbox_probe', call_id: 'call-2', arguments: '{}' }
        ]
      })
    })

    await expect(g.probe(routes[0])).resolves.toMatchObject({ ok: false, code: 'tool_call_failed' })
    expect(calls).toBe(1)
  })
  it.each([
    {
      shell: 'codex' as const,
      response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
    },
    {
      shell: 'claude' as const,
      response: { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] }
    },
    {
      shell: 'hermes' as const,
      response: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }
    }
  ])('$shell 的探测首程可接受完整直接回答', async ({ shell, response }) => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      return Response.json(response)
    })

    await expect(g.probe(routes.find(route => route.shell === shell)!)).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(1)
  })
  it('流式探测首程的文字加 toolbox_probe 仍需工具结果，纯文字直接回答才通过', async () => {
    const toolTurn = 'data: {"type":"response.output_text.delta","delta":"准备"}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"toolbox_probe","arguments":"{}"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const toolGateway = await start(async () => new Response(toolTurn, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(toolGateway.probe(routes[0])).resolves.toMatchObject({ ok: false, code: 'tool_call_failed' })

    const directTurn = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const directGateway = await start(async () => new Response(directTurn, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(directGateway.probe(routes[0])).resolves.toMatchObject({ ok: true })
  })
  it.each(['codex', 'claude', 'hermes'] as const)('%s 的探测第二程带工具调用不能冒充最终回答', async shell => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      if (calls === 1) {
        if (shell === 'codex') return Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'toolbox_probe', call_id: 'call-1', arguments: '{}' }] })
        if (shell === 'claude') return Response.json({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'toolbox_probe', id: 'tool-1', input: {} }] })
        return Response.json({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'toolbox_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
      }
      if (shell === 'codex') return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }, { type: 'function_call', name: 'customer_tool', call_id: 'call-2', arguments: '{}' }] })
      if (shell === 'claude') return Response.json({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'text', text: 'OK' }, { type: 'tool_use', name: 'customer_tool', id: 'tool-2', input: {} }] })
      return Response.json({ choices: [{ message: { content: 'OK', tool_calls: [{ id: 'call-2', function: { name: 'customer_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
    })

    await expect(g.probe(routes.find(route => route.shell === shell)!)).resolves.toMatchObject({ ok: false, code: 'tool_call_failed' })
    expect(calls).toBe(2)
  })
  it('HTTP 200 中的智谱套餐业务错误不算已接通，也不能标记为真实客户端验收', async () => {
    const g = await start(async () => Response.json({ code: 1309, message: 'private coding-plan detail' }))
    g.setRoutes([{ ...routes[0], provider: 'zhipu', model: 'glm-5.3-flash', endpoint: 'https://open.bigmodel.cn/api/v1/responses' }])

    const response = await fetch(`${g.baseUrl}/codex/zhipu/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(g.snapshot().requests[0]).toMatchObject({ shell: 'codex', provider: 'zhipu', ok: false, code: 'coding_plan_expired' })
    expect(g.clientAcceptances()).toEqual({})
    expect(body).toContain('GLM Coding Plan 套餐已到期')
    expect(body).not.toContain('private coding-plan detail')
    expect(JSON.stringify(g.snapshot())).not.toContain('private coding-plan detail')
  })
  it('HTTP 200 的 Kimi SSE 认证错误首轮按 Key 未通过处理，不凭同名错误码猜产品错配', async () => {
    const g = await start(async () => new Response('event: error\ndata: {"code":"invalid_token","message":"private Kimi detail"}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
    g.setRoutes([{ ...routes[2], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/chat/completions' }])

    const response = await fetch(`${g.baseUrl}/hermes/kimi/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain('Key 未通过认证')
    expect(body).not.toContain('invalid_token')
    expect(body).not.toContain('private Kimi detail')
    expect(g.snapshot().requests[0]).toMatchObject({ shell: 'hermes', provider: 'kimi', ok: false, code: 'key_rejected' })
    expect(JSON.stringify(g.snapshot())).not.toContain('invalid_token')
  })

  it('只有 SSE error 事件名也不透传为成功回复', async () => {
    const g = await start(async () => new Response('event: error\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('服务商返回异常')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'upstream_error' })
  })
  it('HTTP 401 不是接通；诊断中不保留服务商返回的敏感文字', async () => {
    const g = await start(async () => new Response(`invalid ${key}`, { status: 401 }))
    const response = await fetch(`${g.baseUrl}/hermes/deepseek/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).not.toContain(key)
    expect(body).not.toContain('Laixin API:')
    expect(body).toContain('Key 未通过认证')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'key_rejected' })
  })

  it('多帧正常 SSE 保持透明转发并正确结束，不会在第二帧重新写响应头', async () => {
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const g = await start(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(sse)
    expect(g.snapshot().requests[0]).toMatchObject({ ok: true, source: 'client' })
  })

  it('没有 SSE 事件边界的超长上游回复会在本机受限丢弃，不积累内存或透传原文', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill('x'.charCodeAt(0))
    const g = await start(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 33; index += 1) controller.enqueue(chunk)
        controller.close()
      }
    }), { headers: { 'content-type': 'text/event-stream' } }), 10_000)
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(response.status).toBe(413)
    const body = await response.text()
    expect(body).toContain('转发上限')
    expect(body).not.toContain('xxxxx')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'payload_too_large' })
  })

  it('客户端认证失败后的自动重试在同一路由版本内不再直打上游，换 Key 后立即解除短路', async () => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      return new Response('private invalid_api_key detail', { status: 401 })
    })
    const request = () => fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":[]}'
    })

    expect((await request()).status).toBe(400)
    const retried = await request()
    expect(retried.status).toBe(400)
    expect(await retried.text()).toContain('Key 未通过认证')
    expect(calls).toBe(1)
    expect(g.snapshot().requests.filter(record => record.source === 'client' && record.code === 'key_rejected')).toHaveLength(2)

    g.setRoutes([{ ...routes[0], key: 'sk-fixture-upstream-key-replaced-0123456789' }])
    expect((await request()).status).toBe(400)
    expect(calls).toBe(2)
  })

  it('同一供应商同一把 Key 重新探测成功后立即解除客户端短路，不再吃 30 秒缓存错误', async () => {
    let calls = 0
    let healthy = false
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'
    const g = await start(async () => {
      calls += 1
      return healthy ? new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
        : new Response('private invalid_api_key detail', { status: 401 })
    })
    const request = () => fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":[]}'
    })

    expect((await request()).status).toBe(400)
    await request()
    expect(calls).toBe(1)

    // 上游恢复；客户在工具箱里「重新测试」——探测走直连必须成功，并立刻清掉这条绑定的短路。
    healthy = true
    const probe = await g.probe(routes[0])
    expect(probe.ok).toBe(true)
    expect(calls).toBe(2)

    // 同一把 Key 的客户端请求随即放行并真实打到上游，而不是等 30 秒自然过期。
    const unblocked = await request()
    expect(unblocked.status).toBe(200)
    expect(calls).toBe(3)
  })

  it('探测的是另一家供应商时不误清当前路由的短路', async () => {
    let healthy = false
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'
    const g = await start(async () => {
      return healthy ? new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
        : new Response('private invalid_api_key detail', { status: 401 })
    })
    const request = () => fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":[]}'
    })
    expect((await request()).status).toBe(400)
    await request()

    // 用另一家（Kimi）的绑定探测成功：codex/deepseek 路由上的短路必须原样保留。
    healthy = true
    const other = await g.probe({ ...routes[0], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' })
    expect(other.ok).toBe(true)
    const stillBlocked = await request()
    expect(stillBlocked.status).toBe(400)
    expect((await stillBlocked.text()).length).toBeGreaterThan(0)
  })

  it('上游 429 限流进重试短路:客户端内建的连发重试不再全额打上游(Phase 1 429 短窗)', async () => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      return new Response('{"error":{"message":"slow down"}}', { status: 429 })
    })
    const request = () => fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":[]}'
    })

    // 第一发真打上游,拿到真实限流与状态
    expect((await request()).status).toBe(429)
    expect(calls).toBe(1)
    // 客户端内建重试(通常连发 8 次):本地理应短路成 429,⛔ 全额再打会被上游拉黑
    const retried = await request()
    expect(retried.status).toBe(429)
    expect(await retried.text()).toContain('稍后重试')
    expect(calls).toBe(1)
  })

  it('客户端自动取消不解除既有重试短路或抹掉连续超时计数', async () => {
    let calls = 0
    const g = await start(async () => { calls += 1; return Response.json({ status: 'completed', output: [] }) })
    const route = { ...routes[0], revision: 'retry-fixture' }
    g.setRoutes([route])
    const gateway = g as unknown as {
      updateRetryBlock: (route: GatewayRoute, record: { ok: boolean; code?: string }) => void
      escalateTimeouts: (route: GatewayRoute, code: 'timeout' | 'client_aborted') => string
    }
    gateway.updateRetryBlock(route, { ok: false, code: 'key_rejected' })
    gateway.updateRetryBlock(route, { ok: false, code: 'client_aborted' })

    const blocked = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(blocked.status).toBe(400)
    expect(calls).toBe(0)
    expect(gateway.escalateTimeouts(route, 'timeout')).toBe('timeout')
    expect(gateway.escalateTimeouts(route, 'client_aborted')).toBe('client_aborted')
    expect(gateway.escalateTimeouts(route, 'timeout')).toBe('timeout')
    expect(gateway.escalateTimeouts(route, 'timeout')).toBe('provider_outage')
  })

  it('产品错配和已明确的套餐额度、并发失败也会短路客户端重试，手动探测仍可直达上游', async () => {
    const cases: readonly { name: string; route: GatewayRoute; response: Response; code: string; expectedStatus: number }[] = [
      { name: 'Kimi Key 未通过认证', route: { ...routes[0], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' }, response: new Response('{"error":{"code":"invalid_token","message":"private key detail"}}', { status: 401 }), code: 'key_rejected', expectedStatus: 400 },
      { name: 'Kimi 套餐额度', route: { ...routes[0], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' }, response: new Response('{"error":{"message":"private quota detail"}}', { status: 403 }), code: 'membership_quota_exhausted', expectedStatus: 429 },
      { name: 'Kimi 套餐并发', route: { ...routes[0], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' }, response: new Response('{"error":{"message":"private concurrent request limit"}}', { status: 403 }), code: 'membership_concurrency_limited', expectedStatus: 429 },
      { name: '智谱套餐额度', route: { ...routes[0], provider: 'zhipu', model: 'glm-5.3-flash', endpoint: 'https://open.bigmodel.cn/api/v1/responses' }, response: Response.json({ code: 1310, message: 'private coding quota detail' }), code: 'coding_plan_quota_exhausted', expectedStatus: 429 }
    ]
    for (const fixture of cases) {
      let calls = 0
      const g = await start(async () => { calls += 1; return fixture.response.clone() })
      g.setRoutes([fixture.route])
      const url = `${g.baseUrl}/codex/${fixture.route.provider}/v1/responses`
      const first = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
      const second = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
      expect(first.status, fixture.name).toBe(fixture.expectedStatus)
      expect(second.status, fixture.name).toBe(fixture.expectedStatus)
      expect(await second.text(), fixture.name).not.toContain('private')
      expect(calls, fixture.name).toBe(1)
      expect(g.snapshot().requests[0], fixture.name).toMatchObject({ code: fixture.code })
    }

    let calls = 0
    const g = await start(async () => {
      calls += 1
      if (calls === 1) return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 })
      if (calls === 2) return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] })
      return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const url = `${g.baseUrl}/codex/deepseek/v1/responses`
    await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    await expect(g.probe(routes[0])).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(3)
  })

  it.each(['codex', 'claude', 'hermes'] as const)('%s 收到额度限制时只展示中文恢复时间和工具箱入口', async shell => {
    let upstreamCalls = 0
    const g = await start(async () => {
      upstreamCalls += 1
      return new Response('{"error":{"message":"private upstream quota detail","retry_after":120}}', { status: 429 })
    })
    const route = { ...routes.find(item => item.shell === shell)!, provider: 'kimi' as const, model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' }
    g.setRoutes([route])
    const path = shell === 'codex' ? 'responses' : shell === 'claude' ? 'messages' : 'chat/completions'
    const response = await fetch(`${g.baseUrl}/${shell}/kimi/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const payload = await response.json() as { error: { type: string; message: string } }

    expect(response.status).toBe(429)
    expect(payload.error.type).toBe('membership_rate_limited')
    expect(payload.error.message).toContain('服务商预计于')
    expect(payload.error.message).toContain('打开来信工具箱查看处理办法')
    expect(payload.error.message).not.toContain('private upstream quota detail')
    expect(JSON.stringify(g.snapshot())).not.toContain('private upstream quota detail')

    const retried = await fetch(`${g.baseUrl}/${shell}/kimi/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const retryPayload = await retried.json() as { error: { message: string } }
    expect(retryPayload.error.message).toContain('服务商预计于')
    expect(retryPayload.error.message).not.toContain('private upstream quota detail')
    expect(upstreamCalls).toBe(1)
  })

  it('HTTP 200 包着的流式 Kimi 套餐额度错误也改成安全的 429 恢复提示', async () => {
    const g = await start(async () => new Response('event: error\ndata: {"error":{"message":"You have reached your 5-hour usage limit; private upstream detail","retry_after":120}}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
    g.setRoutes([{ ...routes[0], provider: 'kimi', model: 'kimi-for-coding', endpoint: 'https://api.kimi.com/coding/v1/responses' }])
    const response = await fetch(`${g.baseUrl}/codex/kimi/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const payload = await response.json() as { error: { type: string; message: string } }

    expect(response.status).toBe(429)
    expect(payload.error.type).toBe('membership_quota_exhausted')
    expect(payload.error.message).toContain('服务商预计于')
    expect(payload.error.message).toContain('打开来信工具箱查看处理办法')
    expect(payload.error.message).not.toContain('private upstream detail')
    expect(JSON.stringify(g.snapshot())).not.toContain('private upstream detail')
  })

  it.each(['codex', 'claude', 'hermes'] as const)('%s 的探测首程可完成受控 toolbox_probe，但客户空回复仍失败', async shell => {
    let calls = 0
    const g = await start(async () => {
      calls += 1
      if (calls > 2) return Response.json({ status: 'completed', output: [] })
      if (shell === 'codex') return calls === 1
        ? Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'toolbox_probe', call_id: 'call-1', arguments: '{}' }] })
        : Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
      if (shell === 'claude') return calls === 1
        ? Response.json({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'toolbox_probe', id: 'tool-1', input: {} }] })
        : Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
      return calls === 1
        ? Response.json({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'toolbox_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
        : Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    })
    const route = routes.find(item => item.shell === shell)!
    await expect(g.probe(route)).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(2)

    const empty = await fetch(`${g.baseUrl}/${shell}/deepseek/v1/${shell === 'codex' ? 'responses' : shell === 'claude' ? 'messages' : 'chat/completions'}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(empty.status).toBe(502)
    expect(g.snapshot().requests.at(0)).toMatchObject({ source: 'client', ok: false, code: 'invalid_reply' })
  })

  it('Claude 的白名单小模型会透传；未知客户端模型仍固定为当前主模型', async () => {
    const received: Json[] = []
    const g = await start(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)) as Json)
      return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    })
    g.setRoutes([{ ...routes[1], model: 'deepseek-v4-pro' }])
    const call = (model: string) => fetch(`${g.baseUrl}/claude/deepseek/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages: [] })
    })

    expect((await call('deepseek-v4-flash')).status).toBe(200)
    expect((await call('client-unknown-model')).status).toBe(200)
    expect(received.map(body => body.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(g.snapshot().requests.map(record => record.model)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
  })

  it('Hermes DeepSeek 的 JSON Schema 请求统一降级为兼容的 JSON object', async () => {
    const received: Json[] = []
    const g = await start(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)) as Json)
      return Response.json({ choices: [{ message: { content: '{"title":"排查配置"}' }, finish_reason: 'stop' }] })
    })
    const titleRequest = {
      model: 'client-stale-model', max_tokens: 64, temperature: 0.3,
      messages: [{ role: 'system', content: 'You name chat sessions. Write a short title.' }, { role: 'user', content: '排查配置' }],
      response_format: { type: 'json_schema', json_schema: { name: 'session_title', strict: true, schema: { type: 'object' } } }
    }
    const response = await fetch(`${g.baseUrl}/hermes/deepseek/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(titleRequest)
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(received[0].response_format).toEqual({ type: 'json_object' })
    expect(received[0].model).toBe('fixture-model')
    expect(g.snapshot().requests[0]).toMatchObject({ shell: 'hermes', provider: 'deepseek', ok: true })

    const normalStructuredOutput = { ...titleRequest, response_format: { type: 'json_schema', json_schema: { name: 'customer_schema', strict: true, schema: { type: 'object' } } } }
    const normal = await fetch(`${g.baseUrl}/hermes/deepseek/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(normalStructuredOutput)
    })
    expect(normal.status).toBe(200)
    await normal.text()
    expect(received[1].response_format).toEqual({ type: 'json_object' })
  })

  it('已经完整收到上游回复时，随后下游 close 的竞态不能反写成 client_aborted', async () => {
    class LateCloseResponse extends EventEmitter {
      writableFinished = false
      writableEnded = false
      destroyed = false
      headersSent = false
      statusCode = 0
      setHeader(): void {}
      flushHeaders(): void { this.headersSent = true }
      write(): boolean { return true }
      end(): void {
        this.writableEnded = true
        this.emit('close')
        throw new Error('socket closed after complete reply')
      }
      destroy(): void { this.destroyed = true }
    }
    const g = await start(async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))
    const downstream = new LateCloseResponse()
    const request = (g as unknown as { request: (route: GatewayRoute, body: Json, source: 'test' | 'client', downstream: unknown) => Promise<{ record: { ok: boolean; code?: string } }> }).request
    const result = await request.call(g, routes[0], { input: [] }, 'client', downstream)
    expect(result.record).toMatchObject({ ok: true })
    expect(result.record.code).toBeUndefined()
  })

  it('流式 SSE 已完整读完后，下游 late close 也保持客户端调用成功', async () => {
    class LateCloseStreamResponse extends EventEmitter {
      writableFinished = false
      writableEnded = false
      destroyed = false
      headersSent = false
      statusCode = 0
      readonly frames: string[] = []
      setHeader(): void {}
      flushHeaders(): void { this.headersSent = true }
      write(chunk: string | Buffer): boolean { this.frames.push(String(chunk)); return true }
      end(): void {
        this.writableEnded = true
        this.emit('close')
        throw new Error('socket closed after complete SSE reply')
      }
      destroy(): void { this.destroyed = true }
    }
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const encoder = new TextEncoder()
    const g = await start(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse.slice(0, 37)))
        controller.enqueue(encoder.encode(sse.slice(37)))
        controller.close()
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const downstream = new LateCloseStreamResponse()
    const request = (g as unknown as { request: (route: GatewayRoute, body: Json, source: 'test' | 'client', downstream: unknown) => Promise<{ record: { ok: boolean; code?: string } }> }).request

    const result = await request.call(g, routes[0], { input: [], stream: true }, 'client', downstream)

    expect(downstream.frames.join('')).toBe(sse)
    expect(result.record).toMatchObject({ ok: true })
    expect(result.record.code).toBeUndefined()
  })

  it('收到 SSE 终止回答后原生客户端先断开、上游尚未 EOF 时仍记录成功', async () => {
    class TerminalCloseResponse extends EventEmitter {
      writableFinished = false
      writableEnded = false
      destroyed = false
      headersSent = false
      statusCode = 0
      setHeader(): void {}
      flushHeaders(): void { this.headersSent = true }
      write(chunk: string | Buffer): boolean {
        if (String(chunk).includes('response.completed')) this.emit('close')
        return true
      }
      end(): void { this.writableEnded = true }
      destroy(): void { this.destroyed = true }
    }
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    const encoder = new TextEncoder()
    const g = await start(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(sse))
        ;(init!.signal as AbortSignal).addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true })
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const downstream = new TerminalCloseResponse()
    const controller = new AbortController()
    downstream.once('close', () => controller.abort())
    const request = (g as unknown as { request: (route: GatewayRoute, body: Json, source: 'test' | 'client', downstream: unknown, controller: AbortController) => Promise<{ record: { ok: boolean; code?: string } }> }).request

    const result = await request.call(g, routes[0], { input: [], stream: true }, 'client', downstream, controller)

    expect(result.record).toMatchObject({ ok: true })
    expect(result.record.code).toBeUndefined()
  })

  it('真实 HTTP handler 在 Hermes 收到终态块后先断开时仍记录完整回答成功', async () => {
    let upstreamAborted!: () => void
    const abortObserved = new Promise<void>(resolve => { upstreamAborted = resolve })
    const sse = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    const encoder = new TextEncoder()
    const g = await start(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(sse))
        ;(init!.signal as AbortSignal).addEventListener('abort', () => {
          upstreamAborted()
          stream.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      }
    }), { headers: { 'content-type': 'text/event-stream' } }), 10_000)
    await new Promise<void>((resolve, reject) => {
      let terminalReceived = false
      const request = httpRequest(`${g.baseUrl}/hermes/deepseek/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      }, response => {
        response.on('data', chunk => {
          if (String(chunk).includes('"finish_reason":"stop"')) {
            terminalReceived = true
            request.destroy()
          }
        })
        response.once('close', resolve)
        response.once('error', error => terminalReceived ? resolve() : reject(error))
      })
      request.once('error', error => terminalReceived ? resolve() : reject(error))
      request.end(JSON.stringify({ messages: [{ role: 'user', content: 'Reply only OK.' }], stream: true }))
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('client close did not abort upstream promptly')), 1_000)
      void abortObserved.then(() => { clearTimeout(timeout); resolve() })
    })
    for (let attempt = 0; attempt < 20 && g.snapshot().requests.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(g.snapshot().requests[0]).toMatchObject({ shell: 'hermes', source: 'client', ok: true })
    expect(g.snapshot().requests[0].code).toBeUndefined()
    expect(g.clientAcceptances().hermes).toMatchObject({ provider: 'deepseek' })
  })

  it('Hermes 只有文本未收到终态就断开时仍记为中止，不能点亮已使用', async () => {
    let upstreamAborted!: () => void
    const abortObserved = new Promise<void>(resolve => { upstreamAborted = resolve })
    const sse = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n'
    const encoder = new TextEncoder()
    const g = await start(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(sse))
        ;(init!.signal as AbortSignal).addEventListener('abort', () => {
          upstreamAborted()
          stream.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      }
    }), { headers: { 'content-type': 'text/event-stream' } }), 10_000)
    await new Promise<void>((resolve, reject) => {
      let textReceived = false
      const request = httpRequest(`${g.baseUrl}/hermes/deepseek/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      }, response => {
        response.on('data', chunk => {
          if (String(chunk).includes('"content":"OK"')) {
            textReceived = true
            request.destroy()
          }
        })
        response.once('close', resolve)
        response.once('error', error => textReceived ? resolve() : reject(error))
      })
      request.once('error', error => textReceived ? resolve() : reject(error))
      request.end(JSON.stringify({ messages: [{ role: 'user', content: 'Reply only OK.' }], stream: true }))
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('client close did not abort upstream promptly')), 1_000)
      void abortObserved.then(() => { clearTimeout(timeout); resolve() })
    })
    for (let attempt = 0; attempt < 20 && g.snapshot().requests.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
    expect(g.snapshot().requests[0]).toMatchObject({ shell: 'hermes', source: 'client', ok: false, code: 'client_aborted' })
    expect(g.clientAcceptances().hermes).toBeUndefined()
  })

  it('本机并发达到上限时从读入请求体前就拒绝，使用 local_service_busy 而不是上游限流', async () => {
    let release: (() => void) | undefined
    let seen = 0
    const allSeen = new Promise<void>(resolve => {
      release = () => resolve()
    })
    const g = await start(async () => {
      seen += 1
      await allSeen
      return Response.json({ status: 'completed', output: [] })
    }, 10_000)
    const requests = Array.from({ length: 16 }, () => fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    }))
    try {
      for (let attempt = 0; attempt < 100 && seen < 16; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
      expect(seen).toBe(16)

      const rejected = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
      })
      expect(rejected.status).toBe(503)
      expect(await rejected.json()).toMatchObject({ error: { type: 'local_service_busy', message: '工具箱本机同时处理的请求较多，请稍候重试。打开来信工具箱查看处理办法。' } })
      expect(seen).toBe(16)
    } finally {
      release!()
      await Promise.allSettled(requests)
    }
  })

  it('16 条慢上传尚未读完 body 时，第 17 条声明超大 body 也会立即被本机拒绝，完全不触上游', async () => {
    let upstreamCalls = 0
    const g = await start(async () => { upstreamCalls += 1; return Response.json({ status: 'completed', output: [] }) }, 10_000)
    const held = Array.from({ length: 16 }, () => {
      const request = httpRequest(`${g.baseUrl}/codex/deepseek/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      })
      request.on('error', () => undefined)
      request.write('{"input":')
      return request
    })
    const controllers = (g as unknown as { controllers: Set<AbortController> }).controllers
    try {
      for (let attempt = 0; attempt < 100 && controllers.size < 16; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
      expect(controllers.size).toBe(16)

      const rejected = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(`${g.baseUrl}/codex/deepseek/v1/responses`, {
          method: 'POST', headers: {
            authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(32 * 1024 * 1024 + 1)
          }
        }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.once('error', reject)
        request.flushHeaders()
      })
      expect(rejected).toMatchObject({ status: 503 })
      expect(rejected.body).toContain('local_service_busy')
      expect(upstreamCalls).toBe(0)
    } finally {
      for (const request of held) request.destroy()
    }
  })
  it('停用路由后旧客户端不能继续调用', async () => {
    const g = await start(async () => new Response('{}'))
    g.setRoutes([])
    expect((await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(409)
  })

  it('路由版本变化后，切换前已在路上的成功请求不能证明新 API 已被客户端使用', async () => {
    let release: ((response: Response) => void) | undefined
    let observed: (() => void) | undefined
    const upstreamObserved = new Promise<void>(resolve => { observed = resolve })
    const g = await start(async () => {
      observed!()
      return new Promise<Response>(resolve => { release = resolve })
    })
    const request = fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    await upstreamObserved
    // 即使服务商与地址不变，只要 Key 绑定已换，旧请求也不再能证明当前绑定已经在被使用。
    g.setRoutes([{ ...routes[0], key: 'sk-fixture-replaced-upstream-key-0123456789' }])
    release!(Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))
    expect((await request).status).toBe(200)

    expect(g.clientAcceptances()).toEqual({})
    expect(g.clientCalls()).toEqual({})
  })

  it('回答被 max_tokens 截断单独判类，⛔ 报成服务商故障；正常回答仍判通过（第 4 轮）', async () => {
    // 推理型模型把预算花在思考上：stop_reason=max_tokens、正文可能为空——这不是服务商坏了。
    const truncatedClaude = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":40}}',
      'data: {"type":"message_stop"}',
      'data: [DONE]', ''
    ].join('\n\n')
    const truncatedHermes = JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 40 }
    })
    const normalClaude = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}',
      'data: {"type":"message_stop"}',
      'data: [DONE]', ''
    ].join('\n\n')

    const truncated = await start(async () => new Response(truncatedClaude, { headers: { 'content-type': 'text/event-stream' } }))
    const result = await truncated.probe(routes.find(route => route.shell === 'claude')!)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('response_truncated')
    expect(result.code).not.toBe('upstream_error')

    const openAiStyle = await start(async () => new Response(truncatedHermes, { headers: { 'content-type': 'application/json' } }))
    await expect(openAiStyle.probe(routes.find(route => route.shell === 'hermes')!))
      .resolves.toMatchObject({ ok: false, code: 'response_truncated' })

    const healthy = await start(async () => new Response(normalClaude, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(healthy.probe(routes.find(route => route.shell === 'claude')!)).resolves.toMatchObject({ ok: true })
  })

  it('Responses 协议的回答截断单独判类，⛔ 报成服务商故障（API-05）', async () => {
    // 流式：response.incomplete 事件，reason=max_tokens（流式事件参考口径）。
    const incompleteStream = [
      'data: {"type":"response.output_text.delta","delta":"部分回答"}',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_tokens"},"usage":{"input_tokens":10,"output_tokens":40}}}',
      ''
    ].join('\n\n')
    // 非流式：response 对象本身 status=incomplete，reason=max_output_tokens（对象字段文档拼写）。
    const incompleteJson = JSON.stringify({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '部分回答' }] }],
      usage: { input_tokens: 10, output_tokens: 40 }
    })

    const streaming = await start(async () => new Response(incompleteStream, { headers: { 'content-type': 'text/event-stream' } }))
    await expect(streaming.probe(routes.find(route => route.shell === 'codex')!))
      .resolves.toMatchObject({ ok: false, code: 'response_truncated' })

    const nonStreaming = await start(async () => new Response(incompleteJson, { headers: { 'content-type': 'application/json' } }))
    await expect(nonStreaming.probe(routes.find(route => route.shell === 'codex')!))
      .resolves.toMatchObject({ ok: false, code: 'response_truncated' })

    // 客户的请求同样要拿到「回答过长」，而不是「服务商返回异常」。
    const client = await start(async () => new Response(incompleteJson, { headers: { 'content-type': 'application/json' } }))
    const response = await fetch(`${client.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const body = await response.text()
    expect(body).toContain('回答太长')
    expect(body).not.toContain('服务商返回异常')
    expect(client.snapshot().requests[0]).toMatchObject({ ok: false, code: 'response_truncated' })
  })

  it('请求超过本机 32MB 转发上限：如实说超出上限并留记录，⛔ 说成「无有效回复」（API-07）', async () => {
    const g = await start(async () => { throw new Error('must not reach upstream') })
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'x'.repeat(32 * 1024 * 1024 + 1)
    })
    expect(response.status).toBe(413)
    const body = await response.text()
    expect(body).toContain('转发上限')
    expect(body).not.toContain('没有返回有效模型回复')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'payload_too_large', source: 'client' })
  })

  it('上游回复超过本机 32MB 转发上限：如实说超出上限，⛔ 说成网络未连接或无有效回复（API-07）', async () => {
    const oversized = 'x'.repeat(32 * 1024 * 1024 + 1)
    const nonStreaming = await start(async () => new Response(oversized, { headers: { 'content-type': 'application/json' } }))
    const response = await fetch(`${nonStreaming.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(413)
    const body = await response.text()
    expect(body).toContain('转发上限')
    expect(body).not.toContain('未连接到服务商')
    expect(nonStreaming.snapshot().requests[0]).toMatchObject({ ok: false, code: 'payload_too_large' })

    const oneEvent = `data: {"type":"response.output_text.delta","delta":"${'x'.repeat(32 * 1024 * 1024)}"}\n\n`
    const streaming = await start(async () => new Response(oneEvent, { headers: { 'content-type': 'text/event-stream' } }))
    const sseResponse = await fetch(`${streaming.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(sseResponse.status).toBe(413)
    expect(await sseResponse.text()).toContain('转发上限')
    expect(streaming.snapshot().requests[0]).toMatchObject({ ok: false, code: 'payload_too_large' })
  })

  // ── API-08：转发路径空闲超时 ──
  type RequestRecord = ReturnType<AiGateway['snapshot']>['requests'][number]
  /** 记录在响应落定之后才写入（destroy/end 先于 recordClientResult），按条数轮询等它。 */
  async function waitForRecord(gateway: AiGateway, count: number): Promise<RequestRecord> {
    for (let attempt = 0; attempt < 400 && gateway.snapshot().requests.length < count; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const records = gateway.snapshot().requests
    expect(records.length, `网关应记下第 ${count} 条请求`).toBeGreaterThanOrEqual(count)
    return records[0]
  }
  /** 上游收到请求后先吐一段就永远沉默；abort 时把流收尾，模拟真实的空闲断流。 */
  function streamHeadThenSilence(_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const encoder = new TextEncoder()
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"开了个头"}\n\n'))
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
  }

  it('还在正常出字的长回答不被总时长硬掐断（API-08）', async () => {
    const encoder = new TextEncoder()
    const frames = Array.from({ length: 50 }, (_, index) =>
      `data: {"type":"response.output_text.delta","delta":"第${index}段"}\n\n`)
    frames.push('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":50}}}\n\n')
    const g = await start(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0
        let stopped = false
        init?.signal?.addEventListener('abort', () => { stopped = true; controller.error(new DOMException('aborted', 'AbortError')) }, { once: true })
        const tick = (): void => {
          if (stopped) return
          if (index >= frames.length) { controller.close(); return }
          controller.enqueue(encoder.encode(frames[index]))
          index += 1
          setTimeout(tick, 20)
        }
        tick()
      }
    }), { headers: { 'content-type': 'text/event-stream' } }), 400)
    // 总时长约 1 秒，远超 400ms；但每 20ms 都有数据流动，空闲从不达标。
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    const text = await response.text().catch(() => '')
    const record = await waitForRecord(g, 1)
    expect(record).toMatchObject({ source: 'client', ok: true })
    expect(record.code).toBeUndefined()
    expect(record.durationMs).toBeGreaterThan(400)
    expect(text).toContain('response.completed')
  }, 10_000)

  it('上游真空闲达到上限仍然判 timeout，⛔ 放走真卡死（API-08）', async () => {
    const g = await start(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }), 300)
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
    })
    expect(response.status).toBe(504)
    expect(await response.text()).toContain('超时')
    expect(await waitForRecord(g, 1)).toMatchObject({ source: 'client', ok: false, code: 'timeout' })
  }, 10_000)

  it('有过数据流动的超时不再连坐成「厂商侧故障」，健康厂商不被误报（API-08）', async () => {
    const g = await start(streamHeadThenSilence, 300)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
      })
      // 首段已按 200 开流，空闲超时只能掐断流；记录先落，再限时排空可能被 destroy 的响应。
      const record = await waitForRecord(g, attempt)
      await Promise.race([response.text().catch(() => ''), new Promise(resolve => setTimeout(resolve, 500))])
      expect(record, `第 ${attempt} 次「动过再停」的超时不该算厂商账`).toMatchObject({ source: 'client', ok: false, code: 'timeout' })
    }
    expect(JSON.stringify(g.snapshot())).not.toContain('provider_outage')
  }, 15_000)

  it('上游零数据的空闲超时照旧三次连坐升级「厂商侧故障」（API-08 守卫）', async () => {
    const g = await start(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }), 300)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
      })
      // 升级改判发生在下游响应之后：响应恒为 504/timeout，provider_outage 落在记录里。
      expect(response.status, `第 ${attempt} 次真空闲超时`).toBe(504)
      const record = await waitForRecord(g, attempt)
      expect(record).toMatchObject({ source: 'client', ok: false, code: attempt === 3 ? 'provider_outage' : 'timeout' })
    }
  }, 15_000)

  it('已开始流式转发后再遇超上限事件：原流内追加 payload_too_large 错误事件收尾，HTTP 状态不再改变（API-07 复核）', async () => {
    const encoder = new TextEncoder()
    const g = await start(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"部分回答"}\n\n'))
        controller.enqueue(encoder.encode(`data: {"type":"response.output_text.delta","delta":"${'x'.repeat(32 * 1024 * 1024 + 16)}"}\n\n`))
        controller.close()
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    // 部分内容已按 200 开始转发，HTTP 状态收不回来；超上限只能在原流里以错误事件收尾。
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('部分回答')
    expect(text).toContain('event: error')
    expect(text).toContain('payload_too_large')
    expect(text).toContain('转发上限')
    expect(g.snapshot().requests[0]).toMatchObject({ ok: false, code: 'payload_too_large' })
  })

  // ── API-10：点测试/启用要么快点有结果、要么能取消 ──

  it('测速黑洞用默认超时 15 秒内如实返回失败，客户不再干等 45 秒（API-10）', async () => {
    // 不注入 options.timeoutMs：守的正是生产默认值（⛔ 改回 45 秒这条用例必须红）。
    const g = new AiGateway({ fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }) })
    gateways.push(g)
    await g.start(0, token)
    g.setRoutes(routes)
    const started = Date.now()
    await expect(g.probe(routes[0])).resolves.toMatchObject({ ok: false, code: 'timeout' })
    expect(Date.now() - started).toBeLessThanOrEqual(20_500)
  }, 60_000)

  it('取消检查：在飞测速请求真被中止，按取消计类而不是网络故障（API-10）', async () => {
    let upstreamAborted = false
    const g = new AiGateway({ fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { upstreamAborted = true; reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    }) })
    gateways.push(g)
    await g.start(0, token)
    g.setRoutes(routes)
    const pending = g.probe(routes[0])
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(g.cancelTests()).toBe(1)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'client_aborted' })
    expect(upstreamAborted).toBe(true)
    expect(g.snapshot().requests[0]).toMatchObject({ source: 'test', ok: false, code: 'client_aborted' })
    // 没有在飞请求时取消是空操作。
    expect(g.cancelTests()).toBe(0)
  })

  it('probe 首轮失败立即返回，第二轮不发出（API-10 钉守：最坏等待只按轮数×单轮预算计）', async () => {
    let calls = 0
    const g = await start(async () => { calls += 1; return Response.json({ error: { message: 'no' } }, { status: 500 }) })
    await expect(g.probe(routes[0])).resolves.toMatchObject({ ok: false })
    expect(calls).toBe(1)
  })

  // Phase 2 ⑧:stop() 中止在途客户端请求是工具箱自己在关机/换端口,不是「连不上服务商」——
  // ⛔ 记成 network_error 污染回执与 FB-1 故障统计(那会让 M1 密度虚高、把排查引向网络)。
  it('stop() 中止在途客户端请求不记 network_error,不进故障统计', async () => {
    let signalUpstreamStarted!: () => void
    const upstreamStarted = new Promise<void>(resolve => { signalUpstreamStarted = resolve })
    const g = await start((_url, init) => {
      signalUpstreamStarted()
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('fixture aborted by stop()')))
      })
    }, 30_000)
    const failures: string[] = []
    g.onClientFailure(record => failures.push(record.code ?? ''))
    const pending = fetch(`${g.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ input: 'x', stream: true })
    }).catch(() => 'disconnected')
    await upstreamStarted
    await new Promise(resolve => setTimeout(resolve, 10))
    await g.stop()
    await pending
    expect(failures).toEqual([])
    expect(g.snapshot().requests.some(record => record.code === 'network_error')).toBe(false)
  })
})
