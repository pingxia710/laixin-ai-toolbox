import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReachabilitySendError, ReachabilityTelemetryQueue } from '../../app/main/tunnel/reachability-telemetry-queue'
import { makeTempDir, removeTempDir } from './helpers'
import type { FunnelAttemptLike } from '../../app/connection-attempt-types'

const attempts = (count = 1, start = 1_000): FunnelAttemptLike[] => Array.from({ length: count }, (_, index) => ({
  trigger: 'connect', startedAt: start + index, endedAt: start + 100 + index, outcome: 'connected',
  nodeId: 'vultr-lax-01', legRole: index % 2 ? 'secondary' : 'primary', stages: []
}))

describe('客户端可达性加密队列', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

  function fixture(enabled = true, now = 100_000) {
    const root = makeTempDir('laixin-reachability-queue-'); roots.push(root)
    const queuePath = join(root, 'reachability-events.enc')
    let clock = now
    const send = vi.fn(async (events: readonly unknown[]) => { void events })
    const queue = new ReachabilityTelemetryQueue({
      queuePath, enabled: () => enabled, platform: 'macos', version: () => '0.7.3', now: () => clock,
      codec: { encrypt: (plain) => Buffer.from(`encrypted:${plain}`), decrypt: (encrypted) => encrypted.toString('utf8').replace(/^encrypted:/, '') }, send
    })
    return { queue, queuePath, send, setNow: (value: number) => { clock = value } }
  }

  it('并发批量补传不重复移除下一批失败事件', async () => {
    const f = fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    f.send.mockImplementation(async events => {
      if ((events[0] as { at: number }).at === 1_100) await held
      else throw new ReachabilitySendError('retryable', 'NETWORK')
    })
    f.queue.collect(attempts(60))
    const first = f.queue.flush(), second = f.queue.flush()
    release(); await Promise.all([first, second])
    // One first batch succeeds. All later batches must fail, regardless of
    // whether a buggy second uploader repeats that first batch.
    const batches = f.send.mock.calls.map(([events]) => events)
    expect(f.queue.pendingCount()).toBe(40)
    expect(batches[0]).not.toEqual(batches[1])
  })

  it('在途批次被容量裁剪后只按已确认 ID 删除，不丢新事件', async () => {
    const f = fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    f.send.mockImplementationOnce(async () => { await held })
      .mockRejectedValue(new ReachabilitySendError('retryable', 'NETWORK'))
    f.queue.collect(attempts(20))
    const sending = f.queue.flush()
    f.queue.collect(attempts(100, 10_000))
    release(); await sending
    expect(f.queue.pendingCount()).toBe(100)
  })

  it('开关关闭时不采集、不落盘、不发请求', async () => {
    const f = fixture(false)
    expect(f.queue.collect(attempts())).toBe(0)
    await f.queue.flush()
    expect(f.queue.pendingCount()).toBe(0)
    expect(f.send).not.toHaveBeenCalled()
    expect(existsSync(f.queuePath)).toBe(false)
  })

  it('只采集一次、加密落盘，并按批次补传', async () => {
    const f = fixture()
    expect(f.queue.collect([...attempts(2), { ...attempts(1)[0]!, nodeId: undefined }])).toBe(2)
    expect(f.queue.collect(attempts(2))).toBe(0)
    expect(f.queue.pendingCount()).toBe(2)
    expect(readFileSync(f.queuePath, 'utf8')).toMatch(/^encrypted:/)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0]).toHaveLength(2)
    expect(f.queue.pendingCount()).toBe(0)
  })

  it('永久合同错误丢弃，认证错误暂停直到会话恢复', async () => {
    const f = fixture()
    f.queue.collect(attempts())
    f.send.mockRejectedValueOnce(new ReachabilitySendError('permanent', 'NETWORK_ROUTE_NOT_FOUND'))
    await f.queue.flush()
    expect(f.queue.pendingCount()).toBe(0)

    f.queue.collect(attempts(2, 2_000))
    f.send.mockRejectedValueOnce(new ReachabilitySendError('auth', 'NETWORK_LOGIN_REQUIRED'))
    f.setNow(200_000)
    await f.queue.flush()
    expect(f.queue.pendingCount()).toBe(2)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.queue.resume()
    f.setNow(300_000)
    await f.queue.flush()
    expect(f.queue.pendingCount()).toBe(0)
  })

  it('可重试失败按 30 秒、2 分钟顺序退避', async () => {
    const f = fixture()
    f.queue.collect(attempts())
    f.send
      .mockRejectedValueOnce(new ReachabilitySendError('retryable', 'NETWORK'))
      .mockRejectedValueOnce(new ReachabilitySendError('retryable', 'NETWORK'))
      .mockResolvedValue(undefined)

    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    f.setNow(129_999)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    f.setNow(130_000)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.setNow(249_999)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.setNow(250_000)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.queue.pendingCount()).toBe(0)
  })

  it('永久丢弃一个批次后,后续批次的可重试事件仍从 30 秒退避', async () => {
    const f = fixture()
    f.queue.collect(attempts(21))
    f.send
      .mockRejectedValueOnce(new ReachabilitySendError('permanent', 'NETWORK_ROUTE_NOT_FOUND'))
      .mockRejectedValue(new ReachabilitySendError('retryable', 'NETWORK'))

    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.queue.pendingCount()).toBe(1)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.setNow(130_000)
    await f.queue.flush()
    expect(f.send).toHaveBeenCalledTimes(3)
  })
})
