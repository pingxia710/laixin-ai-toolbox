import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Crypto from 'node:crypto'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIAGNOSTIC_EVENT_QUEUE_LIMIT,
  DiagnosticEventQueue,
  diagnosticEventBelongsToAuthorization,
  type DiagnosticEvent,
  type EncryptedQueueCodec
} from '../../app/main/tunnel/diagnostic-event-queue'
import { makeTempDir, removeTempDir } from './helpers'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomBytes: ((size: number) => size === 4
    ? Buffer.from('deadbeef', 'hex') : actual.randomBytes(size)) as typeof actual.randomBytes }
})

const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  directories.splice(0).forEach(removeTempDir)
})

function tempDir(): string {
  const directory = makeTempDir('laixin-n53-events-')
  directories.push(directory)
  return directory
}

function testCodec(): EncryptedQueueCodec {
  const key = Buffer.alloc(32, 7)
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}

function readEvents(path: string, codec: EncryptedQueueCodec): DiagnosticEvent[] {
  return JSON.parse(codec.decrypt(readFileSync(path))) as DiagnosticEvent[]
}

function ids() {
  let sequence = 0
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fixture(input: {
  readonly enabled?: () => boolean
  readonly now?: () => number
  readonly send?: (event: DiagnosticEvent) => Promise<void>
  readonly canSend?: (event: DiagnosticEvent) => boolean
  readonly queuePath?: string
  readonly codec?: EncryptedQueueCodec
} = {}) {
  const codec = input.codec ?? testCodec()
  const queuePath = input.queuePath ?? join(tempDir(), 'diagnostic-events.enc')
  const sent: DiagnosticEvent[] = []
  const queue = new DiagnosticEventQueue({
    queuePath,
    codec,
    enabled: input.enabled ?? (() => true),
    platform: 'macos',
    version: () => '0.5.20-test',
    now: input.now ?? (() => 1_000_000),
    createId: ids(),
    canSend: input.canSend,
    send: input.send ?? (async (event) => { sent.push(event) })
  })
  return { queue, queuePath, codec, sent }
}

const failure = {
  failureCategory: 'TUNNEL_COMPONENT_MISSING',
  pathType: 'unknown',
  authorizationId: `lx-${'a'.repeat(32)}`
} as const

describe('N-53 加密离线事件队列', () => {
  it('关闭上报发生在候选取出后时不新发事件，重开后保留的事件仍能送达', async () => {
    let enabled = true
    let allowed = false
    let switched = false
    const f = fixture({ enabled: () => enabled, canSend: () => {
      if (allowed && !switched) { switched = true; queueMicrotask(() => { enabled = false }) }
      return allowed
    } })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    allowed = true
    await f.queue.flushRecovered()
    expect(enabled).toBe(false)
    expect(f.sent).toEqual([])
    expect(f.queue.state()).toEqual({ pending: 0, ready: 1 })
    enabled = true
    await f.queue.flushRecovered()
    expect(f.sent).toHaveLength(1)
    expect(f.queue.state()).toEqual({ pending: 0, ready: 0 })
  })

  it('离线失败只写加密白名单事件，授权 ID 只留下轮换哈希', async () => {
    const f = fixture()
    await f.queue.recordFailure(failure)

    const encrypted = readFileSync(f.queuePath)
    expect(encrypted.toString('utf8')).not.toContain(failure.failureCategory)
    expect(encrypted.toString('utf8')).not.toContain(failure.authorizationId)
    expect(() => JSON.parse(encrypted.toString('utf8'))).toThrow()

    const [event] = readEvents(f.queuePath, f.codec)
    expect(Object.keys(event).sort()).toEqual([
      'authorizationHash', 'clientVersion', 'durationBucket', 'eventId', 'failureCategory',
      'pathType', 'platform', 'repairAction', 'repairResult', 'resultBucket'
    ])
    expect(event).toMatchObject({
      failureCategory: failure.failureCategory,
      resultBucket: 'failed',
      durationBucket: 'unknown',
      pathType: 'unknown',
      repairAction: 'none',
      repairResult: 'not-run',
      platform: 'macos',
      clientVersion: '0.5.20-test',
      authorizationHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('同一轮换窗口哈希稳定，跨窗口轮换且始终不落原授权 ID', async () => {
    let clock = 1_000_000
    const f = fixture({ now: () => clock })
    await f.queue.recordFailure(failure)
    await f.queue.recordFailure(failure)
    const sameWindow = readEvents(f.queuePath, f.codec)
    expect(sameWindow[0].authorizationHash).toBe(sameWindow[1].authorizationHash)

    clock += 8 * 24 * 60 * 60_000
    await f.queue.recordFailure(failure)
    const rotated = readEvents(f.queuePath, f.codec)
    expect(rotated[2].authorizationHash).not.toBe(rotated[1].authorizationHash)
    expect(f.codec.decrypt(readFileSync(f.queuePath))).not.toContain(failure.authorizationId)
  })

  it('崩溃重开后恢复同一事件；验证失败不补传，验证成功才形成闭环并清队列', async () => {
    let clock = 1_000_000
    const first = fixture({ now: () => clock })
    await first.queue.recordFailure(failure)
    await first.queue.markRepairStarted(failure.authorizationId)
    const before = readEvents(first.queuePath, first.codec)[0]

    const sent: DiagnosticEvent[] = []
    const reopened = fixture({
      now: () => clock,
      queuePath: first.queuePath,
      codec: first.codec,
      send: async (event) => { sent.push(event) }
    })
    await reopened.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: false, pathType: 'unknown' })
    await reopened.queue.flushRecovered()
    expect(sent).toEqual([])
    expect(reopened.queue.state()).toEqual({ pending: 1, ready: 0 })

    clock += 45_000
    await reopened.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      eventId: before.eventId,
      failureCategory: before.failureCategory,
      resultBucket: 'recovered',
      pathType: 'laixin',
      repairAction: 'repair',
      repairResult: 'recovered'
    })
    expect(reopened.queue.state()).toEqual({ pending: 0, ready: 0 })
  })

  it('同进程恢复写入分桶耗时，并保留失败前后同一 eventId', async () => {
    let clock = 1_000_000
    const f = fixture({ now: () => clock })
    await f.queue.recordFailure(failure)
    const before = readEvents(f.queuePath, f.codec)[0]
    await f.queue.markRepairStarted(failure.authorizationId)
    clock += 12_000
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'reused' })
    expect(f.sent[0]).toMatchObject({
      eventId: before.eventId,
      durationBucket: '5s-30s',
      pathType: 'reused',
      repairAction: 'repair',
      repairResult: 'recovered'
    })
  })

  it('上传失败继续留队；服务端已收但回执丢失时重试同一 ID 可去重并最终出队', async () => {
    const received = new Set<string>()
    let clock = 1_000_000
    let loseFirstAcknowledgement = true
    const f = fixture({ now: () => clock, send: async (event) => {
      received.add(event.eventId)
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false
        throw new Error('ACK_LOST')
      }
    } })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(f.queue.state()).toEqual({ pending: 0, ready: 1 })

    clock += 30_000
    await f.queue.flushRecovered()
    expect(received.size).toBe(1)
    expect(f.queue.state()).toEqual({ pending: 0, ready: 0 })
  })

  it('修复仍失败后真实路径恢复仍闭合原 eventId，且保留动作失败事实', async () => {
    const f = fixture()
    await f.queue.recordFailure(failure)
    const eventId = await f.queue.markRepairStarted(failure.authorizationId)
    await f.queue.markRepairResult(eventId!, 'still-failing')
    expect(readEvents(f.queuePath, f.codec)[0]).toMatchObject({
      resultBucket: 'failed',
      repairAction: 'repair',
      repairResult: 'still-failing'
    })
    await f.queue.flushRecovered()
    expect(f.sent).toEqual([])
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(f.sent).toEqual([expect.objectContaining({
      eventId,
      resultBucket: 'recovered',
      pathType: 'laixin',
      repairAction: 'repair',
      repairResult: 'still-failing'
    })])
    expect(f.queue.state()).toEqual({ pending: 0, ready: 0 })
  })

  it('修复轮次用稳定 eventId 绑定，真实恢复后一次闭合同授权事件', async () => {
    const f = fixture()
    const originalId = await f.queue.recordFailure(failure)
    expect(await f.queue.markRepairStarted(failure.authorizationId)).toBe(originalId)
    const repairFailureId = await f.queue.recordFailure(failure)
    await f.queue.markRepairResult(originalId!, 'still-failing')

    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(f.sent).toEqual([
      expect.objectContaining({ eventId: originalId, resultBucket: 'recovered', repairResult: 'still-failing' }),
      expect.objectContaining({ eventId: repairFailureId, resultBucket: 'recovered', repairResult: 'recovered' })
    ])
    expect(f.queue.state()).toEqual({ pending: 0, ready: 0 })
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(f.sent).toHaveLength(2)
  })

  it.each(['cancelled', 'unknown'] as const)(
    '修复动作结果 %s 不永久占用本地队列', async (repairResult) => {
      const f = fixture()
      const eventId = await f.queue.recordFailure(failure)
      await f.queue.markRepairResult(eventId!, repairResult)
      await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'reused' })
      expect(f.sent).toEqual([expect.objectContaining({
        eventId,
        resultBucket: 'recovered',
        pathType: 'reused',
        repairAction: 'repair',
        repairResult
      })])
      expect(f.queue.state()).toEqual({ pending: 0, ready: 0 })
    }
  )

  it('慢 POST 不占用落盘串行区，新故障立即加密落盘并可被另一实例恢复', async () => {
    const sendStarted = deferred<void>()
    const releaseSend = deferred<void>()
    const f = fixture({ send: async () => {
      sendStarted.resolve()
      await releaseSend.promise
    } })
    await f.queue.recordFailure(failure)
    const recovery = f.queue.recordRecovery({
      authorizationId: failure.authorizationId, verified: true, pathType: 'laixin'
    })
    await sendStarted.promise

    const newFailure = f.queue.recordFailure(failure)
    const persistedBeforePostReturned = await Promise.race([
      newFailure.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ])
    const reopenedState = persistedBeforePostReturned
      ? fixture({ queuePath: f.queuePath, codec: f.codec }).queue.state()
      : undefined

    releaseSend.resolve()
    await recovery
    await newFailure
    expect(persistedBeforePostReturned).toBe(true)
    expect(reopenedState).toEqual({ pending: 1, ready: 1 })
    expect(f.queue.state()).toEqual({ pending: 1, ready: 0 })
  })

  it('慢 POST 期间换号 resume 不丢触发，当前 flush 结束后立即补传新账号 ready 事件', async () => {
    const authorizationB = `lx-${'b'.repeat(32)}`
    let currentAuthorization: string = failure.authorizationId
    let sendAllowed = false
    const firstSendStarted = deferred<void>()
    const releaseFirstSend = deferred<void>()
    const sent: DiagnosticEvent[] = []
    let sendCount = 0
    const f = fixture({
      canSend: (event) => sendAllowed && diagnosticEventBelongsToAuthorization(event, currentAuthorization, 1_000_000),
      send: async (event) => {
        sent.push(event)
        sendCount += 1
        if (sendCount === 1) {
          firstSendStarted.resolve()
          await releaseFirstSend.promise
          throw new Error('OLD_SESSION_CLOSED')
        }
      }
    })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    await f.queue.recordFailure({ ...failure, authorizationId: authorizationB })
    await f.queue.recordRecovery({ authorizationId: authorizationB, verified: true, pathType: 'laixin' })

    sendAllowed = true
    const firstFlush = f.queue.flushRecovered()
    await firstSendStarted.promise
    currentAuthorization = authorizationB
    await f.queue.resumeUploads()
    releaseFirstSend.resolve()
    await firstFlush

    expect(sent).toHaveLength(2)
    expect(diagnosticEventBelongsToAuthorization(sent[1], authorizationB, 1_000_000)).toBe(true)
    expect(f.queue.state()).toEqual({ pending: 0, ready: 1 })
  })

  it('微任务换号后重新同步校验候选，A 事件绝不进入 B 会话 send', async () => {
    const authorizationB = `lx-${'b'.repeat(32)}`
    let currentAuthorization: string = failure.authorizationId
    let sendAllowed = false
    let switched = false
    const sent: Array<{ readonly event: DiagnosticEvent; readonly session: string }> = []
    const f = fixture({
      canSend: (event) => {
        const allowed = sendAllowed && diagnosticEventBelongsToAuthorization(event, currentAuthorization, 1_000_000)
        if (allowed && !switched && diagnosticEventBelongsToAuthorization(event, failure.authorizationId, 1_000_000)) {
          switched = true
          queueMicrotask(() => { currentAuthorization = authorizationB })
        }
        return allowed
      },
      send: async (event) => { sent.push({ event, session: currentAuthorization }) }
    })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    await f.queue.recordFailure({ ...failure, authorizationId: authorizationB })
    await f.queue.recordRecovery({ authorizationId: authorizationB, verified: true, pathType: 'laixin' })

    sendAllowed = true
    await f.queue.flushRecovered()

    expect(sent).toHaveLength(1)
    expect(sent[0].session).toBe(authorizationB)
    expect(diagnosticEventBelongsToAuthorization(sent[0].event, authorizationB, 1_000_000)).toBe(true)
    expect(f.queue.state()).toEqual({ pending: 0, ready: 1 })
  })

  it('rerun 只触发一次重新筛选，A 成功后 B 失败必须进入退避而不立即重发', async () => {
    const authorizationB = `lx-${'b'.repeat(32)}`
    let currentAuthorization: string = failure.authorizationId
    let sendAllowed = false
    const firstSendStarted = deferred<void>()
    const releaseFirstSend = deferred<void>()
    const sent: DiagnosticEvent[] = []
    const f = fixture({
      canSend: (event) => sendAllowed && diagnosticEventBelongsToAuthorization(event, currentAuthorization, 1_000_000),
      send: async (event) => {
        sent.push(event)
        if (diagnosticEventBelongsToAuthorization(event, failure.authorizationId, 1_000_000)) {
          firstSendStarted.resolve()
          await releaseFirstSend.promise
          return
        }
        throw new Error('B_POST_FAILED')
      }
    })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    await f.queue.recordFailure({ ...failure, authorizationId: authorizationB })
    await f.queue.recordRecovery({ authorizationId: authorizationB, verified: true, pathType: 'laixin' })

    sendAllowed = true
    const flushing = f.queue.flushRecovered()
    await firstSendStarted.promise
    currentAuthorization = authorizationB
    await f.queue.resumeUploads()
    releaseFirstSend.resolve()
    await flushing

    expect(sent).toHaveLength(2)
    expect(diagnosticEventBelongsToAuthorization(sent[0], failure.authorizationId, 1_000_000)).toBe(true)
    expect(diagnosticEventBelongsToAuthorization(sent[1], authorizationB, 1_000_000)).toBe(true)
    await f.queue.flushRecovered()
    expect(sent).toHaveLength(2)
    expect(f.queue.state()).toEqual({ pending: 0, ready: 1 })
  })

  it('筛选 B 的微任务窗口收到 resume 时，B 首次失败仍正常退避', async () => {
    const authorizationB = `lx-${'b'.repeat(32)}`
    let currentAuthorization: string = failure.authorizationId
    let sendAllowed = false
    let resumeScheduled = false
    let resumeUploads = () => Promise.resolve()
    const sent: DiagnosticEvent[] = []
    const f = fixture({
      canSend: (event) => {
        const allowed = sendAllowed && diagnosticEventBelongsToAuthorization(event, currentAuthorization, 1_000_000)
        if (allowed && !resumeScheduled && diagnosticEventBelongsToAuthorization(event, authorizationB, 1_000_000)) {
          resumeScheduled = true
          queueMicrotask(() => { void resumeUploads() })
        }
        return allowed
      },
      send: async (event) => {
        sent.push(event)
        if (diagnosticEventBelongsToAuthorization(event, failure.authorizationId, 1_000_000)) {
          currentAuthorization = authorizationB
          return
        }
        throw new Error('B_POST_FAILED')
      }
    })
    resumeUploads = () => f.queue.resumeUploads()
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    await f.queue.recordFailure({ ...failure, authorizationId: authorizationB })
    await f.queue.recordRecovery({ authorizationId: authorizationB, verified: true, pathType: 'laixin' })

    sendAllowed = true
    await f.queue.flushRecovered()

    expect(sent).toHaveLength(2)
    expect(diagnosticEventBelongsToAuthorization(sent[0], failure.authorizationId, 1_000_000)).toBe(true)
    expect(diagnosticEventBelongsToAuthorization(sent[1], authorizationB, 1_000_000)).toBe(true)
    await f.queue.flushRecovered()
    expect(sent).toHaveLength(2)
  })

  it('没有授权时不生成无法归属、永久留队的事件', async () => {
    const f = fixture()
    expect(await f.queue.recordFailure({ ...failure, authorizationId: '' })).toBeUndefined()
    expect(existsSync(f.queuePath)).toBe(false)
  })

  it('空队列直接修复仍失败时，新失败事件按 eventId 补齐修复动作结果', async () => {
    const f = fixture()
    const eventId = await f.queue.recordFailure(failure)
    await f.queue.markRepairResult(eventId!, 'still-failing')
    expect(readEvents(f.queuePath, f.codec)).toEqual([
      expect.objectContaining({ eventId, repairAction: 'repair', repairResult: 'still-failing' })
    ])
  })

  it('运行时拒绝 TypeScript 合法集之外的修复结果', async () => {
    const f = fixture()
    const eventId = await f.queue.recordFailure(failure)
    await expect(f.queue.markRepairResult(eventId!, 'running' as 'recovered')).rejects.toThrow('DIAGNOSTIC_EVENT_INVALID')
    expect(readEvents(f.queuePath, f.codec)).toEqual([
      expect.objectContaining({ eventId, repairAction: 'none', repairResult: 'not-run' })
    ])
  })

  it('只关联当前授权的最新失败，换号后不会用 B 会话补传 A 事件', async () => {
    const sent: DiagnosticEvent[] = []
    const authorizationB = `lx-${'b'.repeat(32)}`
    const clock = 1_000_000
    let currentAuthorization: string = failure.authorizationId
    const f = fixture({
      now: () => clock,
      canSend: (event) => diagnosticEventBelongsToAuthorization(event, currentAuthorization, clock),
      send: async (value) => { sent.push(value) }
    })
    await f.queue.recordFailure(failure)
    await f.queue.recordFailure({ ...failure, authorizationId: authorizationB })
    await f.queue.markRepairStarted(failure.authorizationId)
    const pending = readEvents(f.queuePath, f.codec)
    expect(pending[0]).toMatchObject({ repairAction: 'repair', repairResult: 'running' })
    expect(pending[1]).toMatchObject({ repairAction: 'none', repairResult: 'not-run' })

    currentAuthorization = authorizationB
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    await f.queue.flushRecovered()
    expect(sent).toHaveLength(0)
    expect(f.queue.state()).toEqual({ pending: 1, ready: 1 })
  })

  it('上传失败后退避，状态轮询不重写队列也不重复 POST', async () => {
    let clock = 1_000_000
    const send = vi.fn(async () => { throw new Error('OFFLINE') })
    const f = fixture({ now: () => clock, send })
    await f.queue.recordFailure(failure)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    const afterFailure = readFileSync(f.queuePath)
    await f.queue.recordRecovery({ authorizationId: failure.authorizationId, verified: true, pathType: 'laixin' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(readFileSync(f.queuePath)).toEqual(afterFailure)
    clock += 30_000
    await f.queue.flushRecovered()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('限额环形淘汰最旧事件并在崩溃重开后保持容量', async () => {
    const f = fixture()
    for (let index = 0; index < DIAGNOSTIC_EVENT_QUEUE_LIMIT + 1; index += 1) {
      await f.queue.recordFailure(failure)
    }
    const events = readEvents(f.queuePath, f.codec)
    expect(events).toHaveLength(DIAGNOSTIC_EVENT_QUEUE_LIMIT)
    expect(events[0].eventId).toBe('00000000-0000-4000-8000-000000000002')

    const reopened = fixture({ queuePath: f.queuePath, codec: f.codec })
    expect(reopened.queue.state()).toEqual({ pending: DIAGNOSTIC_EVENT_QUEUE_LIMIT, ready: 0 })
  })

  it('敏感字段或自由文本输入被拒绝且不创建文件', async () => {
    const f = fixture()
    await expect(f.queue.recordFailure({
      ...failure,
      ip: '203.0.113.8',
      ssid: 'customer-wifi',
      proxy: 'http://127.0.0.1:18080',
      log: 'Authorization: Bearer secret'
    })).rejects.toThrow('DIAGNOSTIC_EVENT_INVALID')
    expect(existsSync(f.queuePath)).toBe(false)
  })

  it('新队列原子 rename 失败时清理本轮自身临时文件', async () => {
    const directory = tempDir()
    const queuePath = join(directory, 'diagnostic-events.enc')
    mkdirSync(queuePath)
    const f = fixture({ queuePath })

    await expect(f.queue.recordFailure(failure)).rejects.toThrow()
    expect(readdirSync(directory).filter((name) => name.startsWith('diagnostic-events.enc.tmp-'))).toEqual([])
  })

  it('新队列 wx 随机名碰撞时不删除非本轮创建的既存临时文件', async () => {
    const directory = tempDir()
    const queuePath = join(directory, 'diagnostic-events.enc')
    const existingTemporary = `${queuePath}.tmp-deadbeef`
    writeFileSync(existingTemporary, 'existing-owner', { mode: 0o600 })
    const f = fixture({ queuePath })

    await expect(f.queue.recordFailure(failure)).rejects.toThrow()
    expect(readFileSync(existingTemporary, 'utf8')).toBe('existing-owner')
  })
})
