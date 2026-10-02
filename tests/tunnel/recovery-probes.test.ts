import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemon as macDaemon, RECONNECT_BACKOFF_MS } from '../../sidecar/mac/daemon-core.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { CONTROL_CODES, ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { SettingsBusyError as MacSettingsBusyError } from '../../sidecar/mac/ledger.mjs'
import { SettingsBusyError as WinSettingsBusyError } from '../../sidecar/win/ledger.mjs'
import { verifyWithFallback, verifyThroughProxy } from '../../sidecar/mac/vless-connector.mjs'
import { buildXrayConfig } from '../../sidecar/mac/local-bridge.mjs'
import { validVerifyFallbackUrl } from '../../sidecar/mac/vless-settings.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, writeIntentFile } from './helpers'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

describe.each([['macOS', macDaemon], ['Windows', winDaemon]] as const)('%s bounded recovery', (_platform, createDaemon) => {
  const SettingsBusy = _platform === 'macOS' ? MacSettingsBusyError : WinSettingsBusyError
  function harness(random = 0, reachability?: () => Promise<{ url: string }>, verifyDedicated?: () => Promise<void>) {
    const dir = makeTempDir('bounded-recovery-'); dirs.push(dir)
    const clock = new FakeClock()
    const intent = { desired: 'connected', sessionToken: 'one', bridgePort: 18080,
      authorization: { id: 'local', expiresAt: clock.now() + 1_000_000 },
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
    writeIntentFile(dir, intent)
    let value: unknown = null
    let pathId = 'network-path:one'
    let offline = false
    const start = vi.fn(async () => { if (offline) throw new Error('offline') })
    const stop = vi.fn(async () => {})
    const verify = vi.fn(async () => ({ exitIp: '203.0.113.1' }))
    const write = vi.fn((_ref: unknown, next: unknown) => { value = next })
    const daemon = createDaemon({ dataDir: dir, clock, random: () => random, parentAlive: () => true, onExit: () => {},
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }], read: () => value,
        write, reapplyOnChange: () => true, currentPathIdentity: () => ({ id: pathId, kind: 'fake-network-path' }) },
      connectorFactory: () => ({ kind: 'loopback-probe', start, stop, verify, onLost: () => {}, localProxyPort: () => 1 }),
      bridgeFactory: () => ({ listen: () => {}, close: () => {}, verifyDedicated, ...(reachability ? { probeReachability: reachability } : {}) }) })
    const advance = async (ms: number) => { clock.advance(ms); await flushMicrotasks() }
    return { dir, clock, daemon, start, stop, verify, write, intent, advance, value: () => value,
      offline: () => { offline = true }, online: () => { offline = false },
      setValue: (next: unknown) => { value = next },
      setPath: (next: string) => { pathId = next },
      state: () => readJsonFile<{ state: string; code: string; lastVerifiedAt?: number;
        availability?: { status: string; code?: string } }>(`${dir}/state.json`) }
  }

  it('jitter stays bounded; five fast failures fall back to one same-node attempt per 60–75 seconds', async () => {
    const h = harness(1)
    h.offline(); await h.daemon.run()
    for (const delay of RECONNECT_BACKOFF_MS) {
      const before = h.start.mock.calls.length
      await h.advance(delay * 1.25 - 1); expect(h.start).toHaveBeenCalledTimes(before)
      await h.advance(1); expect(h.start).toHaveBeenCalledTimes(before + 1)
    }
    await h.advance(74_999); expect(h.start).toHaveBeenCalledTimes(6)
    h.online(); await h.advance(1)
    expect(h.start).toHaveBeenCalledTimes(7); expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it.each(['disconnect', 'expiry', 'fatal'] as const)('slow recovery cannot revive %s', async (reason) => {
    const h = harness()
    h.offline(); await h.daemon.run()
    for (const delay of RECONNECT_BACKOFF_MS) await h.advance(delay)
    if (reason === 'disconnect') writeIntentFile(h.dir, { desired: 'user-disconnected' })
    else if (reason === 'expiry') await h.advance(1_000_000)
    else {
      h.start.mockRejectedValueOnce(new ConnectorError(CONTROL_CODES.hostKeyMismatch))
      await h.advance(60_000)
    }
    await h.advance(500)
    const before = h.start.mock.calls.length
    h.online(); h.daemon.notifyEvent('wake'); await h.advance(180_000)
    expect(h.start).toHaveBeenCalledTimes(before)
    expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('one failed observation gets a short confirmation without replacing a healthy connection', async () => {
    const h = harness(); await h.daemon.run()
    const verifiedAt = h.state().lastVerifiedAt
    h.verify.mockRejectedValueOnce(new Error('temporary timeout'))
    await h.advance(30_000)
    expect(h.state()).toMatchObject({ state: 'degraded', code: 'TUNNEL_VERIFY_UNCONFIRMED', lastVerifiedAt: verifiedAt })
    expect(h.stop).not.toHaveBeenCalled()
    await h.advance(1_000)
    expect(h.state().state).toBe('connected'); expect(h.start).toHaveBeenCalledTimes(1)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('echo endpoint stays unavailable but the tunnel is reachable: repeated checks do not flash unconfirmed', async () => {
    const reachability = vi.fn(async () => ({ url: 'https://probe.example/generate_204' }))
    const h = harness(0, reachability)
    await h.daemon.run()
    h.verify.mockRejectedValue(new ConnectorError(CONTROL_CODES.probeUnavailable))
    for (let index = 0; index < 4; index += 1) {
      await h.advance(30_000)
      expect(h.state()).toMatchObject({ state: 'connected', code: '', pathVerified: true })
    }
    expect(reachability).toHaveBeenCalledTimes(4)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.stop).not.toHaveBeenCalled()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it.each([false, true])('AI 组失败不能被普通组成功盖住（普通组后备探测=%s）', async (fallback) => {
    const dedicated = vi.fn(async () => {})
    const reachability = vi.fn(async () => ({ url: 'https://probe.example/' }))
    const h = harness(0, reachability, dedicated)
    await h.daemon.run()
    if (fallback) h.verify.mockRejectedValue(new ConnectorError(CONTROL_CODES.probeUnavailable))
    dedicated.mockRejectedValue(new ConnectorError(CONTROL_CODES.upstreamUnreachable))
    await h.advance(30_000)
    expect(h.state().state).toBe('degraded')
    await h.advance(1_000)
    expect(h.state().state).toBe('error')
    dedicated.mockResolvedValue()
    await h.advance(2_000)
    expect(h.state().state).toBe('connected')
    expect(h.start).toHaveBeenCalledTimes(2)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('专用组复验尚未结束时断开，迟来的成功不能重新显示已连', async () => {
    const dedicated = vi.fn(async () => {})
    const h = harness(0, undefined, dedicated)
    await h.daemon.run()
    let finish!: () => void
    dedicated.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await h.advance(30_000)
    writeIntentFile(h.dir, { desired: 'user-disconnected' }); await h.advance(500)
    expect(finish).toBeTypeOf('function')
    finish(); await flushMicrotasks()
    expect(h.state().state).toBe('stopped-restored')
    expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it.each(['general', 'dedicated'] as const)('两组并行复验，最后完成的 %s 组成功前不能宣称已连', async (last) => {
    let finishGeneral!: (value: { exitIp: string }) => void
    let finishDedicated!: () => void
    const dedicated = vi.fn(() => new Promise<void>((resolve) => { finishDedicated = resolve }))
    const h = harness(0, undefined, dedicated)
    h.verify.mockImplementation(() => new Promise((resolve) => { finishGeneral = resolve }))
    const running = h.daemon.run()
    await flushMicrotasks()
    // 两组必须已经同时出发；⛔ 串行等第一组耗完整个超时才开始另一组。
    expect(h.verify).toHaveBeenCalledTimes(1)
    expect(dedicated).toHaveBeenCalledTimes(1)
    const finishFirst = () => last === 'general' ? finishDedicated() : finishGeneral({ exitIp: '203.0.113.1' })
    const finishLast = () => last === 'general' ? finishGeneral({ exitIp: '203.0.113.1' }) : finishDedicated()
    finishFirst(); await flushMicrotasks()
    expect(h.state().state).not.toBe('connected')
    finishLast(); await flushMicrotasks()
    // 写后复验也要保持同一保证。
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(dedicated).toHaveBeenCalledTimes(2)
    finishFirst(); await flushMicrotasks()
    expect(h.state().state).not.toBe('connected')
    finishLast(); await running
    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('an echo HTTP failure remains explicitly degraded; unknown transport twice starts recovery', async () => {
    const h = harness(); await h.daemon.run()
    h.verify.mockRejectedValue(new ConnectorError(CONTROL_CODES.probeUnavailable))
    await h.advance(30_000); await h.advance(1_000)
    expect(h.state()).toMatchObject({ state: 'degraded', code: CONTROL_CODES.probeUnavailable })
    expect(h.start).toHaveBeenCalledTimes(1); expect(h.value()).toBe(true)
    h.verify.mockRejectedValue(new Error('transport unknown'))
    await h.advance(29_000); await h.advance(1_000)
    expect(h.state().state).toBe('error')
    await h.advance(2_000); expect(h.start).toHaveBeenCalledTimes(2)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('manual disconnect cancels a pending short confirmation', async () => {
    const h = harness(); await h.daemon.run()
    h.verify.mockRejectedValueOnce(new Error('timeout'))
    await h.advance(30_000)
    writeIntentFile(h.dir, { desired: 'user-disconnected' }); await h.advance(500)
    await h.advance(1_000)
    // N-55:首次接管在写后再实测一次目标；随后断开仍必须取消短确认，不得多出第四次探测。
    expect(h.verify).toHaveBeenCalledTimes(3); expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('写后目标复验失败不能停在接管中或宣布已连接', async () => {
    const h = harness()
    h.verify.mockResolvedValueOnce({ exitIp: '203.0.113.1' }).mockRejectedValueOnce(new Error('target unreachable'))
    await h.daemon.run()
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(h.state()).toMatchObject({ state: 'error', availability: { status: 'recovered', code: 'TUNNEL_AVAILABILITY_TARGET_UNREACHABLE' } })
    expect(h.state().state).not.toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('目标复验在途被外部改写后必须重新读取，不能用旧读回宣布已连接', async () => {
    const h = harness()
    h.verify.mockResolvedValueOnce({ exitIp: '203.0.113.1' }).mockImplementationOnce(async () => {
      h.setValue('external-proxy-value')
      return { exitIp: '203.0.113.1' }
    })
    await h.daemon.run()
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(h.state().state).toBe('error')
    expect(h.state().state).not.toBe('connected')
    expect(h.value()).toBe('external-proxy-value')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('目标复验在途活动路径变更会使旧路径证据失效，不能宣布已连接', async () => {
    const h = harness()
    h.verify.mockResolvedValueOnce({ exitIp: '203.0.113.1' }).mockImplementationOnce(async () => {
      h.setPath('network-path:two')
      return { exitIp: '203.0.113.1' }
    })
    await h.daemon.run()
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(h.state()).toMatchObject({ state: 'error', availability: { code: 'TUNNEL_AVAILABILITY_EVIDENCE_CHANGED' } })
    expect(h.state().state).not.toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('夺回已写入但目标复验不可用时也消耗本轮预算，外部反复改写不能无限抢写', async () => {
    const h = harness()
    await h.daemon.run()
    const writesBeforeReclaims = h.write.mock.calls.length
    h.verify.mockRejectedValue(new ConnectorError(CONTROL_CODES.probeUnavailable))
    for (const external of ['external-1', 'external-2', 'external-3']) {
      h.setValue(external)
      await h.advance(30_000)
      await h.advance(1_000)
    }
    expect(h.write).toHaveBeenCalledTimes(writesBeforeReclaims + 3)
    h.setValue('external-4')
    await h.advance(30_000)
    expect(h.write).toHaveBeenCalledTimes(writesBeforeReclaims + 3)
    expect(h.state().state).toBe('error')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('夺回写入失败标记 WRITE_FAILED，不把未发生的目标复验报成不可达', async () => {
    const h = harness()
    await h.daemon.run()
    const probesBefore = h.verify.mock.calls.length
    h.write.mockImplementationOnce(() => { throw new Error('write denied') })
    h.setValue('external-value')
    await h.advance(30_000)
    expect(h.verify).toHaveBeenCalledTimes(probesBefore)
    expect(h.value()).toBe('external-value')
    expect(h.state()).toMatchObject({ availability: { status: 'limited', code: 'TUNNEL_AVAILABILITY_WRITE_FAILED' } })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('夺回写入后设置锁暂忙时保留当前租约并顺延，不误报目标不可达', async () => {
    const h = harness()
    await h.daemon.run()
    // 稳态第三轮显式 verifySettings(false) 已删(纯重复):补验撞锁的注入点移到 applySettings——
    // 夺回写入后的复读与补写都在它内部的锁里;撞锁(SettingsBusyError → 顺延、租约保留)语义不变。
    const daemonWithSettings = h.daemon as unknown as { applySettings(options?: Record<string, unknown>): unknown }
    const originalApplySettings = daemonWithSettings.applySettings.bind(daemonWithSettings)
    let busyApplies = 0
    vi.spyOn(daemonWithSettings, 'applySettings').mockImplementation((options = {}) => {
      if (busyApplies++ === 0) throw new SettingsBusy('test-holder')
      return originalApplySettings(options)
    })
    h.setValue('external-value')
    const writesBefore = h.write.mock.calls.length
    await h.advance(30_000)
    const internal = h.daemon as unknown as { availabilityReclaimOperation?: { action: string; lease?: { id: string } } }
    expect(h.write).toHaveBeenCalledTimes(writesBefore + 1)
    expect(busyApplies).toBe(1)
    expect(internal.availabilityReclaimOperation).toMatchObject({ action: 'reclaim', lease: { id: expect.any(String) } })
    expect(h.state()).toMatchObject({ state: 'connected', availability: { status: 'reclaiming' } })
    await h.advance(2_000)
    expect(internal.availabilityReclaimOperation).toBeUndefined()
    expect(h.state()).toMatchObject({ state: 'connected', availability: { status: 'connected' } })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('a late confirmation success after disconnect cannot restore connected status', async () => {
    const h = harness(); await h.daemon.run()
    let finish!: (result: { exitIp: string }) => void
    h.verify.mockRejectedValueOnce(new Error('timeout')).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await h.advance(30_000); await h.advance(1_000)
    writeIntentFile(h.dir, { desired: 'user-disconnected' }); await h.advance(500)
    finish({ exitIp: '203.0.113.1' }); await flushMicrotasks()
    expect(h.state().state).toBe('stopped-restored'); expect(h.value()).toBeNull()
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

})

it('fallback requires HTTPS and an independent hostname', () => {
  expect(validVerifyFallbackUrl('https://echo.example/a', 'https://backup.example/ip')).toBe(true)
  for (const fallback of ['http://backup.example/ip', 'https://echo.example/b', 'https://user:pw@backup.example/ip', 'https://api.deepseek.com/ip']) {
    expect(validVerifyFallbackUrl('https://echo.example/a', fallback)).toBe(false)
  }
})

it('a second trusted probe recovers the first echo failure; no valid observation remains unknown', async () => {
  const probe = vi.fn().mockRejectedValueOnce(new ConnectorError(CONTROL_CODES.probeUnavailable)).mockResolvedValueOnce({ exitIp: '203.0.113.9' })
  expect(await verifyWithFallback(1, 'https://echo.example/ip', 'https://backup.example/ip', 10, probe)).toEqual({ exitIp: '203.0.113.9' })
  expect(probe.mock.calls.map((call) => call[1])).toEqual(['https://echo.example/ip', 'https://backup.example/ip'])
  probe.mockRejectedValue(new Error('unknown'))
  await expect(verifyWithFallback(1, 'https://echo.example/ip', 'https://backup.example/ip', 10, probe)).rejects.toThrow()
})

it('real SOCKS/HTTP distinguishes an invalid echo body from a transport failure', async () => {
  const target = await startFakeHttpMarker('not an IP')
  const socks = await startFakeSocks5Server({ [`echo.test:${target.port}`]: ['127.0.0.1', target.port] })
  try {
    await expect(verifyThroughProxy(socks.port, `http://echo.test:${target.port}/ip`, 500)).rejects.toMatchObject({ code: CONTROL_CODES.probeUnavailable })
    await expect(verifyThroughProxy(socks.port, 'http://missing.test:80/ip', 500)).rejects.not.toMatchObject({ code: CONTROL_CODES.probeUnavailable })
  } finally { await socks.close(); await target.close() }
})


it('both probe hosts use the existing tunnel before protected direct rules', () => {
  const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 19000 },
    routes: { directSuffixes: [], protectedDirectSuffixes: ['backup.example'] },
    verifyUrl: 'http://echo.example/ip', verifyFallbackUrl: 'https://backup.example/ip' })
  expect(config.routing.rules.slice(0, 2)).toMatchObject([
    { domain: ['full:echo.example'], outboundTag: 'ssh-socks' },
    { domain: ['full:backup.example'], outboundTag: 'ssh-socks' }
  ])
  expect(config.outbounds).toHaveLength(2)
})
