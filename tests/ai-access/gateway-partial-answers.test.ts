import { afterEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })
const token = 'fixture-partial-answer-token'
const text = 'Useful partial answer'
const formats = [
  { shell: 'codex', path: 'responses', json: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
    stream: `data: {"type":"response.output_text.delta","delta":"${text}"}\n\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n` },
  { shell: 'claude', path: 'messages', json: { type: 'message', content: [{ type: 'text', text }], stop_reason: 'max_tokens' },
    stream: `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${text}"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n` },
  { shell: 'hermes', path: 'chat/completions', json: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'length' }] },
    stream: `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n` }
] as const
async function fixture(format: typeof formats[number], upstream: () => Response) {
  const gateway = new AiGateway({ fetch: async () => upstream() })
  gateways.push(gateway)
  const route = { shell: format.shell, provider: 'deepseek' as const, model: 'deepseek-flash', key: 'sk-fixture-partial-0123456789', endpoint: 'https://fixture.invalid' }
  gateway.setRoutes([route])
  await gateway.start(0, token)
  const call = () => fetch(`${gateway.baseUrl}/${format.shell}/deepseek/v1/${format.path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: route.model, input: 'fixture', messages: [{ role: 'user', content: 'fixture' }] }) })
  return { gateway, route, call }
}

describe('API-RESP01 preserves upstream partial answers', () => {
  it.each(formats)('$shell 非流式保留原正文和截断原因，不替换为本地 400', async format => {
    const f = await fixture(format, () => Response.json(format.json))
    const response = await f.call()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(format.json)
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ source: 'client', ok: true })
    expect(f.gateway.clientAcceptances()).toEqual({})
  })

  it.each(formats)('$shell 流式保留部分文字和原结束帧，不追加工具箱错误', async format => {
    const f = await fixture(format, () => new Response(format.stream, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await f.call()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(format.stream)
    expect(f.gateway.snapshot().requests[0]).toMatchObject({ source: 'client', ok: true })
    expect(f.gateway.clientAcceptances()).toEqual({})
  })

  it('部分答案可转发但不冒充完整探测成功；没有正文仍按失败处理', async () => {
    const f = await fixture(formats[0], () => Response.json(formats[0].json))
    expect(await f.gateway.probe(f.route)).toMatchObject({ ok: false, code: 'response_truncated' })
    const empty = await fixture(formats[0], () => Response.json({ status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }))
    const response = await empty.call()
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('response_truncated')
  })

  it('文字后出现真正的业务错误或坏 JSON 仍失败，不因截断放宽', async () => {
    for (const bad of ['data: {broken-json}\n\n', 'data: {"type":"error","error":{"message":"invalid_api_key"}}\n\n']) {
      const f = await fixture(formats[0], () => new Response(`data: {"type":"response.output_text.delta","delta":"${text}"}\n\n${bad}${formats[0].stream}`, { headers: { 'content-type': 'text/event-stream' } }))
      const response = await f.call()
      await response.text()
      expect(f.gateway.snapshot().requests[0].ok).toBe(false)
      expect(f.gateway.clientAcceptances()).toEqual({})
    }
    const mixed = await fixture(formats[0], () => Response.json({ ...formats[0].json, error: { message: 'invalid_api_key private upstream detail' } }))
    const response = await mixed.call()
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('private upstream detail')
    expect(mixed.gateway.snapshot().requests[0]).toMatchObject({ ok: false, code: 'key_rejected' })
  })
})
