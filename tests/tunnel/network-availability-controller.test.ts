import { describe, expect, it } from 'vitest'
import {
  NetworkAvailabilityController,
  type AvailabilityAction,
  type AvailabilityIntent,
  type AvailabilityOperation
} from '../../sidecar/shared/network-availability-controller.mjs'

const conflict = { id: 'third-party:http:127.0.0.1:7890', kind: 'http-proxy' }
const replacement = { id: 'third-party:http:127.0.0.1:7891', kind: 'http-proxy' }
const path = { id: 'path:default-route:1', target: 'configured-ai-target', reachable: true }
const changedPath = { id: 'path:default-route:2', target: 'configured-ai-target', reachable: true }
const snapshot = { id: 'snapshot:before', value: { proxy: '127.0.0.1:7890' } }
const lease = { id: 'lease:laixin:1', owner: 'laixin', expiresAt: 10_000 }

function availabilityHarness() {
  let now = 1_000
  return {
    controller: new NetworkAvailabilityController({ now: () => now, maxReclaims: 3 }),
    advance: (ms: number) => { now += ms }
  }
}

function intent(controller: NetworkAvailabilityController, id = 'connect-a'): AvailabilityIntent {
  return controller.beginIntent({ id })
}

function start(controller: NetworkAvailabilityController, active: AvailabilityIntent, action: AvailabilityAction, extra = {}): AvailabilityOperation {
  const operation = controller.start({ intent: active, action, conflict, path, snapshot, lease, ...extra })
  if (operation.blocked === true) throw new Error(`unexpected controller block: ${operation.code}`)
  return operation
}

function tracked(controller: NetworkAvailabilityController) {
  return controller as unknown as { operations: Map<string, AvailabilityOperation>; activeOperation: string | undefined }
}

describe('N-55 网络可用性控制器', () => {
  it('可用第三方代理复用时零系统写入，且仅在目标实测成功后宣布已连接', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'reuse')
    expect(controller.state.status).toBe('reusing')
    expect(controller.complete(operation, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: true, status: 'connected' })
    expect(controller.state.lastAction).toMatchObject({ action: 'reuse', writes: 0 })
  })

  it('接管必须绑定快照、租约、写后读回和目标实测；任一不足不假报成功', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'takeover')
    controller.markWritten(operation)
    expect(controller.complete(operation, { readbackMatches: false, targetReachable: true, conflict, path })).toMatchObject({ ok: false, status: 'limited', code: 'READBACK_MISMATCH' })
    const retry = start(controller, active, 'takeover')
    controller.markWritten(retry)
    expect(controller.complete(retry, { readbackMatches: true, targetReachable: false, conflict, path })).toMatchObject({ ok: false, status: 'limited', code: 'TARGET_UNREACHABLE' })
  })

  it('每个可能写设置的动作都带意图代次、对象、路径、快照、租约和读回证据', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'takeover')
    expect(operation).toMatchObject({ intent: active, conflict, path, snapshot, lease, writes: 0 })
    controller.markWritten(operation)
    expect(operation.writes).toBe(1)
  })

  it('外部反复改回时有界夺回，达到上限时给出已证实限制而非机械第二次停止或无限写入', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    for (let i = 0; i < 3; i += 1) {
      const operation = start(controller, active, 'reclaim')
      controller.markWritten(operation)
      expect(controller.complete(operation, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: true, status: 'connected' })
    }
    expect(controller.start({ intent: active, action: 'reclaim', conflict, path, snapshot, lease })).toMatchObject({ blocked: true, code: 'RECLAIM_LIMIT', status: 'limited' })
    expect(controller.state.lastAction?.action).toBe('reclaim')
  })

  it('目标复验失败也消耗已执行夺回的轮次，不能借失败结果无限抢写', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    for (let i = 0; i < 3; i += 1) {
      const operation = start(controller, active, 'reclaim')
      expect(controller.markWritten(operation)).toBe(true)
      expect(controller.complete(operation, { readbackMatches: true, targetReachable: false, conflict, path }))
        .toMatchObject({ ok: false, code: 'TARGET_UNREACHABLE' })
    }
    expect(controller.start({ intent: active, action: 'reclaim', conflict, path, snapshot, lease }))
      .toMatchObject({ blocked: true, code: 'RECLAIM_LIMIT' })
  })

  it('外部路径恢复时用当前意图和当前对象重新裁决；旧路径证据不能直接切换', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const stale = start(controller, active, 'takeover')
    const retry = start(controller, active, 'reuse', { conflict: replacement, path: changedPath })
    expect(controller.complete(stale, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: false, code: 'STALE_OPERATION' })
    expect(controller.complete(retry, { readbackMatches: true, targetReachable: true, conflict: replacement, path: changedPath })).toMatchObject({ ok: true, status: 'connected' })
  })

  it('PAC、WPAD、TUN 和企业策略不因类别直接放弃；没有恢复合同或被策略锁定时说明限制', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const pac = start(controller, active, 'takeover', { conflict: { id: 'pac:corp', kind: 'pac' } })
    controller.markWritten(pac)
    expect(controller.complete(pac, { readbackMatches: true, targetReachable: true, conflict: pac.conflict, path })).toMatchObject({ ok: true })
    expect(controller.start({ intent: active, action: 'takeover', conflict: { id: 'policy:managed', kind: 'enterprise-policy' }, path, snapshot, lease,
      restriction: 'POLICY_LOCKED' })).toMatchObject({ blocked: true, code: 'POLICY_LOCKED', status: 'limited' })
    expect(controller.start({ intent: active, action: 'takeover', conflict: { id: 'tun:unknown', kind: 'tun' }, path, snapshot }))
      .toMatchObject({ blocked: true, code: 'RECOVERY_CONTRACT_MISSING' })
    expect(controller.start({ intent: active, action: 'takeover', conflict: { id: 'tun:unknown', kind: 'tun' }, path, lease }))
      .toMatchObject({ blocked: true, code: 'RECOVERY_CONTRACT_MISSING' })
  })

  it('端口和双实例仅按已证实身份处理：自身遗留可接手，外部 PID 不会被宣告可处理', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    expect(controller.start({ intent: active, action: 'takeover', conflict: { id: 'port:laixin-stale:18080', kind: 'laixin-stale-port' }, path, snapshot, lease }))
      .toMatchObject({ action: 'takeover', blocked: false })
    expect(controller.start({ intent: active, action: 'takeover', conflict: { id: 'port:pid:1234', kind: 'external-process' }, path, snapshot, lease,
      restriction: 'PROCESS_OWNERSHIP_UNPROVEN' })).toMatchObject({ blocked: true, code: 'PROCESS_OWNERSHIP_UNPROVEN' })
  })

  it.each(['before-write', 'after-write', 'before-readback', 'before-target-verification'] as const)('取消在 %s 时使动作失效，迟到结果不能宣布成功', (stage) => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'takeover')
    expect(controller.cancel(operation, stage)).toMatchObject({ status: 'recovering' })
    expect(controller.complete(operation, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: false, code: 'STALE_OPERATION' })
  })

  it('崩溃重启恢复只还仍由本次租约拥有且未被第三方改写的值；恢复也读回', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'takeover')
    controller.markWritten(operation)
    expect(controller.recover(operation, { currentValue: operation.writtenValue, readbackMatches: true })).toMatchObject({ ok: true, status: 'recovered', preservedExternal: false })
    const next = start(controller, active, 'takeover')
    controller.markWritten(next)
    expect(controller.recover(next, { currentValue: { proxy: 'third-party:new' }, readbackMatches: true })).toMatchObject({ ok: true, status: 'recovered', preservedExternal: true })
    const failed = start(controller, active, 'takeover')
    controller.markWritten(failed)
    expect(controller.recover(failed, { currentValue: failed.writtenValue, readbackMatches: false })).toMatchObject({ ok: false, code: 'RESTORE_READBACK_MISMATCH' })
  })

  it('账本式恢复只有逐项读回完成后才能显示已恢复，第三方保留值不被序列化到状态', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const operation = start(controller, active, 'restore')
    expect(controller.finishRecovery(operation, { readbackMatches: false })).toMatchObject({ ok: false, code: 'RESTORE_READBACK_MISMATCH' })
    const retry = start(controller, active, 'restore')
    expect(controller.finishRecovery(retry, { readbackMatches: true, preservedExternal: true })).toMatchObject({ ok: true, status: 'recovered' })
    expect(controller.state).not.toHaveProperty('snapshot')
  })

  it('新连接意图使所有旧异步结果、恢复和成功宣告失效', () => {
    const { controller } = availabilityHarness()
    const first = intent(controller, 'connect-a')
    const oldOperation = start(controller, first, 'takeover')
    const second = intent(controller, 'connect-b')
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(controller.complete(oldOperation, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: false, code: 'STALE_OPERATION' })
    expect(controller.fail(oldOperation, 'TARGET_UNREACHABLE')).toMatchObject({ ok: false, code: 'STALE_OPERATION' })
    expect(controller.recover(oldOperation, { currentValue: oldOperation.writtenValue, readbackMatches: true })).toMatchObject({ ok: false, code: 'STALE_OPERATION' })
  })

  it('同一意图 ID 的新代次也不能启动或改写旧动作', () => {
    const { controller } = availabilityHarness()
    const first = intent(controller, 'same-id')
    const second = intent(controller, 'same-id')
    // 让新代次已有一个明确的受限结论；旧 start() 的拒绝不能把这四项重置成它自己的 stale 限制。
    expect(controller.start({ intent: second, action: 'takeover', conflict, path, snapshot, lease,
      restriction: 'POLICY_LOCKED' })).toMatchObject({ blocked: true, code: 'POLICY_LOCKED' })
    const current = structuredClone(controller.state)
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(controller.start({ intent: first, action: 'takeover', conflict, path, snapshot, lease }))
      .toMatchObject({ blocked: true, code: 'STALE_OPERATION' })
    expect(controller.state).toEqual(current)
    expect(controller.state).toMatchObject({
      status: 'limited', action: 'takeover', code: 'POLICY_LOCKED', intentGeneration: second.generation
    })
  })

  it('当前代次进入受限后，在途动作的迟到成功不能覆盖受限结论', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    const inFlight = start(controller, active, 'reuse')
    expect(controller.start({ intent: active, action: 'inspect', conflict, path, restriction: 'POLICY_LOCKED' }))
      .toMatchObject({ blocked: true, code: 'POLICY_LOCKED' })
    const restricted = structuredClone(controller.state)
    expect(controller.complete(inFlight, { readbackMatches: true, targetReachable: true, conflict, path }))
      .toMatchObject({ ok: false, code: 'STALE_OPERATION' })
    expect(controller.state).toEqual(restricted)
  })

  it('大量已完成复用不累积操作记录或终态敏感快照', () => {
    const { controller } = availabilityHarness()
    const active = intent(controller)
    let last: AvailabilityOperation | undefined
    for (let index = 0; index < 10_000; index += 1) {
      last = start(controller, active, 'reuse', {
        snapshot: { id: `snapshot:${String(index)}`, value: { token: `secret-${String(index)}` } },
        writtenValue: { token: `written-${String(index)}` }
      })
      expect(tracked(controller).operations.size).toBe(1)
      expect(controller.complete(last, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ ok: true })
    }
    expect(tracked(controller).operations.size).toBe(0)
    expect(tracked(controller).activeOperation).toBeUndefined()
    expect(last).not.toHaveProperty('snapshot')
    expect(last).not.toHaveProperty('writtenValue')
    expect(controller.state.lastAction).not.toHaveProperty('snapshot')
    expect(controller.state.lastAction).not.toHaveProperty('writtenValue')
  })

  it('活动操作保留到终态；所有终态、替代、受限和换意图均释放历史记录', () => {
    const assertReleased = (controller: NetworkAvailabilityController, operation: AvailabilityOperation) => {
      expect(tracked(controller).operations.size).toBe(0)
      expect(tracked(controller).activeOperation).toBeUndefined()
      expect(operation).not.toHaveProperty('snapshot')
      expect(operation).not.toHaveProperty('writtenValue')
    }
    const run = (action: AvailabilityAction, finish: (controller: NetworkAvailabilityController, operation: AvailabilityOperation) => unknown) => {
      const { controller } = availabilityHarness()
      const active = intent(controller)
      const operation = start(controller, active, action)
      expect(tracked(controller).operations.get(operation.id)).toBe(operation)
      finish(controller, operation)
      assertReleased(controller, operation)
    }

    run('reuse', (controller, operation) => controller.complete(operation, { readbackMatches: true, targetReachable: true, conflict, path }))
    run('reuse', (controller, operation) => controller.fail(operation, 'TARGET_UNREACHABLE'))
    run('takeover', (controller, operation) => controller.cancel(operation, 'before-write'))
    run('takeover', (controller, operation) => {
      controller.markWritten(operation)
      return controller.recover(operation, { currentValue: operation.writtenValue, readbackMatches: true })
    })
    run('restore', (controller, operation) => controller.finishRecovery(operation, { readbackMatches: true }))
    run('reuse', (controller, operation) => controller.complete(operation, { readbackMatches: true, targetReachable: true, conflict: replacement, path }))

    const { controller } = availabilityHarness()
    const active = intent(controller)
    const replaced = start(controller, active, 'takeover')
    const current = start(controller, active, 'inspect')
    expect(tracked(controller).operations.size).toBe(1)
    expect(tracked(controller).operations.has(replaced.id)).toBe(false)
    const beforeLateResult = structuredClone(controller.state)
    expect(controller.complete(replaced, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ code: 'STALE_OPERATION' })
    expect(controller.fail(replaced, 'TARGET_UNREACHABLE')).toMatchObject({ code: 'STALE_OPERATION' })
    expect(controller.recover(replaced, { currentValue: replaced.writtenValue, readbackMatches: true })).toMatchObject({ code: 'STALE_OPERATION' })
    expect(controller.state).toEqual(beforeLateResult)
    controller.complete(current, { readbackMatches: true, targetReachable: true, conflict, path })
    expect(tracked(controller).operations.size).toBe(0)

    const oldIntentOperation = start(controller, active, 'takeover')
    const replacementIntent = intent(controller, 'replacement-intent')
    expect(tracked(controller).operations.size).toBe(0)
    expect(controller.complete(oldIntentOperation, { readbackMatches: true, targetReachable: true, conflict, path })).toMatchObject({ code: 'STALE_OPERATION' })

    const blockedOperation = start(controller, replacementIntent, 'reuse')
    expect(controller.start({ intent: replacementIntent, action: 'inspect', conflict, path, restriction: 'POLICY_LOCKED' }))
      .toMatchObject({ blocked: true, code: 'POLICY_LOCKED' })
    assertReleased(controller, blockedOperation)
  })
})
