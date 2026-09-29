import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

describe('headless 有界 drain', () => {
  it('在界内让已接受请求完整结束，不提前中止', async () => {
    let finish: ((response: Response) => void) | undefined
    const upstream = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn(async () => upstream)
    const gateway = new AiGateway({ fetch: fetcher })
    gateways.push(gateway)
    await gateway.start(0, 'fixture-client-token')
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [{
      internalModelId: 'laixin.deepseek.deepseek-flash', provider: 'deepseek', model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com/v1/responses', key: 'sk-fixture-drain-0123456789'
    }] })
    const request = fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'laixin.deepseek.deepseek-flash', input: 'fixture' })
    })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const draining = gateway.drain(1_000)
    finish?.(Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }))

    await expect(request.then(response => response.status)).resolves.toBe(200)
    await expect(draining).resolves.toBeUndefined()
    expect(gateway.snapshot().running).toBe(false)
  })

  it('超时后只中止本路由已记账的在途请求', async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const gateway = new AiGateway({ fetch: fetcher })
    gateways.push(gateway)
    await gateway.start(0, 'fixture-client-token')
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [{
      internalModelId: 'laixin.deepseek.deepseek-flash', provider: 'deepseek', model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com/v1/responses', key: 'sk-fixture-drain-0123456789'
    }] })
    const request = fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-client-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'laixin.deepseek.deepseek-flash', input: 'fixture' })
    }).catch(() => undefined)

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await gateway.drain(20)
    await request
    expect(gateway.snapshot().running).toBe(false)
  })
})
