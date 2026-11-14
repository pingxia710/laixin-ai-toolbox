import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import type { NetworkAccountAccess } from '../../app/main/tunnel/account-client'
import { readCurrentInfo } from '../../app/main/tunnel/import-meta'
import { layout, writeFileAtomic } from '../../app/main/tunnel/paths'
import { appendSettingEntry, markEntry } from '../../sidecar/mac/ledger.mjs'
import { buildPackageEntries } from './fixtures/package-builder'
import { tarFromPackageEntries } from './fixtures/tar-writer'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach(removeTempDir)
})

async function setup() {
  vi.useFakeTimers()
  const root = makeTempDir('laixin-refresh-handoff-')
  roots.push(root)
  const dataDir = join(root, 'data')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const packages = [1, 2].map(configVersion => buildPackageEntries({
    configVersion, omitCredential: true, omitHostKey: true,
    extraFiles: { 'credentials/vless.json': JSON.stringify({
      uuid: '00000000-0000-4000-8000-000000000001', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      serverName: 'reality.test.invalid', shortId: '0123456789abcdef'
    }) },
    manifestMutate: manifest => {
      delete manifest.node
      manifest.protocol = 'vless-reality'
      manifest.verifyUrl = 'https://verify.test.invalid/ip'
      manifest.customerEntry = { host: `node-${configVersion}.test.invalid`, port: 24443, bindingVersion: configVersion }
    }
  }))
  let version = 0
  const claim = vi.fn(async () => ({ id: packages[version].manifest.authorizationId,
    expiresAt: Date.parse(packages[version].manifest.expiresAt), archive: tarFromPackageEntries(packages[version].entries) }))
  const client = { claim, sameEndpoint: (other: unknown): boolean => other === client }
  const access = { client,
    session: { accountId: 'customer-a', accessToken: 'token-a' } } as unknown as NetworkAccountAccess
  let runId: string | undefined
  const deps: ConstructorParameters<typeof TunnelService>[0] = { dataDir, sidecarDir, picker: async () => undefined,
    trust: { whitelistDigests: packages.map(p => p.digest), signingPublicKeys: [] },
    now: () => Date.parse('2026-11-08T00:00:00Z'), allowLocalVerifyUrls: true,
    spawnDaemon: (_dir, id) => { runId = id; return { on: () => undefined } }, spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json') }
  const service = new TunnelService(deps)
  expect((await service.setAccountAccess(access)).outcome).toBe('applied')
  expect((await service.start()).outcome).toBe('started')
  const intent = () => JSON.parse(readFileSync(layout.intent(dataDir), 'utf8'))
  const token = intent().sessionToken
  const entry = appendSettingEntry(dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
    writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: token, time: 1 })
  const internals = service as unknown as { supervisor: { isRunning(): boolean; isResidentOnlyRunning(): boolean } }
  vi.spyOn(internals.supervisor, 'isRunning').mockReturnValue(true)
  vi.spyOn(internals.supervisor, 'isResidentOnlyRunning').mockReturnValue(true)
  writeFileAtomic(layout.state(dataDir), JSON.stringify({ state: 'error', runId, intentToken: token,
    code: '上游不可达', connectStage: 'connector-start' }))
  version = 1
  service.status()
  expect(intent()).toMatchObject({ desired: 'user-disconnected', reason: 'config-refresh' })
  const finishRestore = () => {
    markEntry(dataDir, entry.id, { status: 'restored', note: '原代理恢复完成' })
    const acknowledgeStop = () => {
      if (intent().desired === 'user-disconnected') {
        writeFileAtomic(layout.state(dataDir), JSON.stringify({ state: 'stopped-restored', runId, intentToken: intent().sessionToken }))
      }
    }
    acknowledgeStop()
    setInterval(acknowledgeStop, 100)
  }
  return { service, dataDir, access, intent, finishRestore, claim, reopen: () => new TunnelService(deps) }
}

it.each(['temporary-unavailable', 'session-refresh'] as const)(
  '内部换配置与 %s 交错后，同一账号取得新配置仍自动接续', async mode => {
    const f = await setup()
    let changed: Promise<unknown> | undefined
    if (mode === 'temporary-unavailable') await f.service.setAccountAccess(undefined, 'temporary-unavailable')
    else changed = f.service.setAccountAccess({ ...f.access, session: { ...f.access.session, accessToken: 'token-b' } })
    f.finishRestore()
    await vi.advanceTimersByTimeAsync(6_000)
    if (mode === 'temporary-unavailable') changed = f.service.setAccountAccess(f.access)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(['applied', 'unchanged']).toContain((await changed as { outcome: string }).outcome)
    expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(2)
    expect(f.intent().desired).toBe('connected')
  })

it.each(['user-stop', 'logout', 'account-switch', 'endpoint-change', 'device-change'] as const)(
  '内部恢复期间 %s 不能继承旧任务的连接请求', async mode => {
    const f = await setup()
    if (mode === 'user-stop') await f.service.stop()
    if (mode === 'logout') await f.service.setAccountAccess(undefined)
    const access = mode === 'account-switch'
      ? { ...f.access, session: { ...f.access.session, accountId: 'customer-b' } }
      : mode === 'endpoint-change'
        ? { ...f.access, client: { claim: f.claim, sameEndpoint: () => false } as unknown as NetworkAccountAccess['client'] }
        : mode === 'device-change'
          ? { ...f.access, session: { ...f.access.session, deviceId: 'another-device' } }
          : f.access
    const changed = f.service.setAccountAccess(access)
    f.finishRestore()
    await vi.advanceTimersByTimeAsync(6_000)
    await changed
    expect(f.intent().desired).not.toBe('connected')
  })

it('账号暂时不可用不能取消正在恢复的事务，不等下一次账号刷新也能自动接续', async () => {
  const f = await setup()
  expect((await f.service.setAccountAccess(undefined, 'temporary-unavailable')).outcome).toBe('continued')
  f.finishRestore()
  await vi.advanceTimersByTimeAsync(12_000)
  expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(2)
  expect(f.intent().desired).toBe('connected')
})

it.each(['user-stop', 'logout'] as const)(
  '同账号会话接手续接意图后再 %s，迟到的配置不能重新连接', async action => {
    const f = await setup()
    const handoff = f.service.setAccountAccess({ ...f.access, session: { ...f.access.session, accessToken: 'token-b' } })
    if (action === 'user-stop') await f.service.stop()
    else await f.service.setAccountAccess(undefined)
    f.finishRestore()
    await vi.advanceTimersByTimeAsync(12_000)
    await handoff
    expect(f.intent().desired).not.toBe('connected')
    expect(f.intent().reason).toBe(action === 'user-stop' ? 'user-stop' : 'account-logout')
  })

it.each(['refreshing', 'completed', 'user-stop', 'logout'] as const)(
  '内部换配置期间退出再重开保留最终连接意愿：%s', async mode => {
    const f = await setup()
    f.finishRestore()
    if (mode === 'completed') await vi.advanceTimersByTimeAsync(6_000)
    if (mode === 'user-stop') await f.service.stop()
    if (mode === 'logout') await f.service.setAccountAccess(undefined)
    const supervisor = (f.service as unknown as { supervisor: { waitForExit(): Promise<void> } }).supervisor
    vi.spyOn(supervisor, 'waitForExit').mockResolvedValue(undefined)
    const shutdown = f.service.requestShutdown()
    await vi.advanceTimersByTimeAsync(6_000)
    await shutdown
    const shouldResume = mode === 'refreshing' || mode === 'completed'
    expect(existsSync(join(f.dataDir, 'resume-on-launch'))).toBe(shouldResume)
    f.reopen()
    expect(f.intent().desired === 'connected').toBe(shouldResume)
  })

it('客户主动断开后账号暂时不可用不能抹掉明确断开记录', async () => {
  const f = await setup()
  await f.service.stop()
  expect(f.service.explicitlyStoppedNetwork()).toBe(true)
  await f.service.setAccountAccess(undefined, 'temporary-unavailable')
  expect(f.intent()).toMatchObject({ desired: 'user-disconnected', reason: 'user-stop' })
  expect(f.service.explicitlyStoppedNetwork()).toBe(true)
})

it('客户主动断开后收到新配置仍保留主动断开，更新确认可以识别', async () => {
  const f = await setup()
  await f.service.stop()
  f.finishRestore()
  await vi.advanceTimersByTimeAsync(6_000)
  const sync = f.service.syncAccountConfig()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(['applied', 'unchanged']).toContain((await sync).outcome)
  expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(2)
  expect(f.intent()).toMatchObject({ desired: 'user-disconnected', reason: 'user-stop' })
  expect(f.service.explicitlyStoppedNetwork()).toBe(true)
  expect((await f.service.start()).outcome).toBe('started')
  expect(f.intent().desired).toBe('connected')
})

it('主动断开后账号恢复并导入迟到配置，仍由客户决定何时重连', async () => {
  const f = await setup()
  await f.service.stop()
  await f.service.setAccountAccess(undefined, 'temporary-unavailable')
  f.finishRestore()
  const changed = f.service.setAccountAccess(f.access)
  await vi.advanceTimersByTimeAsync(12_000)
  expect(['applied', 'unchanged']).toContain((await changed).outcome)
  expect(readCurrentInfo(f.dataDir)?.configVersion).toBe(2)
  expect(f.intent()).toMatchObject({ desired: 'user-disconnected', reason: 'user-stop' })
  expect(f.service.explicitlyStoppedNetwork()).toBe(true)
})
