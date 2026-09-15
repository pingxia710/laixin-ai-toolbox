import { describe, expect, it } from 'vitest'
import { balanceMetricValue, providerServiceAvailable, readServiceSnapshot, summarizeRequests } from '../../app/renderer/src/platform/api-service'
import { readAccessStatus } from '../../app/renderer/src/platform/access-status'
import { apiFailureMessage, type ApiRequestRecord } from '../../app/shared/api-service-types'
import { modelProviderIds, type ModelProviderId } from '../../app/shared/model-providers'
const row: ApiRequestRecord = { at: '2026-09-11T01:00:00Z', shell: 'codex', provider: 'deepseek', model: 'deepseek-v4-flash', source: 'client', ok: true, status: 200, durationMs: 100, inputTokens: 10, outputTokens: 2 }
const emptyKeys = (): Record<ModelProviderId, boolean> => Object.fromEntries(modelProviderIds.map((provider) => [provider, false])) as Record<ModelProviderId, boolean>
describe('API 面板证据与状态', () => {
  it('旧共享 Key 标记不能冒充每个壳已添加 Key', () => {
    expect(() => readAccessStatus(JSON.stringify({ deepseekKeySaved: true, shells: {
      codex: { selected: null, officialAvailable: true }, claude: { selected: null, officialAvailable: true }, hermes: { selected: null, officialAvailable: false }
    } }))).toThrow()
  })
  it('自测不计入客户调用，未知 Token 不算 0', () => {
    expect(summarizeRequests([{ ...row, source: 'test' }])).toMatchObject({ count: 0, tokensKnown: false })
    expect(summarizeRequests([row])).toMatchObject({ count: 1, succeeded: 1, input: 10, output: 2, tokensKnown: true })
    expect(summarizeRequests([row, { ...row, ok: false, inputTokens: null }])).toMatchObject({ count: 2, succeeded: 1, tokensKnown: false })
  })
  it('自动取消独立呈现，不冒充服务商失败或破坏已完成调用的 Token 统计', () => {
    const cancelled: ApiRequestRecord = { ...row, ok: false, code: 'client_aborted', inputTokens: null, outputTokens: null }
    expect(summarizeRequests([row, cancelled])).toMatchObject({ count: 2, succeeded: 1, failed: 0, cancelled: 1, input: 10, output: 2, tokensKnown: true })
  })
  it('接口读取失败或结构异常不是空记录', () => {
    expect(() => readServiceSnapshot('{}')).toThrow()
    expect(() => readServiceSnapshot(JSON.stringify({ running: true, routes: [], checks: [], requests: [{ ...row, outputTokens: 'unknown' }] }))).toThrow()
  })
  it('DeepSeek 的限流提示给出账号级的正确处理，其他服务商不混用', () => {
    expect(apiFailureMessage('rate_limited', 'deepseek')).toContain('增加同账号的 Key 不会提高并发')
    expect(apiFailureMessage('rate_limited', 'zhipu')).toBe('服务商限流或额度暂不可用，请稍后重试。')
  })
  it('服务面板余额与账号总览同一口径：读到数字显示数字，其余指向官方控制台', () => {
    expect(balanceMetricValue({ supported: true, total: 88.5, currency: 'CNY' })).toBe('88.50 CNY')
    expect(balanceMetricValue({ supported: true, total: 12, currency: '' })).toBe('12.00')
    expect(balanceMetricValue({ supported: true, total: null, currency: 'CNY' })).toBe('请到官方控制台查看')
    expect(balanceMetricValue({ supported: false, total: 9, currency: 'CNY' })).toBe('请到官方控制台查看')
    expect(balanceMetricValue(null)).toBe('请到官方控制台查看')
  })
  it('Codex 的两种智谱入口完成原生 Responses 验收后，服务测试入口可用', () => {
    expect(providerServiceAvailable('codex', 'zhipu')).toBe(true)
    expect(providerServiceAvailable('codex', 'zhipu-api')).toBe(true)
    expect(providerServiceAvailable('codex', 'deepseek')).toBe(true)
  })
  it('返回给 UI 的接入结果保留失败原因，丢弃意外私密字段', () => {
    const result = readAccessStatus(JSON.stringify({ shells: {
      codex: { selected: 'official', officialAvailable: true, providerKeys: emptyKeys() }, claude: { selected: null, officialAvailable: true, providerKeys: emptyKeys() }, hermes: { selected: null, officialAvailable: false, providerKeys: emptyKeys() }
    }, attempt: { at: row.at, shell: 'codex', provider: 'deepseek', ok: false, code: 'key_rejected', secret: 'never-return' }, key: 'never-return' }))
    expect(result.attempt).toMatchObject({ ok: false, code: 'key_rejected' })
    expect(JSON.stringify(result)).not.toContain('never-return')
  })
})
