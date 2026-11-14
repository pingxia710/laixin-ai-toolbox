import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackgroundNetworkController, type BackgroundAccount } from '../../app/main/tunnel/background-controller'
import { acquireBackgroundNetworkController, acquireGuiNetworkController, guiNetworkControllerPresent } from '../../app/main/tunnel/controller-seat'
import { NetworkAccountClient, NetworkAccountError, type AccountConfiguration } from '../../app/main/tunnel/account-client'
import { TunnelService, type TunnelServiceDeps } from '../../app/main/tunnel/tunnel-service'
import { readCurrentInfo, writeImportMeta } from '../../app/main/tunnel/import-meta'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
import { makeTempDir, removeTempDir, waitFor } from './helpers'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture(resident = false, expiresAt?: string) {
  const root = makeTempDir('background-network-controller-'), dataDir = join(root, 'data')
  cleanups.push(() => removeTempDir(root))
  const built = buildPackageEntries({ expiresAt })
  const next = buildPackageEntries({ configVersion: 2 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const spawn = vi.fn(() => ({ on: () => undefined }))
  const deps: TunnelServiceDeps = { dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest, next.digest], signingPublicKeys: [] }, now: () => Date.now(),
    routesFile: join(sidecarDir, 'routes.default.json'), spawnDaemon: spawn, spawnRestore: () => undefined,
    ...(resident ? { resident: { armed: () => true, alive: () => true, seatRunId: () => 'fixture-run', wake: async () => true } } : {}) }
  const setup = new TunnelService(deps)
  await setup.importConfig(); expect((await setup.applyPending()).outcome).toBe('applied')
  const current = readCurrentInfo(dataDir)!
  writeImportMeta(dataDir, current.batchId, { accountId: 'fixture-account', sourceLine: 'test', packageDigest: built.digest, importedAt: new Date().toISOString() })
  const binding = { port: 43123, bridgePort: 18080, pid: process.pid, bootId: 'a'.repeat(32), identitySecret: 'b'.repeat(64) }
  const originalIntent = { desired: 'connected', apiOnly: binding, sessionToken: 'fixture-connection', updatedAt: Date.now(),
    authorization: { id: current.authorizationId, expiresAt: Date.parse(current.expiresAt) } }
  const writeIntent = (value: object) => writeFileAtomic(layout.intent(dataDir), JSON.stringify(value))
  writeIntent(originalIntent)
  writeFileAtomic(layout.state(dataDir), JSON.stringify({ state: 'connected', runId: 'fixture-run', pathVerified: true, intentToken: 'fixture-connection' }))
  const client = new NetworkAccountClient('http://127.0.0.1:1/v1/network/')
  const claim = vi.spyOn(client, 'claim').mockRejectedValue(new NetworkAccountError('NETWORK_SERVICE_UNAVAILABLE'))
  let account: BackgroundAccount | undefined = { access: { client, session: { accountId: 'fixture-account', accessToken: 'fixture-token' } }, expiresAt: Date.now() + 60_000 }
  const loadAccount = vi.fn(async () => account)
  const onFailure = vi.fn()
  const controller = new BackgroundNetworkController({ dataDir, router: binding, loadAccount, serviceDeps: () => deps, onFailure })
  cleanups.push(() => controller.stop())
  cleanups.push(() => setup.releaseBackgroundControl())
  return { dataDir, deps, controller, claim, spawn, loadAccount, onFailure, originalIntent, writeIntent,
    account: () => account, setAccount: (value: BackgroundAccount | undefined) => { account = value },
    response: { id: current.authorizationId, expiresAt: Date.parse(next.manifest.expiresAt), archive: tarFromPackageEntries(next.entries) } as AccountConfiguration }
}

it.each(['no-dependency', 'disconnected', 'wrong-router', 'expired', 'wrong-account', 'no-login'])(
  '%s 不发起后台绑定请求或接管系统代理', async kind => {
    const f = await fixture()
    if (kind === 'no-dependency') f.writeIntent({ ...f.originalIntent, apiOnly: undefined })
    if (kind === 'disconnected') f.writeIntent({ desired: 'user-disconnected' })
    if (kind === 'wrong-router') f.writeIntent({ ...f.originalIntent, apiOnly: { ...f.originalIntent.apiOnly, bootId: 'c'.repeat(32) } })
    if (kind === 'expired') f.writeIntent({ ...f.originalIntent, authorization: { expiresAt: Date.now() - 1 } })
    if (kind === 'wrong-account') f.setAccount({ ...f.account()!, access: { ...f.account()!.access, session: { accountId: 'another-account', accessToken: 'fixture-token' } } })
    if (kind === 'no-login') f.setAccount(undefined)
    const before = readFileSync(layout.intent(f.dataDir), 'utf8')
    await f.controller.poll()
    expect(f.claim).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled()
    expect(readFileSync(layout.intent(f.dataDir), 'utf8')).toBe(before)
  })

it('后台请求失败保留已授权的 API 连接，GUI 重开前取消在途事务并释放管理权', async () => {
  const f = await fixture()
  let finish!: (value: AccountConfiguration) => void
  let signal!: AbortSignal
  f.claim.mockImplementationOnce((_session, input) => { signal = input; return new Promise(resolve => { finish = resolve }) })
  await f.controller.poll()
  await waitFor(() => finish !== undefined)
  let guiAcquired = false
  const gui = acquireGuiNetworkController(f.dataDir).then(release => { guiAcquired = true; return release })
  expect(guiNetworkControllerPresent(f.dataDir)).toBe(true)
  const draining = f.controller.poll()
  await waitFor(() => signal.aborted)
  expect(guiAcquired).toBe(false)
  finish(f.response) // Deliberately ignore abort and deliver a valid old reply.
  await draining
  const release = await gui
  try {
    expect(guiAcquired).toBe(true)
    expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))).toEqual(f.originalIntent)
    expect(f.spawn).not.toHaveBeenCalled()
    expect(acquireBackgroundNetworkController(f.dataDir)).toBeUndefined()
    await f.controller.poll(); expect(f.claim).toHaveBeenCalledTimes(1)
  } finally { release() }
})

it.each(['disconnect', 'logout', 'expired-login'])(
  '%s 使正在等待的后台请求失效，迟到成功不得重新连接', async kind => {
    const f = await fixture()
    let finish!: (value: AccountConfiguration) => void
    let signal!: AbortSignal
    f.claim.mockImplementationOnce((_session, input) => { signal = input; return new Promise(resolve => { finish = resolve }) })
    await f.controller.poll(); await waitFor(() => finish !== undefined)
    if (kind === 'disconnect') f.writeIntent({ desired: 'user-disconnected', reason: 'user-stop' })
    if (kind === 'logout') writeFileSync(join(f.dataDir, 'account-signed-out'), '1')
    if (kind === 'expired-login') Object.assign(f.account()!, { expiresAt: Date.now() - 1 })
    const draining = f.controller.poll()
    await waitFor(() => signal.aborted)
    finish(f.response); await draining
    expect(f.spawn).not.toHaveBeenCalled()
    const intent = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
    expect(intent.desired).toBe(kind === 'expired-login' ? 'connected' : 'user-disconnected')
    expect(existsSync(join(f.dataDir, 'controller-owner', 'daemon.lock'))).toBe(false)
  })

it.each(['success', 'denial'])('GUI 宣告重开后，尚未轮询到的迟到 %s 不得写配置或断开原通道', async outcome => {
  const f = await fixture()
  let finish!: (value: AccountConfiguration) => void
  let deny!: (error: Error) => void
  f.claim.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; deny = reject }))
  await f.controller.poll(); await waitFor(() => finish !== undefined)
  const gui = acquireGuiNetworkController(f.dataDir)
  if (outcome === 'success') finish(f.response)
  else deny(new NetworkAccountError('NETWORK_AUTHORIZATION_UNAVAILABLE'))
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(1)
    expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))).toEqual(f.originalIntent)
  } finally {
    await f.controller.poll()
    const release = await gui
    release()
  }
})

it.each([false, true])('GUI 在后台已停止旧配置时接手：保留内部重连，但尊重新的主动停止（userStop=%s）', async userStop => {
  const f = await fixture(true)
  f.claim.mockResolvedValue(f.response)
  await f.controller.poll()
  await waitFor(() => JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8')).reason === 'config-refresh')
  const gui = acquireGuiNetworkController(f.dataDir)
  if (userStop) f.writeIntent({ desired: 'user-disconnected', reason: 'user-stop', sessionToken: 'newer-stop' })
  await f.controller.poll()
  const release = await gui
  try {
    const reopened = new TunnelService(f.deps)
    const intent = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
    expect(intent.desired).toBe(userStop ? 'user-disconnected' : 'connected')
    expect(intent.apiOnly).toBeUndefined()
    await reopened.releaseBackgroundControl()
  } finally { release() }
})

it('前台交接超时保留活跃后台管理权，清理自己的占位', async () => {
  const f = await fixture()
  const release = acquireBackgroundNetworkController(f.dataDir)!
  try {
    await expect(acquireGuiNetworkController(f.dataDir, 10)).rejects.toThrow('NETWORK_CONTROLLER_BUSY')
    expect(guiNetworkControllerPresent(f.dataDir)).toBe(false)
    expect(acquireBackgroundNetworkController(f.dataDir)).toBeUndefined()
  } finally { release() }
})

it.each([30_001, 61_000])('后台同会话在 %i ms 重试配置并恢复有效新包', async elapsed => {
  const started = Date.now()
  const f = await fixture(false, new Date(started + 60_000).toISOString())
  f.setAccount({ ...f.account()!, expiresAt: started + 24 * 3600_000 })
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    await f.controller.poll()
    await new Promise(resolve => setTimeout(resolve, 20))
    f.claim.mockResolvedValue(f.response)
    await vi.advanceTimersByTimeAsync(5_001)
    await f.controller.poll()
    expect(f.claim).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(elapsed - 5_001)
    if (elapsed > 60_000) expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8')))
      .toMatchObject({ desired: 'user-disconnected', reason: 'authorization-expired' })
    await f.controller.poll()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.claim).toHaveBeenCalledTimes(2)
    await waitFor(() => readCurrentInfo(f.dataDir)?.configVersion === 2)
    expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))).toMatchObject({ desired: 'connected', apiOnly: f.originalIntent.apiOnly })
  } finally { await f.controller.stop(); vi.useRealTimers() }
})

it('后台到期后拒绝无效续期，主动断开终止后续配置重试', async () => {
  const started = Date.now()
  const f = await fixture(false, new Date(started + 60_000).toISOString())
  f.setAccount({ ...f.account()!, expiresAt: started + 24 * 3600_000 })
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    await f.controller.poll(); await new Promise(resolve => setTimeout(resolve, 20))
    await vi.advanceTimersByTimeAsync(61_000)
    f.claim.mockResolvedValue({ ...f.response, expiresAt: started + 60_000 })
    await f.controller.poll(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.claim).toHaveBeenCalledTimes(2)
    expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(1)
    expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8')))
      .toMatchObject({ desired: 'user-disconnected', reason: 'authorization-expired' })
    f.writeIntent({ desired: 'user-disconnected', reason: 'user-stop' })
    await f.controller.poll()
    await vi.advanceTimersByTimeAsync(31_000); await f.controller.poll()
    expect(f.claim).toHaveBeenCalledTimes(2)
  } finally { await f.controller.stop(); vi.useRealTimers() }
})

it('后台配置重试在途时不重入，GUI 接管会取消迟到结果', async () => {
  const f = await fixture()
  f.setAccount({ ...f.account()!, expiresAt: Date.now() + 24 * 3600_000 })
  let finish!: (value: AccountConfiguration) => void, signal!: AbortSignal
  f.claim.mockImplementationOnce((_session, input) => { signal = input; return new Promise(resolve => { finish = resolve }) })
  await f.controller.poll(); await waitFor(() => finish !== undefined)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 90_000)
    await f.controller.poll(); await f.controller.poll()
    expect(f.claim).toHaveBeenCalledTimes(1)
    const acquiring = acquireGuiNetworkController(f.dataDir)
    const detach = f.controller.poll()
    await waitFor(() => signal.aborted)
    finish(f.response)
    await detach
    const release = await acquiring
    try { expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(1) } finally { release() }
  } finally { vi.useRealTimers() }
})
