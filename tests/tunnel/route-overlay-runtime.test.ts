import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { composeRoutes, validatePackage } from '../../app/main/tunnel/package-format'
import { buildXrayConfig, xrayExecutable } from '../../sidecar/mac/local-bridge.mjs'
import { buildXrayConfig as buildWindowsXrayConfig } from '../../sidecar/win/local-bridge.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { buildPackageEntries, makeTestKeyPair } from './fixtures/package-builder'
import { makeTempDir, removeTempDir, startFakeHttpMarker, startFakeSocks5Server } from './helpers'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each([['mac', buildXrayConfig], ['windows', buildWindowsXrayConfig]] as const)('%s 规则表经官方Xray实际转发：签名补充直连、DeepSeek保护、通道收紧和复验优先', async (_platform, build) => {
  const root = makeTempDir('overlay-real-xray-'); cleanup.push(() => removeTempDir(root))
  const target = await startFakeHttpMarker('SIGNED-ROUTES-OK'); cleanup.push(() => target.close())
  const upstream = await startFakeSocks5Server({
    [`forced.vendor.cn:${target.port}`]: ['127.0.0.1', target.port],
    [`verify.overlay-fixture.example:${target.port}`]: ['127.0.0.1', target.port]
  }); cleanup.push(() => upstream.close())
  const keys = makeTestKeyPair()
  const signed = buildPackageEntries({ signWith: keys.privateKey, extraFiles: { 'overlay.json': JSON.stringify({
    directDomains: ['overlay-fixture.example'], tunnelDomains: ['forced.vendor.cn']
  }) } })
  const overlay = validatePackage(signed.entries, { now: Date.parse('2026-10-01T00:00:00Z'), currentVersion: undefined,
    currentAuthorizationId: undefined, trust: { trustedIssuers: [keys.publicKey], signingPublicKeys: [], whitelistDigests: [] } }).overlay
  const routes = composeRoutes({ directSuffixes: ['cn'], protectedDirectSuffixes: ['deepseek.com'] }, overlay)
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  const config = { ...build({ listenPort: port, upstream: { host: '127.0.0.1', port: upstream.port }, routes,
    verifyUrl: `http://verify.overlay-fixture.example:${target.port}/ip` }),
  // Xray-only DNS keeps every possible route on loopback; no OS DNS or proxy setting changes.
    dns: { hosts: { 'overlay-fixture.example': '127.0.0.1', 'api.deepseek.com': '127.0.0.1',
      'forced.vendor.cn': '127.0.0.1', 'verify.overlay-fixture.example': '127.0.0.1' } } }
  // Resolve the synthetic direct names through these Xray-only hosts, rather than the OS resolver.
  config.outbounds = config.outbounds.map((outbound) => (outbound as { tag?: string }).tag === 'direct' ? { ...outbound, settings: { domainStrategy: 'UseIP' } } : outbound)
  const path = join(root, 'xray.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  const child = spawn(xrayExecutable(), ['run', '-config', path], { stdio: 'ignore', env: { ...process.env, XRAY_LOCATION_ASSET: dirname(xrayExecutable()) } })
  const exited = once(child, 'close')
  cleanup.push(async () => { child.kill('SIGTERM'); await exited })
  const request = async (host: string) => {
    const socket = await socks5Connect({ host: '127.0.0.1', port, targetHost: host, targetPort: target.port })
    const result = new Promise<string>((resolve, reject) => {
      let body = ''
      socket.on('data', (bytes) => { body += bytes.toString() }); socket.once('end', () => resolve(body)); socket.once('error', reject)
      socket.setTimeout(2000, () => socket.destroy(new Error('LOCAL_ROUTE_TIMEOUT')))
    })
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    try { return await result } finally { socket.destroy() }
  }
  // A positive direct result must be possible, while routing through the unmapped SOCKS peer would fail.
  await expect.poll(() => request('overlay-fixture.example').catch(() => ''), { timeout: 4000 }).toContain('SIGNED-ROUTES-OK')
  expect(upstream.hits()).toEqual([])
  expect(await request('api.deepseek.com')).toContain('SIGNED-ROUTES-OK'); expect(upstream.hits()).toEqual([])
  expect(await request('forced.vendor.cn')).toContain('SIGNED-ROUTES-OK')
  expect(await request('verify.overlay-fixture.example')).toContain('SIGNED-ROUTES-OK')
  expect(upstream.hits()).toEqual([{ host: 'forced.vendor.cn', port: target.port }, { host: 'verify.overlay-fixture.example', port: target.port }])
}, 10000)
