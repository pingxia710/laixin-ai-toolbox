import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetworkAccountClient } from '../../app/main/tunnel/account-client'
import { AttemptSendError, ConnectionAttemptQueue } from '../../app/main/tunnel/connection-attempt-queue'
import type { ConnectionAttemptEvent } from '../../app/connection-attempt-types'

// N-79 审计阻断项①:HTTP 状态→错误码→队列分流必须用真实 HTTP 响应验证,
// ⛔ 只测 AttemptSendError 分类常量。真服务器回 400/403/404/429/503 各自落位。
const codec = { encrypt: (plain: string) => Buffer.from(plain, 'utf8'), decrypt: (encrypted: Buffer) => encrypted.toString('utf8') }
const event = (sequence: number): ConnectionAttemptEvent => ({
  eventId: `0f1e2d3c-4b5a-4978-8a9b-${String(sequence).padStart(12, '0')}`,
  kind: 'connection-attempt', attemptKey: `connect:${1_700_000_000_000 + sequence}`,
  trigger: 'connect', outcome: 'failed', firstFailedStage: 'bridge-start', phase: 'tcp',
  totalMsBucket: '5s-30s', stageMsBuckets: ['bridge-start=5s-30s'],
  clientVersion: '0.7.0', platform: 'macos', authorizationHash: 'none'
})

describe('connection-attempt 的真实 HTTP 分流(N-79 审计①)', () => {
  let server: Server
  let status: number
  let dir: string
  let clock: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'attempt-http-'))
    clock = 1_000_000
    status = 200
    server = createServer((_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.closeAllConnections?.() ?? server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  function wiring () {
    const client = new NetworkAccountClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/network/`)
    const session = { accountId: 'a', accessToken: 't'.repeat(4096), deviceId: 'd' }
    const failures: string[] = []
    const queue = new ConnectionAttemptQueue({
      queuePath: join(dir, 'q.enc'), codec, platform: 'macos', version: () => '0.7.0', authorizationHash: () => 'none',
      now: () => clock, logFailure: (e, d) => { failures.push(`${e}:${d}`) },
      send: async (payload) => {
        try { await client.reportConnectionAttempt(session, new AbortController().signal, payload) }
        catch (error) {
          const code = error instanceof Error ? error.message : 'NETWORK'
          if (code === 'NETWORK_RESPONSE_INVALID' || code === 'NETWORK_ROUTE_NOT_FOUND') throw new AttemptSendError('permanent', code)
          if (code === 'NETWORK_LOGIN_REQUIRED') throw new AttemptSendError('auth', code)
          throw new AttemptSendError('retryable', code)
        }
      }
    })
    return { queue, failures }
  }

  it('404(老后台无路由)→NETWORK_ROUTE_NOT_FOUND→permanent 丢弃并留痕', async () => {
    status = 404
    const { queue, failures } = wiring()
    queue.collect([{ trigger: 'connect', startedAt: 1, outcome: 'failed', endedAt: 2, stages: [] }])
    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
    expect(failures.some((line) => line.includes('NETWORK_ROUTE_NOT_FOUND'))).toBe(true)
  })

  it('400(验形拒绝/合同不兼容)→NETWORK_RESPONSE_INVALID→permanent 丢弃', async () => {
    status = 400
    const { queue, failures } = wiring()
    queue.collect([{ trigger: 'connect', startedAt: 2, outcome: 'failed', endedAt: 3, stages: [] }])
    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
    expect(failures.some((line) => line.includes('NETWORK_RESPONSE_INVALID'))).toBe(true)
  })

  it('403(禁止)→NETWORK_LOGIN_REQUIRED→auth 暂停保留', async () => {
    status = 403
    const { queue } = wiring()
    queue.collect([{ trigger: 'connect', startedAt: 3, outcome: 'failed', endedAt: 4, stages: [] }])
    await queue.flush()
    expect(queue.pendingCount()).toBe(1) // 暂停而非丢弃
  })

  it('429(限流)→可重试保留;退避出窗后重发成功', async () => {
    status = 429
    const { queue } = wiring()
    queue.collect([{ trigger: 'connect', startedAt: 4, outcome: 'failed', endedAt: 5, stages: [] }])
    await queue.flush()
    expect(queue.pendingCount()).toBe(1)
    status = 200
    clock += 2 * 60_000 + 1 // 升档后的退避窗(30s→2min)
    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
  })

  it('503(后台 5xx)→可重试保留且 phase=backend', async () => {
    status = 503
    let seenPhase: string | undefined
    const client = new NetworkAccountClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/network/`)
    try {
      await client.reportConnectionAttempt({ accountId: 'a', accessToken: 't'.repeat(4096), deviceId: 'd' }, new AbortController().signal, event(1))
      throw new Error('should have failed')
    } catch (error) {
      expect((error as { message: string }).message).toBe('NETWORK_SERVICE_UNAVAILABLE')
      seenPhase = (error as { phase?: string }).phase
    }
    expect(seenPhase).toBe('backend')
  })
})
