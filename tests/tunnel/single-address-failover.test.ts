import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../app/main/tunnel/paths'
import { layout } from '../../app/main/tunnel/paths'
import { TunnelService, type ActionResult } from '../../app/main/tunnel/tunnel-service'
import { NetworkAccountClient, NetworkAccountError } from '../../app/main/tunnel/account-client'
import { validatePackage } from '../../app/main/tunnel/package-format'
import { isSingleAddressRefreshFailure, singleAddressRefreshRetryDelay, shouldRetrySingleAddressRefresh } from '../../app/main/tunnel/single-address-failover'
import { appendSettingEntry, markEntry } from '../../sidecar/mac/ledger.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

describe('单地址故障切换判定', () => {
  it.each([
    ['上游不可达', undefined, true],
    ['上游不可达', 'connector-start', true],
    ['上游不可达', 'bridge-start', false],
    ['TUNNEL_CONNECTION_TIMEOUT', 'connector-start', true],
    ['TUNNEL_CONNECTION_TIMEOUT', 'path-verify-before-settings', true],
    ['TUNNEL_CONNECTION_TIMEOUT', 'path-verify-after-settings', true],
    ['TUNNEL_CONNECTION_TIMEOUT', 'bridge-start', false],
    ['TUNNEL_VERIFY_UNCONFIRMED', 'path-verify-before-settings', false],
    ['TUNNEL_TARGET_UNCONFIRMED', 'path-verify-before-settings', false],
    ['TUNNEL_LOCAL_SOCKS_UNAVAILABLE', 'connector-start', false],
    ['端口占用', 'connector-start', false],
    ['授权失效', 'connector-start', false],
    ['TUNNEL_PROXY_AUTH_REQUIRED', 'connector-start', false]
  ] as const)('%s/%s 的数据面刷新判定为 %s', (code, connectStage, expected) => {
    expect(isSingleAddressRefreshFailure({ state: 'error', code, connectStage })).toBe(expected)
  })

  it('只允许连接异常态触发，连接中或主动断开不触发', () => {
    expect(isSingleAddressRefreshFailure({ state: 'connecting', code: '上游不可达' })).toBe(false)
    expect(isSingleAddressRefreshFailure({ state: 'error', code: 'TUNNEL_CONNECTION_CANCELLED' })).toBe(false)
  })

  it('刷新退避有界，后台瞬时失败只重试两轮', () => {
    expect([0, 1, 2, 3].map(singleAddressRefreshRetryDelay)).toEqual([0, 1_000, 3_000, undefined])
    expect(shouldRetrySingleAddressRefresh('NETWORK_SERVICE_UNAVAILABLE')).toBe(true)
    expect(shouldRetrySingleAddressRefresh('NETWORK_LEASE_INVALID')).toBe(true)
    expect(shouldRetrySingleAddressRefresh('NETWORK_APPLICATION_PENDING')).toBe(false)
    expect(shouldRetrySingleAddressRefresh('NETWORK_LEASE_CONTINUATION')).toBe(true)
    expect(shouldRetrySingleAddressRefresh('NETWORK_LOGIN_REQUIRED')).toBe(false)
    expect(shouldRetrySingleAddressRefresh('PACKAGE_SIGNATURE_INVALID')).toBe(false)
  })

  it('单地址包的 bindingVersion 不得回退或丢失', () => {
    const old = buildSingleAddressPackage(1)
    expect(() => validatePackage(old.entries, {
      now: Date.parse('2026-11-06T00:00:00Z'), trust: { whitelistDigests: [old.digest], signingPublicKeys: [] },
      currentAuthorizationId: old.manifest.authorizationId, currentVersion: 1, currentBindingVersion: 2
    })).toThrow('配置版本低于当前')
    const missing = buildSingleAddressPackage(undefined)
    expect(() => validatePackage(missing.entries, {
      now: Date.parse('2026-11-06T00:00:00Z'), trust: { whitelistDigests: [missing.digest], signingPublicKeys: [] },
      currentAuthorizationId: missing.manifest.authorizationId, currentVersion: 1, currentBindingVersion: 1
    })).toThrow('配置版本低于当前')
  })
})

function setupService() {
  const root = makeTempDir('laixin-single-address-refresh-')
  roots.push(root)
  const dataDir = join(root, 'data')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const built = buildSingleAddressPackage(1)
  const packageDir = writePackageDir(join(root, 'package'), built)
  const service = new TunnelService({
    dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
    now: () => Date.parse('2026-11-06T00:00:00Z'),
    allowLocalVerifyUrls: true,
    spawnDaemon: () => ({ on: () => undefined }),
    spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json')
  })
  return { dataDir, service }
}

function buildSingleAddressPackage(bindingVersion: number | undefined) {
  return buildPackageEntries({
    omitCredential: true,
    omitHostKey: true,
    extraFiles: {
      'credentials/vless.json': JSON.stringify({
        uuid: '00000000-0000-4000-8000-000000000001',
        publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverName: 'reality.test.invalid',
        shortId: '0123456789abcdef'
      })
    },
    manifestMutate: (manifest) => {
      const node = manifest.node as { host: string; port: number }
      delete manifest.node
      manifest.protocol = 'vless-reality'
      manifest.verifyUrl = 'https://verify.test.invalid/ip'
      manifest.customerEntry = { host: node.host, port: 24443, ...(bindingVersion === undefined ? {} : { bindingVersion }) }
    }
  })
}

function wireSingleAddressFailure(f: ReturnType<typeof setupService>, result: ActionResult | Promise<ActionResult> | (() => ActionResult | Promise<ActionResult>)) {
  const internals = f.service as unknown as {
    accountAccess?: unknown
    syncAccountConfiguration: (forConnectionAttempt?: boolean) => Promise<ActionResult>
  }
  internals.accountAccess = { client: {}, session: { accountId: 'customer-a', accessToken: 'test-token' } }
  internals.syncAccountConfiguration = vi.fn(async () => await (typeof result === 'function' ? result() : result))
  writeFileAtomic(layout.intent(f.dataDir), `${JSON.stringify({ desired: 'connected', sessionToken: 'session-1' })}\n`)
  writeFileAtomic(layout.state(f.dataDir), `${JSON.stringify({ state: 'error', runId: 'run-1', intentToken: 'session-1', code: '上游不可达', connectStage: 'connector-start' })}\n`)
  return internals.syncAccountConfiguration as ReturnType<typeof vi.fn>
}

it('同一故障片段只启动一个刷新，状态离开异常后新片段获得新代次', async () => {
  const f = setupService()
  await f.service.importConfig()
  expect((await f.service.applyPending()).outcome).toBe('applied')
  let resolve!: (value: ActionResult) => void
  const pending = new Promise<ActionResult>((done) => { resolve = done })
  const refresh = wireSingleAddressFailure(f, pending)

  expect(f.service.status().state).toBe('异常')
  expect(f.service.status().componentMissing).toBe('')
  expect(f.service.status().state).toBe('异常')
  expect(refresh).toHaveBeenCalledTimes(1)

  resolve({ outcome: 'applied', code: '', message: '已切换可用权益，正在重新连接' })
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

  writeFileAtomic(layout.state(f.dataDir), `${JSON.stringify({ state: 'connected', runId: 'run-1', intentToken: 'session-1' })}\n`)
  f.service.status()
  writeFileAtomic(layout.state(f.dataDir), `${JSON.stringify({ state: 'error', runId: 'run-2', intentToken: 'session-1', code: '上游不可达' })}\n`)
  expect(f.service.status().state).toBe('异常')
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('本机恢复或组件状态未收敛时不触发绑定刷新', async () => {
  const f = setupService()
  await f.service.importConfig()
  expect((await f.service.applyPending()).outcome).toBe('applied')
  const refresh = wireSingleAddressFailure(f, { outcome: 'applied', code: '', message: '不应调用' })
  appendSettingEntry(f.dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
    writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: 'session-1', time: 1 })
  expect(f.service.status().state).toBe('异常')
  expect(refresh).not.toHaveBeenCalled()
})

it.each(['current', 'old-session', 'restore-failed', 'dead-owner'])(
  '故障期间 %s 的系统设置账目按真实归属决定是否刷新', async (kind) => {
    vi.useFakeTimers()
    const f = setupService()
    await f.service.importConfig()
    await f.service.applyPending()
    const refresh = wireSingleAddressFailure(f, { outcome: 'applied', code: '', message: '完成' })
    const internals = f.service as unknown as { supervisor: { isRunning(): boolean } }
    vi.spyOn(internals.supervisor, 'isRunning').mockReturnValue(kind !== 'dead-owner')
    const entry = appendSettingEntry(f.dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
      writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
      sessionToken: kind === 'old-session' ? 'session-0' : 'session-1', time: 1 })
    if (kind === 'restore-failed') markEntry(f.dataDir, entry.id, { status: 'restore-failed', note: '写回失败' })
    f.service.status()
    expect(refresh).not.toHaveBeenCalled()
    if (kind === 'current') {
      const intent = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
      expect(intent).toMatchObject({ desired: 'user-disconnected', reason: 'config-refresh' })
      markEntry(f.dataDir, entry.id, { status: 'restored', note: '原代理已恢复' })
      writeFileAtomic(layout.state(f.dataDir), JSON.stringify({ state: 'stopped-restored', intentToken: intent.sessionToken }))
      await vi.advanceTimersByTimeAsync(200)
      expect(refresh).toHaveBeenCalledTimes(1)
    }
  })

it.each(['user-stop', 'logout', 'restore-failed', 'slow-restore'])(
  '取新配置前恢复旧代理：%s 不得绕过或丢失原连接意图', async (mode) => {
    vi.useFakeTimers()
    const f = setupService()
    await f.service.importConfig(); await f.service.applyPending()
    const refresh = wireSingleAddressFailure(f, { outcome: 'applied', code: '', message: '完成' })
    const internals = f.service as unknown as { supervisor: { isRunning(): boolean } }
    vi.spyOn(internals.supervisor, 'isRunning').mockReturnValue(true)
    const entry = appendSettingEntry(f.dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
      writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: 'session-1', time: 1 })
    f.service.status()
    expect(refresh).not.toHaveBeenCalled()
    const intent = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
    expect(intent.reason).toBe('config-refresh')
    if (mode === 'user-stop') await f.service.stop()
    if (mode === 'logout') await f.service.setAccountAccess(undefined)
    if (mode === 'slow-restore') {
      await vi.advanceTimersByTimeAsync(5_200)
      f.service.status() // UI polling must not cancel the pending internal restoration retry.
      expect(refresh).not.toHaveBeenCalled()
    }
    markEntry(f.dataDir, entry.id, { status: mode === 'restore-failed' ? 'restore-failed' : 'restored', note: mode })
    const latest = JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8'))
    writeFileAtomic(layout.state(f.dataDir), JSON.stringify({ state: mode === 'restore-failed' ? 'error' : 'stopped-restored',
      code: mode === 'restore-failed' ? 'TUNNEL_RESTORE_INCOMPLETE' : undefined, intentToken: latest.sessionToken }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledTimes(mode === 'slow-restore' ? 1 : 0)
    if (mode === 'user-stop') expect(JSON.parse(readFileSync(layout.intent(f.dataDir), 'utf8')).reason).toBe('user-stop')
  })

it('真实账号同步遇到后台瞬时不可用时保留原始瞬时码，供刷新回路退避', async () => {
  const f = setupService()
  await f.service.importConfig()
  expect((await f.service.applyPending()).outcome).toBe('applied')
  const internals = f.service as unknown as {
    accountAccess?: unknown
    syncAccountConfiguration: (forConnectionAttempt?: boolean) => Promise<ActionResult>
  }
  internals.accountAccess = {
    client: { claim: vi.fn(async () => { throw new NetworkAccountError('NETWORK_SERVICE_UNAVAILABLE') }) },
    session: { accountId: 'customer-a', accessToken: 'test-token' }
  }
  writeFileAtomic(layout.intent(f.dataDir), `${JSON.stringify({ desired: 'connected', sessionToken: 'session-1' })}\n`)
  writeFileAtomic(layout.state(f.dataDir), `${JSON.stringify({ state: 'connected', intentToken: 'session-1', pathVerified: true })}\n`)

  const result = await internals.syncAccountConfiguration(true)
  expect(result).toMatchObject({ outcome: 'continued', code: 'NETWORK_SERVICE_UNAVAILABLE' })
})

it.each(['NETWORK_SERVICE_UNAVAILABLE', 'NETWORK_LEASE_INVALID', 'NETWORK_LEASE_CONTINUATION', 'thrown'])(
  '持续 %s 失败按 0/1/4 秒调用三次后停止，状态轮询不能重新开启同一片段', async (code) => {
    vi.useFakeTimers()
    const f = setupService()
    await f.service.importConfig()
    expect((await f.service.applyPending()).outcome).toBe('applied')
    const refresh = wireSingleAddressFailure(f, () => {
      if (code === 'thrown') throw new NetworkAccountError('NETWORK_SERVICE_UNAVAILABLE')
      return { outcome: code === 'NETWORK_LEASE_CONTINUATION' ? 'continued' : 'rejected', code, message: '暂时失败' }
    })
    f.service.status()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    for (const [elapsed, calls] of [[999, 1], [1, 2], [2999, 2], [1, 3], [30000, 3]] as const) {
      await vi.advanceTimersByTimeAsync(elapsed)
      for (let poll = 0; poll < 10; poll += 1) f.service.status()
      expect(refresh).toHaveBeenCalledTimes(calls)
    }
  })

it.each(['NETWORK_LOGIN_REQUIRED', 'PACKAGE_SIGNATURE_INVALID'])(
  '%s 不进入刷新重试', async (code) => {
    vi.useFakeTimers()
    const f = setupService()
    await f.service.importConfig()
    await f.service.applyPending()
    const refresh = wireSingleAddressFailure(f, { outcome: 'rejected', code, message: '不重试' })
    f.service.status()
    await vi.advanceTimersByTimeAsync(30_000)
    f.service.status()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

it.each(['timer', 'in-flight'])('用户停止使 %s 的旧刷新失效', async (phase) => {
  vi.useFakeTimers()
  const f = setupService()
  await f.service.importConfig()
  await f.service.applyPending()
  let finish!: (result: ActionResult) => void
  const result = { outcome: 'rejected', code: 'NETWORK_SERVICE_UNAVAILABLE', message: '暂时失败' } as const
  const refresh = wireSingleAddressFailure(f, phase === 'timer' ? result : new Promise<ActionResult>((resolve) => { finish = resolve }))
  f.service.status()
  await vi.advanceTimersByTimeAsync(0)
  await f.service.stop()
  if (phase === 'in-flight') finish(result)
  await vi.advanceTimersByTimeAsync(30_000)
  f.service.status()
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('旧会话的迟到失败不会重试或结束新会话的刷新', async () => {
  vi.useFakeTimers()
  const f = setupService()
  await f.service.importConfig()
  await f.service.applyPending()
  let finish!: (result: ActionResult) => void
  const old = wireSingleAddressFailure(f, new Promise<ActionResult>((resolve) => { finish = resolve }))
  f.service.status()
  const next = wireSingleAddressFailure(f, { outcome: 'rejected', code: 'NETWORK_SERVICE_UNAVAILABLE', message: '暂时失败' })
  writeFileAtomic(layout.intent(f.dataDir), `${JSON.stringify({ desired: 'connected', sessionToken: 'session-2' })}\n`)
  writeFileAtomic(layout.state(f.dataDir), `${JSON.stringify({ state: 'error', runId: 'run-2', intentToken: 'session-2', code: '上游不可达' })}\n`)
  f.service.status()
  finish({ outcome: 'rejected', code: 'NETWORK_SERVICE_UNAVAILABLE', message: '旧失败' })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(old).toHaveBeenCalledTimes(1)
  expect(next).toHaveBeenCalledTimes(3)
})

it.each(['logout', 'shutdown'])('没有界面轮询也会受控刷新，%s 后停止监测', async (end) => {
  vi.useFakeTimers()
  const f = setupService()
  await f.service.importConfig()
  await f.service.applyPending()
  const refresh = wireSingleAddressFailure(f, { outcome: 'rejected', code: 'NETWORK_SERVICE_UNAVAILABLE', message: '暂时失败' })
  const internals = f.service as unknown as { accountAccess?: unknown }
  internals.accountAccess = undefined
  await f.service.setAccountAccess({ client: new NetworkAccountClient('http://127.0.0.1:1/v1/network/'),
    session: { accountId: 'customer-a', accessToken: 'test-token' } })
  refresh.mockClear()
  // No status() call: the main-process monitor owns failure detection.
  await vi.advanceTimersByTimeAsync(1_000)
  expect(refresh).toHaveBeenCalledTimes(1)
  if (end === 'logout') await f.service.setAccountAccess(undefined)
  else await f.service.requestShutdown()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(refresh).toHaveBeenCalledTimes(1)
})
