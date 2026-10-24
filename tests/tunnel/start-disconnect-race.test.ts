// 收敛包3·件5:F 报告复核——连接流程 syncAccountConfig(含网络请求)与互斥锁的先后关系。
// 故障注入:让 304 复核路径的配置回执(acknowledgement)请求挂起,在同步窗口内点断开,
// 看 start() 恢复执行后是否仍写入 connected 意图(把用户的断开顶掉)。
import { afterEach, expect, it } from 'vitest'
import { randomBytes, sign, createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NetworkAccountClient } from '../../app/main/tunnel/account-client'
import { TunnelService, type TunnelServiceDeps } from '../../app/main/tunnel/tunnel-service'
import { CONNECTION_LEASE_MS, type ConnectionLease } from '../../app/main/tunnel/connection-lease'
import { layout } from '../../app/main/tunnel/paths'
import { makeTempDir, removeTempDir } from './helpers'
import { buildPackageEntries, makeTestKeyPair } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
import { macServiceSidecar } from './fixtures/mac-service-sidecar'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function setup(repairTimeoutMs = 10_000, ensureProxyAuthorization?: TunnelServiceDeps['ensureProxyAuthorization']) {
  const root = makeTempDir('laixin-start-race-')
  cleanups.push(() => removeTempDir(root))
  const clock = Math.floor(Date.now() / 1000) * 1000
  const key = makeTestKeyPair()
  const trust = { whitelistDigests: [], signingPublicKeys: [], trustedIssuers: [key.publicKey] }
  const authorizationId = `lx-${randomBytes(16).toString('hex')}`
  const expiresAt = clock + 86_400_000
  const built = buildPackageEntries({ authorizationId, signWith: key.privateKey,
    issuedAt: new Date(clock).toISOString(), expiresAt: new Date(expiresAt).toISOString() })
  const archive = tarFromPackageEntries(built.entries)
  const configDigest = createHash('sha256').update(archive).digest('hex')
  const etag = `"${configDigest}"`
  const lease: ConnectionLease = { purpose: 'laixin-existing-connection', version: 1, accountId: 'customer-a',
    authorizationId, nodeId: 'race-node', configVersion: 1, configDigest, expiresAt,
    issuedAt: clock, notAfter: clock + CONNECTION_LEASE_MS }
  const payload = Buffer.from(JSON.stringify(lease))
  const leaseToken = `${payload.toString('base64url')}.${sign(null, payload, key.privateKey).toString('base64url')}`
  const controls = {
    calls: [] as string[], unchanged: 0,
    ackFailure: false,
    ackHold: false,
    releaseAck: undefined as undefined | (() => void)
  }
  const token = randomBytes(32).toString('hex')
  // 只模拟客户端所需的 HTTP 合同，不在 Windows 启动依赖 POSIX 权限的服务端存储。
  // 保留真实 fetch、签名校验、ETag/304 和可中止回执，不能直接 mock 掉客户端同步。
  const server: Server = createServer(async (req, res) => {
    controls.calls.push(req.url ?? '')
    if (req.headers.authorization !== `Bearer ${token}` || req.headers['x-laixin-platform'] !== 'macos') {
      res.writeHead(401); res.end(); return
    }
    if (req.url === '/v1/network/connection' && req.method === 'GET') {
      res.setHeader('ETag', etag)
      res.setHeader('X-Laixin-Authorization-Id', authorizationId)
      res.setHeader('X-Laixin-Expires-At', String(expiresAt))
      res.setHeader('X-Laixin-Connection-Lease', leaseToken)
      if (req.headers['if-none-match'] === etag) { controls.unchanged++; res.writeHead(304); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/vnd.laixin.config' }); res.end(archive); return
    }
    if (controls.ackFailure && req.url === '/v1/network/acknowledgement') { res.writeHead(503); res.end(); return }
    if (controls.ackHold && req.url === '/v1/network/acknowledgement') {
      await new Promise<void>((resolve) => { controls.releaseAck = resolve })
    }
    if (req.url === '/v1/network/acknowledgement' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ applied: true })); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/network/`
  const dataDir = join(root, 'device'); const sidecarDir = macServiceSidecar(root)
  cleanups.push(() => controls.releaseAck?.())
  const tunnel = new TunnelService({ dataDir, sidecarDir, platform: 'macos', trust, now: () => clock, picker: async () => undefined,
    repairTimeoutMs,
    ensureProxyAuthorization,
    spawnDaemon: () => ({ on: () => undefined }),
    spawnRestore: () => undefined, routesFile: join(sidecarDir, 'routes.default.json') })
  cleanups.push(() => tunnel.stop().then(() => undefined))
  const access = { client: new NetworkAccountClient(base, 10000, 'macos'), session: { accountId: 'customer-a', accessToken: token, deviceId: 'local-device-one' } }
  const desired = () => JSON.parse(readFileSync(layout.intent(dataDir), 'utf8')).desired as string
  return { root, controls, access, tunnel, desired }
}

it('管理员授权弹窗在途时点断开，授权返回后不能迟到连接', async () => {
  let allow: () => void = () => {}
  let entered = false
  const gate = new Promise<void>((resolve) => { allow = resolve })
  const f = await setup(10_000, async () => { entered = true; await gate; return undefined })
  expect((await f.tunnel.setAccountAccess(f.access)).outcome).toBe('applied')
  const starting = f.tunnel.start()
  await expect.poll(() => entered).toBe(true)
  await f.tunnel.stop()
  allow()
  expect(await starting).toMatchObject({ code: 'TUNNEL_START_CANCELLED' })
  expect(f.desired()).toBe('user-disconnected')
})

it('管理员拒绝授权时不写 connected 意图', async () => {
  const f = await setup(10_000, async () => ({ code: 'TUNNEL_PROXY_AUTH_REQUIRED', message: '需要管理员授权' }))
  expect((await f.tunnel.setAccountAccess(f.access)).outcome).toBe('applied')
  expect(await f.tunnel.start()).toMatchObject({ outcome: 'rejected', code: 'TUNNEL_PROXY_AUTH_REQUIRED' })
  expect(existsSync(join(f.root, 'device', 'intent.json'))).toBe(false)
})

it('同步窗口内用户断开:start() 恢复执行后 ⛔ 顶掉断开意图重写 connected', async () => {
  const f = await setup()

  // 第一次登录同步:让回执失败(503),使下次同步仍会重发回执请求
  f.controls.ackFailure = true
  expect((await f.tunnel.setAccountAccess(f.access)).outcome).toBe('applied')
  f.controls.ackFailure = false

  // 连接:start() 先做账号同步;回执请求挂起 = 同步窗口
  f.controls.ackHold = true
  const callsAtStart = f.controls.calls.length
  const startPromise = f.tunnel.start()
  const deadline = Date.now() + 5_000
  while (!f.controls.calls.slice(callsAtStart).includes('/v1/network/acknowledgement') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(Date.now()).toBeLessThan(deadline)
  expect(f.controls.unchanged).toBeGreaterThan(0)

  // 同步窗口内用户点断开:stop() 中止在途请求并写 user-disconnected
  const stopped = await f.tunnel.stop()
  expect(stopped.outcome).toBe('stopped')
  expect(f.desired()).toBe('user-disconnected')

  const started = await startPromise
  // 断开后的最终意图必须仍是「用户主动断开」;⛔ 被迟到恢复的 start() 盖成 connected
  expect(f.desired()).toBe('user-disconnected')
  expect(started.outcome).toBe('rejected')
}, 20_000)

it.each(['stop', 'logout', 'timeout'] as const)('修复同步窗口内 %s：不迟到连接，不重领网络套餐', async (action) => {
  const f = await setup(action === 'timeout' ? 350 : 10_000)
  f.controls.ackFailure = true
  expect((await f.tunnel.setAccountAccess(f.access)).outcome).toBe('applied')
  f.controls.ackFailure = false
  f.controls.ackHold = true
  const before = f.controls.calls.length
  expect(f.tunnel.repair().outcome).toBe('started')
  await expect.poll(() => f.controls.calls.slice(before).includes('/v1/network/acknowledgement'), { timeout: 3000 }).toBe(true)
  expect(f.controls.unchanged).toBeGreaterThan(0)
  if (action === 'stop') await f.tunnel.stop()
  if (action === 'logout') await f.tunnel.setAccountAccess(undefined)
  await expect.poll(() => f.tunnel.repairStatus().running, { timeout: 3000 }).toBe(false)
  expect(f.tunnel.repairStatus().outcome).toBe(action === 'timeout' ? 'unknown' : 'cancelled')
  f.controls.releaseAck?.()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(f.desired()).toBe('user-disconnected')
  expect(f.controls.calls.slice(before).some((path) => /trial|purchase|payment/.test(path))).toBe(false)
}, 10_000)
