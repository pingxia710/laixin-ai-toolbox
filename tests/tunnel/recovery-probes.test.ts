import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemon as macDaemon, RECONNECT_BACKOFF_MS } from '../../sidecar/mac/daemon-core.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { CONTROL_CODES, ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { verifyWithFallback, verifyThroughProxy } from '../../sidecar/mac/vless-connector.mjs'
import { buildXrayConfig } from '../../sidecar/mac/local-bridge.mjs'
import { validVerifyFallbackUrl } from '../../sidecar/mac/vless-settings.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, writeIntentFile } from './helpers'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

describe.each([['macOS', macDaemon], ['Windows', winDaemon]] as const)('%s bounded recovery', (_platform, createDaemon) => {
  function harness(random = 0) {
    const dir = makeTempDir('bounded-recovery-'); dirs.push(dir)
    const clock = new FakeClock()
    const intent = { desired: 'connected', sessionToken: 'one', bridgePort: 18080,
      authorization: { id: 'local', expiresAt: clock.now() + 1_000_000 },
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
    writeIntentFile(dir, intent)
    let value: unknown = null
    let offline = false
    const start = vi.fn(async () => { if (offline) throw new Error('offline') })
    const stop = vi.fn(async () => {})
    const verify = vi.fn(async () => ({ exitIp: '203.0.113.1' }))
    const daemon = createDaemon({ dataDir: dir, clock, random: () => random, parentAlive: () => true, onExit: () => {},
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }], read: () => value, write: (_ref, next) => { value = next } },
      connectorFactory: () => ({ kind: 'loopback-probe', start, stop, verify, onLost: () => {}, localProxyPort: () => 1 }),
      bridgeFactory: () => ({ listen: () => {}, close: () => {} }) })
    const advance = async (ms: number) => { clock.advance(ms); await flushMicrotasks() }
    return { dir, clock, daemon, start, stop, verify, intent, advance, value: () => value,
      offline: () => { offline = true }, online: () => { offline = false },
      state: () => readJsonFile<{ state: string; code: string; lastVerifiedAt?: number }>(`${dir}/state.json`) }
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
    expect(h.verify).toHaveBeenCalledTimes(2); expect(h.value()).toBeNull()
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
