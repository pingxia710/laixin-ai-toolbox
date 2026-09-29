import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { httpGetViaProxy, makeTempDir, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, waitFor, writeIntentFile } from './helpers'

it('真实回环桥：WinINET 恢复受阻时请求仍可达，还原后才关闭实际监听端口', async () => {
  const root = makeTempDir('disconnect-live-bridge-')
  const target = await startFakeHttpMarker('DISCONNECT-RECOVERY-OK')
  const upstream = await startFakeSocks5Server({ 'disconnect.test:80': ['127.0.0.1', target.port] })
  const base = createAdapter({ FAKE_WININET_STORE: join(root, 'settings.json') })
  let blocked = false
  let exited = false
  let bridge: ReturnType<typeof createLocalBridge> | undefined
  const adapter = { ...base, write: (ref: Parameters<typeof base.write>[0], value: Parameters<typeof base.write>[1]) => {
    if (blocked && ['ProxyServer', 'ProxyEnable'].includes(ref.item) && value === null) throw new Error('injected restore write failure')
    base.write(ref, value)
  } }
  const daemon = createDaemon({ dataDir: root, adapter, parentAlive: () => true, onExit: () => { exited = true }, intentPollMs: 50,
    clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
      clearTimer: id => clearTimeout(id as unknown as NodeJS.Timeout) },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => upstream.port, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: (options) => { bridge = createLocalBridge(options); return bridge } })
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code?: string }
  try {
    writeIntentFile(root, { desired: 'connected', sessionToken: 'connected', bridgePort: 0,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.1' } })
    await daemon.run()
    expect(state().state).toBe('connected')
    const port = bridge!.port()
    expect(await httpGetViaProxy(port, 'http://disconnect.test/')).toContain('DISCONNECT-RECOVERY-OK')
    blocked = true
    writeIntentFile(root, { desired: 'user-disconnected', sessionToken: 'stop' })
    await waitFor(() => state().code === 'TUNNEL_RESTORE_INCOMPLETE')
    expect(base.read({ service: 'WinINET', item: 'ProxyEnable' })).toEqual({ type: 'REG_DWORD', data: '1' })
    expect(await httpGetViaProxy(port, 'http://disconnect.test/')).toContain('DISCONNECT-RECOVERY-OK')
    blocked = false
    await waitFor(() => state().state === 'stopped-restored', 5_000)
    expect(base.read({ service: 'WinINET', item: 'ProxyServer' })).toBeNull()
    expect(base.read({ service: 'WinINET', item: 'ProxyEnable' })).toBeNull()
    await expect(httpGetViaProxy(port, 'http://disconnect.test/')).rejects.toThrow()
    expect(upstream.hits()).toHaveLength(2)
  } finally {
    blocked = false
    try {
      daemon.requestShutdown()
      await bridge?.close()
      await waitFor(() => exited, 5_000)
    } finally {
      await upstream.close()
      await target.close()
      removeTempDir(root)
    }
  }
}, 15_000)
