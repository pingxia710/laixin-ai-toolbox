import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import type { RouteTable } from '../../sidecar/mac/daemon-core.mjs'
import { makeTempDir, removeTempDir, startFakeHttpMarker, startFakeSocks5Server } from './helpers'

it('API 目标限制启用后，通用与专用线路仍能通过内部入口核验', async () => {
  const root = makeTempDir('api-network-bridge-')
  const target = await startFakeHttpMarker('reachable-without-ip')
  const upstream = await startFakeSocks5Server({
    'echo.invalid:80': ['127.0.0.1', target.port], 'probe.invalid:80': ['127.0.0.1', target.port]
  })
  const routes = JSON.parse(readFileSync(new URL('../../sidecar/shared/routes.default.json', import.meta.url), 'utf8')) as RouteTable
  const bridge = createLocalBridge({ listenPort: 0, dataDir: root, routes, upstream: undefined,
    outbounds: ['a', 'b'].map(tag => ({ tag, protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port: upstream.port }] } })),
    verifyUrl: 'http://echo.invalid/ip', probeUrls: ['http://probe.invalid/'], verifyTimeoutMs: 500 })
  try {
    await bridge.listen()
    bridge.restrict(['api.example:443'])
    await expect(bridge.probeReachability!()).resolves.toMatchObject({ url: 'http://probe.invalid/' })
    await expect(bridge.verifyDedicated!()).resolves.toBeUndefined()
    expect(upstream.hits().some(hit => hit.host === 'echo.invalid')).toBe(true)
    expect(upstream.hits().some(hit => hit.host === 'probe.invalid')).toBe(true)
  } finally {
    await bridge.close(); await upstream.close(); await target.close(); removeTempDir(root)
  }
}, 10_000)
