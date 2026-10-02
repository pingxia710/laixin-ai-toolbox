import { afterEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })
const token = 'fixture-refusal-token'
const refusal = 'I cannot help with that request.'
const formats = [
  { shell: 'codex' as const, path: 'responses',
    json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal }] }] },
    stream: `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: refusal })}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n` },
  { shell: 'hermes' as const, path: 'chat/completions',
    json: { choices: [{ finish_reason: 'stop', message: { content: null, refusal } }] },
    stream: `data: ${JSON.stringify({ choices: [{ delta: { refusal }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` }
]

async function fixture(format: typeof formats[number], response: () => Response) {
  const gateway = new AiGateway({ fetch: async () => response(), timeoutMs: 1000 })
  gateways.push(gateway)
  await gateway.start(0, token)
  const route = { shell: format.shell, provider: 'deepseek' as const, model: 'fixture-model', endpoint: 'https://api.deepseek.com/fixture', key: 'sk-fixture-0123456789012345' }
  gateway.setRoutes([route])
  return { gateway, route, call: () => fetch(`${gateway.baseUrl}/${format.shell}/deepseek/v1/${format.path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
  }) }
}

describe('合法拒答与接口故障区分', () => {
  for (const format of formats) it.each([false, true])(`${format.shell} 拒答原样交付，stream=%s，不冒充完整回答`, async stream => {
    const payload = stream ? format.stream : JSON.stringify(format.json)
    const f = await fixture(format, () => new Response(payload, { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } }))
    const response = await f.call()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(payload)
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ ok: true })
    expect(f.gateway.clientAcceptances()).toEqual({})
    expect(f.gateway.codexDesktopRouteAcceptance().status).toBe('unverified')
    expect((await f.gateway.probe(f.route)).ok).toBe(false)
  })

  it('没有完成标记、空拒答和混合认证错误仍失败', async () => {
    const candidates = [
      { ...formats[0].json, status: 'in_progress' },
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '' }] }] },
      { ...formats[0].json, error: { message: 'invalid_api_key private-detail' } }
    ]
    for (const candidate of candidates) {
      const f = await fixture(formats[0], () => Response.json(candidate))
      const response = await f.call()
      expect(response.status).not.toBe(200)
      expect(await response.text()).not.toContain('private-detail')
      expect(f.gateway.clientAcceptances()).toEqual({})
    }
  })
})
