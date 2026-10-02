import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'

const gateways: AiGateway[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })
const token = 'fixture-recovery-time-token'
const answer = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Recovered' }] }] }

describe('API-RETRY01 upstream recovery time', () => {
  it.each([false, true])('Retry-After=1 秒时第 2 秒重新访问上游，原生多模型路径 %s', async multi => {
    let now = Date.UTC(2026, 9, 2)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let healthy = false
    const upstream = vi.fn(async () => healthy ? Response.json(answer) : new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '1' } }))
    const gateway = new AiGateway({ fetch: upstream })
    gateways.push(gateway)
    const route = { shell: 'codex' as const, provider: 'deepseek' as const, model: 'deepseek-flash', key: 'sk-fixture-retry-0123456789', endpoint: 'https://fixture.invalid' }
    if (multi) gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [{ ...route, internalModelId: 'laixin.deepseek.deepseek-flash' }] })
    else gateway.setRoutes([route])
    await gateway.start(0, token)
    const call = () => fetch(`${gateway.baseUrl}/codex/${multi ? 'multi' : 'deepseek'}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: multi ? 'laixin.deepseek.deepseek-flash' : route.model, input: 'fixture' }) })
    expect((await call()).status).toBe(429)
    healthy = true
    now += 500
    expect((await call()).status).toBe(429)
    expect(upstream).toHaveBeenCalledTimes(1)
    now += 1500
    expect((await call()).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it.each(['date', 'zero', 'body-ms', 'body-absolute', 'invalid'] as const)('恢复时间来源 %s；无效信息保留既有有界短窗', async kind => {
    let now = Date.UTC(2026, 9, 2)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const header = kind === 'date' ? new Date(now + 1000).toUTCString() : kind === 'zero' ? '0' : kind === 'invalid' ? '-1' : undefined
    const body = kind === 'body-ms' ? { error: { retry_after_ms: 1000 } }
      : kind === 'body-absolute' ? { error: { reset_at: new Date(now + 1000).toISOString() } } : { error: { message: 'slow down' } }
    let healthy = false
    const upstream = vi.fn(async () => healthy ? Response.json(answer) : Response.json(body, { status: 429, headers: header === undefined ? undefined : { 'retry-after': header } }))
    const gateway = new AiGateway({ fetch: upstream })
    gateways.push(gateway)
    gateway.setRoutes([{ shell: 'codex', provider: 'deepseek', model: 'deepseek-flash', key: 'sk-fixture-retry-0123456789', endpoint: 'https://fixture.invalid' }])
    await gateway.start(0, token)
    const call = () => fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":"fixture"}' })
    expect((await call()).status).toBe(429)
    healthy = true
    now += 2000
    expect((await call()).status).toBe(kind === 'invalid' ? 429 : 200)
    if (kind === 'invalid') {
      expect(upstream).toHaveBeenCalledTimes(1)
      now += 28000
      expect((await call()).status).toBe(200)
    }
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('HTTP 200 中的 SSE 业务限流同样使用现有白名单恢复字段', async () => {
    let now = Date.UTC(2026, 9, 2)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let healthy = false
    const upstream = vi.fn(async () => healthy ? Response.json(answer) : new Response('event: error\ndata: {"error":{"code":"rate_limit_exceeded","retry_after":1}}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const gateway = new AiGateway({ fetch: upstream })
    gateways.push(gateway)
    gateway.setRoutes([{ shell: 'codex', provider: 'deepseek', model: 'deepseek-flash', key: 'sk-fixture-retry-0123456789', endpoint: 'https://fixture.invalid' }])
    await gateway.start(0, token)
    const call = () => fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":"fixture"}' })
    expect((await call()).status).toBe(429)
    healthy = true
    now += 2000
    expect((await call()).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })
})
