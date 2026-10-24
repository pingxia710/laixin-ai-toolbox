import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AiGateway } from '../../app/main/ai-access/gateway'
import type { ApiRequestRecord } from '../../app/shared/api-service-types'

const gateways: AiGateway[] = []
const fingerprint = (value: string) => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

describe('多模型大请求保持纯路由', () => {
  it('整体超过旧 32MB 阈值仍先选定模型再完整转发，不制造本机故障', async () => {
    let upstreamInput: ReturnType<typeof fingerprint> | undefined
    const upstream = vi.fn(async (_url, init) => {
      upstreamInput = fingerprint((JSON.parse(String(init?.body)) as { input: string }).input)
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] })
    })
    const failure = vi.fn<(record: ApiRequestRecord) => void>()
    const gateway = new AiGateway({ fetch: upstream })
    gateway.onClientFailure(failure)
    gateways.push(gateway)
    await gateway.start(0, 'fixture-client-token-0123456789')
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [
      { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', endpoint: 'https://api.deepseek.com', key: 'sk-fixture-deepseek-0123456789' },
      { provider: 'zhipu-api', model: 'glm-5.3-flash', internalModelId: 'laixin.zhipu-api.glm-5.3-flash', endpoint: 'https://open.bigmodel.cn', key: 'sk-fixture-zhipu-0123456789' }
    ] })
    const input = 'private-body-'.repeat(3_000_000)
    const response = await fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer fixture-client-token-0123456789' },
      body: JSON.stringify({ model: 'laixin.deepseek.deepseek-flash', input }) })
    expect(response.status).toBe(200)
    await response.text()
    expect(upstream).toHaveBeenCalledOnce()
    expect(upstreamInput).toEqual(fingerprint(input))
    expect(gateway.snapshot().requests).toHaveLength(1)
    expect(gateway.snapshot().requests[0]).toMatchObject({ shell: 'codex', source: 'client', ok: true,
      provider: 'deepseek', model: 'deepseek-flash' })
    expect(failure).not.toHaveBeenCalled()
    expect(JSON.stringify(gateway.snapshot())).not.toMatch(/private-body|sk-fixture/)
  })
})
