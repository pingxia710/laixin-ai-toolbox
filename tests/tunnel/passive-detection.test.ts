// 被动检测(照 mihomo onDialFailed,创始人 09-13「Clash 有的全部加上」):
// 客户的真实请求在通道里连续失败,中继就通知守护立刻复验,⛔ 干等 30 秒定时。
// 这里钉三层:① 中继对一条连接收尾的结论;② 探测器的阈值/窗口/清零;③ 守护收到信号立即复验(不等定时、5 秒内不重复)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createFailureDetector, upstreamPayloadReader, PASSIVE_FAILURE_THRESHOLD } from '../../sidecar/win/local-bridge.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const b = (...bytes: number[]) => Buffer.from(bytes)
const text = (value: string) => Buffer.from(value, 'latin1')

describe('中继对一条连接收尾的结论', () => {
  it('SOCKS5 握手成功 + 回了正文 → ok', () => {
    const reader = upstreamPayloadReader()
    reader.noteRequest(b(5, 1, 0)); reader.consume(b(5, 0))
    reader.noteRequest(b(5, 1, 0, 1, 1, 1, 1, 1, 0, 80)); reader.consume(b(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))
    reader.noteRequest(text('GET / HTTP/1.1\r\n\r\n')); reader.consume(text('HTTP/1.1 200 OK\r\n\r\nhi'))
    expect(reader.verdict()).toBe('ok')
  })

  it('SOCKS5 CONNECT 应答 REP≠0(连接被拒/一般失败)→ failed', () => {
    const reader = upstreamPayloadReader()
    reader.noteRequest(b(5, 1, 0)); reader.consume(b(5, 0))
    reader.noteRequest(b(5, 1, 0, 1, 1, 1, 1, 1, 0, 80)); reader.consume(b(5, 5, 0, 1, 0, 0, 0, 0, 0, 0))
    expect(reader.verdict()).toBe('failed')
  })

  it('SOCKS5 握手成功后客户端发了请求(TLS ClientHello)却一个正文字节没回 → failed;什么都没再发 → none', () => {
    const silent = upstreamPayloadReader()
    silent.noteRequest(b(5, 1, 0)); silent.consume(b(5, 0))
    silent.noteRequest(b(5, 1, 0, 1, 1, 1, 1, 1, 1, 187)); silent.consume(b(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))
    silent.noteRequest(b(0x16, 3, 1, 0, 5, 1, 0, 0, 1))
    expect(silent.verdict()).toBe('failed')
    const idle = upstreamPayloadReader()
    idle.noteRequest(b(5, 1, 0)); idle.consume(b(5, 0))
    idle.noteRequest(b(5, 1, 0, 1, 1, 1, 1, 1, 1, 187)); idle.consume(b(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))
    expect(idle.verdict()).toBe('none')
  })

  it('HTTP CONNECT 非 2xx → failed;200 后正文 → ok', () => {
    const bad = upstreamPayloadReader()
    bad.noteRequest(text('CONNECT a.example:443 HTTP/1.1\r\n\r\n')); bad.consume(text('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    expect(bad.verdict()).toBe('failed')
    const good = upstreamPayloadReader()
    good.noteRequest(text('CONNECT a.example:443 HTTP/1.1\r\n\r\n')); good.consume(text('HTTP/1.1 200 Connection established\r\n\r\n'))
    good.noteRequest(b(0x16, 3, 1)); good.consume(b(0x16, 3, 3))
    expect(good.verdict()).toBe('ok')
  })

  it('本机探活(只发 SOCKS 问候、上游应了就走)不算失败;什么都没发的连接不算数;发了请求上游一声不吭算失败', () => {
    const probe = upstreamPayloadReader()
    probe.noteRequest(b(5, 1, 0)); probe.consume(b(5, 0))
    expect(probe.verdict()).toBe('none')
    expect(upstreamPayloadReader().verdict()).toBe('none')
    const mute = upstreamPayloadReader()
    mute.noteRequest(text('GET http://a.example/ HTTP/1.1\r\n\r\n'))
    expect(mute.verdict()).toBe('failed')
  })
})

describe('探测器:窗口内连续失败到阈值才报,一条成功清零', () => {
  it(`默认 10 秒内 ${PASSIVE_FAILURE_THRESHOLD} 条失败触发一次,触发后清零`, () => {
    const now = 1_000; let fired = 0
    const detector = createFailureDetector({ onDegraded: () => { fired += 1 }, now: () => now })
    expect(detector.report('failed')).toBe(false)
    expect(detector.report('failed')).toBe(false)
    expect(detector.report('failed')).toBe(true)
    expect(fired).toBe(1)
    expect(detector.pendingFailures()).toBe(0)
  })

  it('成功一条清零;超出窗口的旧失败不计', () => {
    let now = 1_000; let fired = 0
    const detector = createFailureDetector({ onDegraded: () => { fired += 1 }, now: () => now })
    detector.report('failed'); detector.report('failed')
    detector.report('ok')
    expect(detector.pendingFailures()).toBe(0)
    detector.report('failed'); now += 11_000; detector.report('failed'); detector.report('failed')
    expect(fired).toBe(0)
    expect(detector.pendingFailures()).toBe(2)
    detector.report('none')
    expect(detector.pendingFailures()).toBe(2)
  })
})

describe('守护收到被动信号立即复验', () => {
  let dataDir: string
  let clock: FakeClock
  beforeEach(() => { dataDir = makeTempDir('laixin-passive-'); clock = new FakeClock() })
  afterEach(() => removeTempDir(dataDir))

  it('已连状态下中继报告连续失败 → 不等 30 秒定时立刻复验;5 秒内重复信号合并;断开后不响应', async () => {
    let verifyCalls = 0
    let degrade: (() => void) | undefined
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'passive', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' } })
    const daemon = createDaemon({ dataDir, clock, adapter: createAdapter({ FAKE_WININET_STORE: `${dataDir}/registry.json` }), random: () => 0,
      parentAlive: () => true, onExit: () => undefined, verifyIntervalMs: 30_000,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => undefined, stop: async () => undefined, localProxyPort: () => 1,
        onLost: () => undefined, verify: async () => { verifyCalls += 1; return { exitIp: '203.0.113.9' } } }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true,
        onLost: () => undefined, onDegraded: (callback: () => void) => { degrade = callback } })
    })
    await daemon.run()
    expect(verifyCalls).toBe(1)
    expect(degrade).toBeDefined()
    degrade!(); await flushMicrotasks()
    expect(verifyCalls).toBe(2)
    // 5 秒内再报:合并,⛔ 连着复验
    clock.advance(1_000); degrade!(); await flushMicrotasks()
    expect(verifyCalls).toBe(2)
    clock.advance(5_000); degrade!(); await flushMicrotasks()
    expect(verifyCalls).toBe(3)
    // 用户断开后信号不再有作用
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'stop' })
    clock.advance(200); await flushMicrotasks(); await flushMicrotasks()
    clock.advance(6_000); degrade!(); await flushMicrotasks()
    expect(verifyCalls).toBe(3)
    daemon.requestShutdown(); await flushMicrotasks()
  })
})
