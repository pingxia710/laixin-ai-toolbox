import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { AttemptSendError, ATTEMPT_FLUSH_BACKOFF_MS, ConnectionAttemptQueue, type AttemptQueueDeps } from '../../app/main/tunnel/connection-attempt-queue'
import type { FunnelAttemptLike } from '../../app/connection-attempt-types'

// N-79 客户端队列:attemptKey 持久去重(跨重启)、④分流(permanent 丢弃/retryable 退避/auth 暂停)。
const codec = { encrypt: (plain: string) => Buffer.from(plain, 'utf8'), decrypt: (encrypted: Buffer) => encrypted.toString('utf8') }

function failedAttempt (startedAt: number, overrides: Partial<FunnelAttemptLike> = {}): FunnelAttemptLike {
  return {
    trigger: 'connect', startedAt, outcome: 'failed', endedAt: startedAt + 21_000,
    stages: [{ name: 'bridge-start', outcome: 'error', durationMs: 18_000, phase: 'tcp' }], ...overrides
  }
}

describe('connection-attempt 队列(N-79 客户端)', () => {
  let dir: string
  let path: string
  let clock: number
  let failures: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attempt-queue-'))
    path = join(dir, 'connection-attempts.enc')
    clock = 1_000_000
    failures = []
  })

  it('采集去重且跨重启持久:同一条漏斗只入队一次(新实例同路径)', async () => {
    const send = vi.fn(async () => undefined)
    const first = new ConnectionAttemptQueue(makeDeps(send))
    expect(first.collect([failedAttempt(101)])).toBe(1)
    expect(first.collect([failedAttempt(101)])).toBe(0)
    // 「重启」:新实例同路径同 codec——processedKeys 从盘上回来。
    const restarted = new ConnectionAttemptQueue(makeDeps(send))
    expect(restarted.collect([failedAttempt(101)])).toBe(0)
    expect(restarted.collect([failedAttempt(102)])).toBe(1)
    await restarted.flush()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('④permanent(合同不兼容)丢弃并留痕一次,不占重试窗口', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new AttemptSendError('permanent', 'NETWORK_RESPONSE_INVALID'))
      .mockResolvedValueOnce(undefined)
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(201), failedAttempt(202)])
    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(failures.filter((line) => line.startsWith('connection-attempt-dropped'))).toHaveLength(1)
  })

  it('永久丢弃后,同批下一个可重试事件仍从 30 秒退避', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new AttemptSendError('permanent', 'NETWORK_RESPONSE_INVALID'))
      .mockRejectedValue(new AttemptSendError('retryable', 'NETWORK_SERVICE_UNAVAILABLE'))
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(251), failedAttempt(252)])
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(queue.pendingCount()).toBe(1)
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    clock += ATTEMPT_FLUSH_BACKOFF_MS[0]
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('④retryable 保留并进入退避窗:窗内二次 flush 不空转', async () => {
    const send = vi.fn().mockRejectedValue(new AttemptSendError('retryable', 'NETWORK_SERVICE_UNAVAILABLE'))
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(301)])
    await queue.flush()
    expect(queue.pendingCount()).toBe(1)
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(1) // 退避窗内不再发
    // 首败后使用第一档 30 秒，第二次失败后才进入 2 分钟。
    clock += ATTEMPT_FLUSH_BACKOFF_MS[0] + 1
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    clock += ATTEMPT_FLUSH_BACKOFF_MS[1] + 1
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('④auth 暂停:401/403 后不再上送,resume(新会话)后恢复', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new AttemptSendError('auth', 'NETWORK_LOGIN_REQUIRED'))
      .mockResolvedValueOnce(undefined)
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(401)])
    await queue.flush()
    clock += ATTEMPT_FLUSH_BACKOFF_MS[0] + 1
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(1) // 暂停中
    expect(queue.pendingCount()).toBe(1)
    queue.resume()
    await queue.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(queue.pendingCount()).toBe(0)
  })

  it('队列文件可经 codec 往返读回;密文与否是 codec 的合同(生产为加密实现)', () => {
    const queue = new ConnectionAttemptQueue(makeDeps(async () => undefined))
    queue.collect([failedAttempt(501)])
    const stored = JSON.parse(codec.decrypt(readFileSync(path))) as { events: unknown[]; processedKeys: string[] }
    expect(stored.events).toHaveLength(1)
    expect(stored.processedKeys).toEqual(['connect:501'])
  })

  it('重启载入时严格验形;畸形事件不得进入补传', async () => {
    writeFileSync(path, JSON.stringify({
      events: [{ event: { attemptKey: 'connect:999' }, recordedAt: clock }], processedKeys: []
    }))
    const send = vi.fn(async () => undefined)
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    expect(queue.pendingCount()).toBe(0)
    await queue.flush()
    expect(send).not.toHaveBeenCalled()
  })

  function makeDeps (send: AttemptQueueDeps['send']): AttemptQueueDeps {
    return {
      queuePath: path, codec, platform: 'macos',
      version: () => '0.7.0', authorizationHash: () => 'none',
      send, now: () => clock, logFailure: (event, detail) => { failures.push(`${event}:${detail}`) }
    }
  }

  it('并发补传只发送一份队首，可重试失败与后续事件保留到重启', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn<AttemptQueueDeps['send']>(async event => {
      if (event.attemptKey === 'connect:601') await held
      if (event.attemptKey === 'connect:602') throw new AttemptSendError('retryable', 'NETWORK')
    })
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(601), failedAttempt(602), failedAttempt(603)])
    const first = queue.flush(), second = queue.flush()
    release(); await Promise.all([first, second])
    expect(queue.pendingCount()).toBe(2)
    expect(send.mock.calls.filter(([event]) => event.attemptKey === 'connect:601')).toHaveLength(1)
    const resumed = new ConnectionAttemptQueue(makeDeps(send))
    expect(resumed.pendingCount()).toBe(2)
    send.mockResolvedValue(undefined)
    await resumed.flush()
    expect(send.mock.calls.slice(-2).map(([event]) => event.attemptKey)).toEqual(['connect:602', 'connect:603'])
    expect(resumed.pendingCount()).toBe(0)
  })

  it('在途队首被容量裁剪后，旧成功回执不能删除新队首', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn<AttemptQueueDeps['send']>(async event => {
      if (event.attemptKey === 'connect:701') await held
      else throw new AttemptSendError('retryable', 'NETWORK')
    })
    const queue = new ConnectionAttemptQueue(makeDeps(send))
    queue.collect([failedAttempt(701)])
    const sending = queue.flush()
    queue.collect(Array.from({ length: 50 }, (_, index) => failedAttempt(702 + index)))
    release(); await sending
    expect(queue.pendingCount()).toBe(50)
    expect(send.mock.calls[1][0].attemptKey).toBe('connect:702')
  })
})

afterEachCleanup()
function afterEachCleanup () { /* vitest 无需 */ }
void rmSync
