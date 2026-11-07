import { describe, expect, it } from 'vitest'
import { buildReachabilityEvent, parseReachabilityEvent } from '../../app/reachability-types'
import type { FunnelAttemptLike } from '../../app/connection-attempt-types'

const connected = (overrides: Partial<FunnelAttemptLike> = {}): FunnelAttemptLike => ({
  trigger: 'connect', startedAt: 1_000, endedAt: 1_180, outcome: 'connected', nodeId: 'vultr-lax-01', legRole: 'primary',
  stages: [{ name: 'path-verify-after-settings', outcome: 'ok', durationMs: 180 }], ...overrides
})

describe('客户端可达性事件合同', () => {
  it('把带节点标识的漏斗终态压成成功事件，不带地址或客户字段', () => {
    const event = buildReachabilityEvent({ attempt: connected(), clientVersion: '0.7.3', platform: 'macos', at: 2_000 })
    expect(event).toMatchObject({
      clientVersion: '0.7.3', platform: 'macos', nodeId: 'vultr-lax-01', at: 2_000,
      result: 'ok', failureCategory: null, rttMs: 180, legRole: 'primary'
    })
    expect(Object.keys(event!).sort()).toEqual(['at', 'clientVersion', 'eventId', 'failureCategory', 'legRole', 'nodeId', 'platform', 'result', 'rttMs'])
    expect(JSON.stringify(event)).not.toMatch(/127\.0\.0\.1|customer|token|host|domain/i)
  })

  it('失败阶段映射为受控分类，旧包没有 nodeId 时不生成事件', () => {
    const event = buildReachabilityEvent({
      attempt: connected({ outcome: 'fatal', nodeId: 'nyc-01', legRole: 'secondary', stages: [{ name: 'connector-start', outcome: 'error', phase: 'tcp' }] }),
      clientVersion: '0.7.3', platform: 'windows'
    })
    expect(event).toMatchObject({ result: 'failed', failureCategory: 'TCP', rttMs: null, legRole: 'secondary' })
    expect(buildReachabilityEvent({ attempt: connected({ nodeId: undefined }), clientVersion: '0.7.3', platform: 'macos' })).toBeUndefined()
  })

  it('严格拒绝多余字段、失败无分类和非法节点标识', () => {
    const event = buildReachabilityEvent({ attempt: connected(), clientVersion: '0.7.3', platform: 'macos' })!
    expect(parseReachabilityEvent({ ...event, extra: 'raw-address' })).toBeUndefined()
    expect(parseReachabilityEvent({ ...event, result: 'failed', failureCategory: null })).toBeUndefined()
    expect(parseReachabilityEvent({ ...event, nodeId: 'VULTR/01' })).toBeUndefined()
  })
})
