import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { readProviderBalance } from '../../app/main/ai-access/balance'
import { readPlanQuota } from '../../app/main/ai-access/plan-usage'

it.each([
  ['balance', 401, 'key_rejected'], ['balance', 429, 'provider_busy'],
  ['balance', 503, 'provider_busy'], ['balance', 404, 'invalid_reply'],
  ['kimi', 401, 'key-rejected'], ['kimi', 503, 'invalid-reply'], ['zhipu', 503, 'invalid-reply']
] as const)('%s HTTP %s 提前返回时释放未结束的响应，重复查询不积累连接', async (source, status, expected) => {
  let closed = 0
  const server = createServer((_request, response) => {
    response.on('close', () => { closed += 1 })
    response.writeHead(status)
    response.write('unfinished error body')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/`
  const localFetch: typeof fetch = (_input, init) => fetch(url, init)
  try {
    for (let index = 1; index <= 3; index += 1) {
      const result = source === 'balance'
        ? (await readProviderBalance('deepseek', 'local-fixture-key', localFetch)).error
        : (await readPlanQuota(source, 'local-fixture-key', localFetch)).status
      expect(result).toBe(expected)
      await vi.waitFor(() => expect(closed).toBe(index), { timeout: 500, interval: 10 })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each([false, true])('智谱认证重试前取消上一响应，取消报错也不覆盖查询结果（取消报错=%s）', async (cancelFails) => {
  let attempts = 0, cancelled = 0
  const localFetch: typeof fetch = async (_input, init) => {
    attempts += 1
    if (attempts === 1) return new Response(new ReadableStream({ cancel() {
      cancelled += 1
      if (cancelFails) throw new Error('already disconnected')
    } }), { status: 401 })
    expect(cancelled).toBe(1)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer local-fixture-key')
    return Response.json({ code: 200, data: { limits: [{ type: 'CREDIT_LIMIT', usage: 100, currentValue: 1, percentage: 1 }] } })
  }
  expect((await readPlanQuota('zhipu', 'local-fixture-key', localFetch)).status).toBe('plan')
  expect(attempts).toBe(2)
})
