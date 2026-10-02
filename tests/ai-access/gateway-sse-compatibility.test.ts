import { afterEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })
const token = 'fixture-sse-compatibility-token'
const answer = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
const route = { shell: 'codex' as const, provider: 'deepseek' as const, model: 'fixture-model', endpoint: 'https://api.deepseek.com/fixture', key: 'sk-fixture-0123456789012345' }

async function fixture(payload: string, chunked = false) {
  const gateway = new AiGateway({ timeoutMs: 1000, fetch: async () => {
    const bytes = new TextEncoder().encode(payload)
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      if (chunked) for (let at = 0; at < bytes.length; at++) controller.enqueue(bytes.slice(at, at + 1))
      else controller.enqueue(bytes)
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  gateways.push(gateway)
  await gateway.start(0, token)
  gateway.setRoutes([route])
  const response = await fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}'
  })
  return { gateway, status: response.status, text: await response.text() }
}

describe('客户 SSE 回复格式兼容', () => {
  it.each(['\n', '\r\n', '\r'])('完整多行事件及注释原样转发，换行 %j', async newline => {
    const payload = ['\uFEFF: comment', '', 'event: response.completed', ': keepalive',
      'data: {"type":"response.completed",', `data: "response":${JSON.stringify(answer)}}`, '', ''].join(newline)
    const result = await fixture(payload)
    expect(result.status).toBe(200)
    // UTF-8 decoding consumes the optional leading BOM.
    expect(result.text).toBe(payload.replace(/^\uFEFF/, ''))
    expect(result.gateway.snapshot().requests[0]).toMatchObject({ ok: true })
  })

  it.each(['\n', '\r\n', '\r'])('逐字节跨块的多行事件不损坏，换行 %j', async newline => {
    const payload = ['event: response.completed', 'data: {"type":"response.completed",',
      `data: "response":${JSON.stringify(answer)}}`, '', ''].join(newline)
    expect((await fixture(payload, true)).text).toBe(payload)
  })

  it('多行真实错误仍消毒，坏 JSON 不能被当成有效答案', async () => {
    const upstreamError = 'event: error\ndata: {"type":"error",\ndata: "error":{"message":"invalid_api_key private-detail"}}\n\n'
    const rejected = await fixture(upstreamError, true)
    expect(rejected.status).toBe(400)
    expect(rejected.text).toContain('key_rejected')
    expect(rejected.text).not.toContain('private-detail')
    const malformed = await fixture('data: {broken\ndata: JSON}\n\n')
    expect(malformed.status).toBe(502)
    expect(malformed.gateway.clientAcceptances()).toEqual({})
  })
})
