import { describe, expect, it } from 'vitest'
import {
  ATTEMPT_STAGE_ENTRIES_MAX, attemptBucketOf, buildConnectionAttemptEvent, connectionAttemptKeyOf,
  parseConnectionAttemptEvent
} from '../../app/connection-attempt-types'

const base = {
  eventId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
  kind: 'connection-attempt',
  attemptKey: 'connect:1700000000000',
  trigger: 'connect',
  outcome: 'failed',
  firstFailedStage: 'connector-start',
  phase: 'tcp',
  totalMsBucket: '5s-30s',
  stageMsBuckets: ['connector-start=under-5s'],
  clientVersion: '0.7.0',
  platform: 'macos',
  authorizationHash: 'none'
} as const

describe('connection-attempt 合同(严格验形)', () => {
  it('合法事件过验形;任何字段不合形整体拒绝', () => {
    expect(parseConnectionAttemptEvent(base)).toBeDefined()
    expect(parseConnectionAttemptEvent({ ...base, extra: 1 })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, firstFailedStage: 'NOT_A_STAGE' })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, phase: 'not-a-phase' })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, totalMsBucket: '9s' })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, stageMsBuckets: ['bad-stage=under-5s'] })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, stageMsBuckets: ['connector-start=nonsense'] })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, stageMsBuckets: Array<string>(ATTEMPT_STAGE_ENTRIES_MAX + 1).fill('bridge-start=under-5s') })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, attemptKey: 'connect:1700000000000:failed' })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, eventId: 'not-uuid' })).toBeUndefined()
    expect(parseConnectionAttemptEvent({ ...base, authorizationHash: 'SECRET' })).toBeUndefined()
  })

  it('attemptBucketOf 分桶与 diagnosticDurationBucket 同口径', () => {
    expect(attemptBucketOf(undefined)).toBe('unknown')
    expect(attemptBucketOf(4_999)).toBe('under-5s')
    expect(attemptBucketOf(5_000)).toBe('5s-30s')
    expect(attemptBucketOf(29_999)).toBe('5s-30s')
    expect(attemptBucketOf(30_000)).toBe('30s-2m')
    expect(attemptBucketOf(120_000)).toBe('2m-10m')
    expect(attemptBucketOf(600_000)).toBe('over-10m')
    expect(attemptBucketOf(-1)).toBe('unknown')
  })

  it('漏斗行→事件:稳定 attemptKey、失败阶段与相位、耗时只出桶;superseded/stopped/in-progress 不上送', () => {
    const event = buildConnectionAttemptEvent({
      attempt: {
        trigger: 'connect', startedAt: 1_700_000_000_000, outcome: 'failed', endedAt: 1_700_000_021_000,
        stages: [
          { name: 'connector-start', outcome: 'ok', durationMs: 3_000 },
          { name: 'bridge-start', outcome: 'error', durationMs: 18_000, phase: 'tcp' }
        ]
      },
      eventId: base.eventId, clientVersion: '0.7.0', platform: 'windows', authorizationHash: 'none'
    })
    expect(event).toMatchObject({ attemptKey: 'connect:1700000000000', firstFailedStage: 'bridge-start', phase: 'tcp', totalMsBucket: '5s-30s' })
    expect(event!.stageMsBuckets).toEqual(['connector-start=under-5s', 'bridge-start=5s-30s'])
    // 终态不可变由漏斗写者保证;键不含 outcome——同一次尝试重放(即便终态不同)同键幂等。
    expect(connectionAttemptKeyOf({ trigger: 'connect', startedAt: 1, outcome: 'failed', endedAt: null, stages: [] })).toBe('connect:1')
    expect(connectionAttemptKeyOf({ trigger: 'connect', startedAt: 1, outcome: 'superseded', endedAt: null, stages: [] })).toBeUndefined()
    expect(connectionAttemptKeyOf({ trigger: 'wake', startedAt: 1, outcome: 'failed', endedAt: null, stages: [] })).toBeUndefined()
  })
})
