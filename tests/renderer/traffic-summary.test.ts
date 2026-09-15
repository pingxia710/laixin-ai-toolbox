import { describe, expect, it } from 'vitest'
import { trafficSummary } from '../../app/renderer/src/ui/account-overview'
import type { NetworkUsageView } from '../../app/shared/network-usage-types'

const usage: NetworkUsageView = {
  authorizationId: 'fixture', kind: 'trial', planId: 'trial', state: 'active', measurement: 'current',
  totalBytes: 5 * 1024 ** 3, usedBytes: 1024 ** 3, remainingBytes: 4 * 1024 ** 3,
  expiresAt: 1_789_000_000_000, observedAt: 1_788_000_000_000, reasonCode: ''
}

describe('首页流量摘要保留实测与未知的区别', () => {
  it('显示真实剩余流量，已用完时可显示零', () => {
    expect(trafficSummary(usage).remaining).toBe('4.00 GB')
    expect(trafficSummary({ ...usage, state: 'exhausted', remainingBytes: 0 }).remaining).toBe('0.00 GB')
  })
  it('测量失败后不继续展示上次剩余数值，也不显示为零', () => {
    expect(trafficSummary({ ...usage, measurement: 'unavailable' }).remaining).toBe('暂时无法获取')
    expect(trafficSummary({ ...usage, remainingBytes: null }).remaining).toBe('暂时无法获取')
  })
  it('未开通的套餐不产生虚假的流量和有效期', () => {
    expect(trafficSummary({ ...usage, state: 'pending', measurement: 'not-requested', expiresAt: null })).toEqual({
      remaining: '暂时无法获取', detail: '待付款 · 开通后确定有效期'
    })
  })
})
