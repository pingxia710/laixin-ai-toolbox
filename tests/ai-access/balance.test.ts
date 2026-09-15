import { describe, expect, it } from 'vitest'
import { readProviderBalance } from '../../app/main/ai-access/balance'

const fetchWith = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('服务商余额', () => {
  it('DeepSeek 读 CNY 总余额；Kimi 开放平台读可用余额；无接口的服务商标 unsupported', async () => {
    const deepseek = await readProviderBalance('deepseek', 'sk-test', fetchWith(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.345', granted_balance: '0', topped_up_balance: '12.345' }] }))
    expect(deepseek).toMatchObject({ supported: true, total: 12.35, currency: 'CNY' })
    const moonshot = await readProviderBalance('moonshot', 'sk-test', fetchWith(200, { code: 0, data: { available_balance: 49.9, voucher_balance: 0, cash_balance: 49.9 } }))
    expect(moonshot).toMatchObject({ supported: true, total: 49.9, currency: 'CNY' })
    expect(await readProviderBalance('zhipu', 'sk-test', fetchWith(200, {}))).toMatchObject({ supported: false, error: 'unsupported' })
  })
  it('没 Key、Key 被拒、网络失败、格式不对分别给出原因，不伪造为 0', async () => {
    expect(await readProviderBalance('deepseek', undefined, fetchWith(200, {}))).toMatchObject({ total: null, error: 'key_missing' })
    expect(await readProviderBalance('deepseek', 'sk-test', fetchWith(401, {}))).toMatchObject({ total: null, error: 'key_rejected' })
    expect(await readProviderBalance('deepseek', 'sk-test', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toMatchObject({ total: null, error: 'network_error' })
    expect(await readProviderBalance('deepseek', 'sk-test', fetchWith(200, { balance_infos: 'nope' }))).toMatchObject({ total: null, error: 'invalid_reply' })
  })
  // 同上：body 解析失败是格式问题，⛔ 混进网络错误里。
  it('HTTP 200 但响应体不是 JSON 时报格式不对，⛔ 报成网络连不上', async () => {
    const html = (async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    expect(await readProviderBalance('deepseek', 'sk-test', html)).toMatchObject({ total: null, error: 'invalid_reply' })
    expect(await readProviderBalance('moonshot', 'sk-test', html)).toMatchObject({ total: null, error: 'invalid_reply' })
  })
})
