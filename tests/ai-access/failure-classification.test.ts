import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway, type GatewayRoute } from '../../app/main/ai-access/gateway'
import { apiFailureMessage, apiFailureRemedy, classifyProviderFailure, providerRecoveryNotice, type ApiFailure } from '../../app/shared/api-service-types'

const token = 'laixin-fixture-client-token-0123456789'
const key = 'sk-fixture-upstream-key-0123456789'
const route: GatewayRoute = { shell: 'codex', provider: 'deepseek', model: 'fixture-model', endpoint: 'https://api.deepseek.com/fixture', key }
const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })
async function start(fetcher: typeof fetch, timeoutMs = 500) {
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs })
  gateways.push(gateway)
  await gateway.start(0, token)
  gateway.setRoutes([route])
  return gateway
}

describe('错误原因判准', () => {
  it('400 是格式错、422 是参数错，都不再和 404「模型不可用」混为一谈', () => {
    expect(classifyProviderFailure(400, '{"error":{"type":"invalid_request_error","message":"Failed to deserialize the JSON body"}}')).toBe('request_invalid')
    expect(classifyProviderFailure(422, '{"error":{"message":"Invalid parameter: temperature"}}')).toBe('request_invalid')
    expect(classifyProviderFailure(400)).toBe('request_invalid')
    expect(classifyProviderFailure(404)).toBe('model_unavailable')
    expect(apiFailureMessage('request_invalid')).toContain('版本')
  })

  it.each([
    [401, '', 'key_rejected'],
    [402, '{"error":{"message":"Insufficient Balance"}}', 'balance_or_access'],
    [403, '{"error":{"type":"permission_error"}}', 'balance_or_access'],
    [403, '{"error":{"type":"authentication_error"}}', 'key_rejected'],
    [400, '{"error":{"message":"Model Not Exist"}}', 'model_unavailable'],
    [400, '{"error":{"message":"The model `deepseek-v9` does not exist"}}', 'model_unavailable'],
    [400, '{"error":{"message":"This api key does not exist"}}', 'key_rejected'],
    [400, '{"error":{"code":"context_length_exceeded"}}', 'content_too_long'],
    [413, '{"error":{"type":"request_too_large"}}', 'content_too_long'],
    [429, '{"error":{"type":"rate_limit_error"}}', 'rate_limited'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'balance_or_access'],
    [500, '{"error":{"type":"api_error"}}', 'provider_outage'],
    [503, 'Server is busy', 'provider_outage'],
    [529, '{"error":{"type":"overloaded_error"}}', 'provider_outage'],
    [418, 'nothing recognisable here', 'unknown']
  ] as const)('HTTP %s 按状态码与错误体判成 %#', (status, body, expected) => {
    expect(classifyProviderFailure(status, body)).toBe(expected)
  })

  it('429、529 与套餐额度失败只从受控重置字段或明确窗口生成中文恢复提示', () => {
    const now = Date.parse('2026-09-13T00:00:00.000Z')
    expect(providerRecoveryNotice(429, '{"error":{"reset_at":"2026-09-13T01:30:00Z","message":"private upstream detail"}}', 'rate_limited', 'deepseek', undefined, now))
      .toBe('服务商预计于 2026-09-13 09:30（中国标准时间）恢复')
    expect(providerRecoveryNotice(429, '{}', 'rate_limited', 'moonshot', '120', now))
      .toBe('服务商预计于 2026-09-13 08:02（中国标准时间）恢复')
    expect(providerRecoveryNotice(429, '{"error":{"message":"You have reached your 5-hour usage limit"}}', 'membership_rate_limited', 'kimi', undefined, now))
      .toBe('Kimi Code 当前 5 小时额度窗口已用完，窗口重置后可继续使用')
    expect(providerRecoveryNotice(429, '{"error":{"message":"每周使用上限"}}', 'coding_plan_quota_exhausted', 'zhipu', undefined, now))
      .toBe('GLM Coding Plan 当前周额度窗口已用完，请等待套餐周额度重置')

    const fallback = providerRecoveryNotice(529, '{"error":{"message":"private upstream detail","reset":"2099-01-01"}}', 'provider_outage', 'moonshot', undefined, now)
    expect(fallback).toBe('服务商未给出可核验的恢复时间，请稍后重试')
    expect(fallback).not.toContain('private')
    expect(providerRecoveryNotice(400, '{"reset_at":"2026-09-13T01:30:00Z"}', 'request_invalid', 'deepseek', undefined, now)).toBeUndefined()
  })

  it('每个失败类都有一句客户看得懂的话和一个建议动作，判不出就说判不出', () => {
    for (const [code, action] of Object.entries(apiFailureRemedy) as [ApiFailure, string | null][]) {
      expect(apiFailureMessage(code).length).toBeGreaterThan(8)
      expect(action === null || ['retest', 'reapply', 'restartGateway', 'useOfficial', 'openConsole'].includes(action)).toBe(true)
    }
    expect(apiFailureRemedy.request_invalid).toBe('reapply')
    expect(apiFailureRemedy.local_service_down).toBe('restartGateway')
    expect(apiFailureRemedy.local_service_busy).toBe('retest')
    expect(apiFailureRemedy.key_rejected).toBe('openConsole')
    expect(apiFailureMessage('unknown')).toContain('没能判断')
  })

  it('Kimi Code 按会员产品的实际原因区分 401、402、403 与 429，不把套餐问题说成 Key 错', () => {
    expect(classifyProviderFailure(401, '{"error":{"message":"Your current subscription does not have access to k3"}}', 'kimi')).toBe('membership_model_unavailable')
    expect(classifyProviderFailure(401, '{"error":{"message":"Invalid Authentication"}}', 'kimi')).toBe('key_rejected')
    expect(classifyProviderFailure(401, '{"error":{"message":"Your model id does not exist, recognized as other:k3[wrong]"}}', 'kimi')).toBe('request_invalid')
    expect(classifyProviderFailure(402, '{"error":{"message":"We are unable to verify your membership benefits at this time"}}', 'kimi')).toBe('membership_benefits_unavailable')
    expect(classifyProviderFailure(403, '{"error":{"message":"You have reached your 5-hour usage limit"}}', 'kimi')).toBe('membership_quota_exhausted')
    expect(classifyProviderFailure(403, '{"error":{"message":"You have reached your concurrent request limit"}}', 'kimi')).toBe('membership_concurrency_limited')
    expect(classifyProviderFailure(429, '{"error":{"message":"The engine is currently overloaded"}}', 'kimi')).toBe('membership_rate_limited')
    expect(classifyProviderFailure(200, '{"error":{"message":"You have reached your 5-hour usage limit"}}', 'kimi')).toBe('membership_quota_exhausted')
    expect(apiFailureMessage('membership_model_unavailable')).toContain('套餐')
    expect(apiFailureRemedy.membership_benefits_unavailable).toBe('retest')
  })

  it('Kimi Code 与开放平台首轮认证失败先按 Key 未通过处理，不能只靠同名错误码猜产品来源', () => {
    // 两个上游都可能只给 invalid_token / product_mismatch。没有姐妹入口成功证据时，不能误导客户换产品。
    expect(classifyProviderFailure(401, '{"error":{"code":"invalid_token"}}', 'kimi')).toBe('key_rejected')
    expect(classifyProviderFailure(401, '{"error":{"type":"product_mismatch"}}', 'moonshot')).toBe('key_rejected')
    expect(classifyProviderFailure(401, '{"code":"product_mismatch"}', 'kimi')).toBe('key_rejected')
    expect(classifyProviderFailure(401, '{"error":{"message":"Invalid Authentication"}}', 'kimi')).toBe('key_rejected')
    // 智谱的普通 API 与套餐端点没有足以证明来源的同类码，不能凭 401 猜产品。
    expect(classifyProviderFailure(401, '{"error":{"code":"invalid_token"}}', 'zhipu-api')).toBe('key_rejected')
    expect(apiFailureMessage('key_product_mismatch', 'kimi')).toContain('不能混用')
    expect(apiFailureMessage('key_product_mismatch', 'moonshot')).toContain('不能混用')
  })

  it('GLM Coding Plan 读取业务码 1309/1310/1311/1315；普通智谱 API 不套用套餐结论', () => {
    expect(classifyProviderFailure(429, '{"error":{"code":1309,"message":"套餐已到期"}}', 'zhipu')).toBe('coding_plan_expired')
    expect(classifyProviderFailure(429, '{"error":{"code":"1310","message":"每周使用上限"}}', 'zhipu')).toBe('coding_plan_quota_exhausted')
    expect(classifyProviderFailure(429, '{"code":1311,"msg":"未开放模型权限"}', 'zhipu')).toBe('coding_plan_model_unavailable')
    expect(classifyProviderFailure(429, '{"error":{"code":1315,"message":"仅限企业编程套餐场景"}}', 'zhipu')).toBe('coding_plan_key_product_mismatch')
    expect(classifyProviderFailure(429, '{"error":{"code":1309,"message":"套餐已到期"}}', 'zhipu-api')).toBe('rate_limited')
    expect(apiFailureMessage('coding_plan_key_product_mismatch')).toContain('企业编程套餐')
  })

  it('真实往返按错误体判类，上游原文不进记录、也不转给客户端', async () => {
    const gateway = await start(async () => new Response('{"error":{"type":"invalid_request_error","message":"unsupported field private-detail"}}', { status: 400 }))
    const response = await fetch(`${gateway.baseUrl}/codex/deepseek/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('private-detail')
    expect(gateway.snapshot().requests[0]).toMatchObject({ ok: false, code: 'request_invalid' })
    expect(JSON.stringify(gateway.snapshot())).not.toContain('private-detail')
  })

  it('HTTP 200 里装着的认证失败照样判 Key 未通过，⛔ 报成「回复格式不对」', async () => {
    // 智谱这类兼容层用 200 装认证失败：上线检查实测 `{"code":1000,"msg":"身份验证失败。"}`。
    const gateway = await start(async () => Response.json({ code: 1000, msg: '身份验证失败。', success: false }))
    expect(await gateway.probe(route)).toMatchObject({ ok: false, code: 'key_rejected' })
    // 英文提示的同类形状也要认出来。
    const english = await start(async () => Response.json({ error: { message: 'Invalid API key provided' } }))
    expect(await english.probe(route)).toMatchObject({ ok: false, code: 'key_rejected' })
    // 只是回复不完整、跟认证无关的，仍旧按「回复格式不对」走，⛔ 一律赖到 Key 头上。
    const broken = await start(async () => Response.json({ status: 'in_progress' }))
    expect(await broken.probe(route)).toMatchObject({ ok: false, code: 'invalid_reply' })
  })

  it('单次超时仍报超时，连续三次超时才改判成厂商侧故障', async () => {
    const hang = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const gateway = await start(hang, 30)
    const codes: (ApiFailure | undefined)[] = []
    for (let attempt = 0; attempt < 3; attempt++) codes.push((await gateway.measureLatency(route) as { code?: ApiFailure }).code)
    expect(codes).toEqual(['timeout', 'timeout', 'provider_outage'])
  })
})
