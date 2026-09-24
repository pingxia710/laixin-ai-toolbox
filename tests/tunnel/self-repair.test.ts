import { freePort } from './fixtures/reality-node'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, forceTunnelPathForTest, makeTempDir, readFakeOps, readFakeStore, removeTempDir, startFakeUpstream, waitFor } from './helpers'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(timeoutMs = 10_000, launchDaemon = true) {
  const root = makeTempDir('laixin-self-repair-')
  cleanups.push(() => removeTempDir(root))
  const upstream = await startFakeUpstream()
  cleanups.push(() => upstream.killAll())
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const adapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const children: ChildProcess[] = []
  const launch = (command: string, runId = '') => {
    const child = spawn(process.execPath, [join(sidecarDir, 'tunnel-daemon.mjs'), command, '--data-dir', dataDir,
      '--adapter', adapter, '--run-id', runId, '--intent-poll-ms', '30', '--verify-interval-ms', '60000'],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: 'ignore' })
    children.push(child); return child
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (dir, runId) => {
      forceTunnelPathForTest(dir)
      return launchDaemon ? launch('start', runId) : { on: () => undefined }
    }, spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'), repairTimeoutMs: timeoutMs, repairRestoreGraceMs: 800,
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.7' } })
  cleanups.push(async () => {
    await service.stop()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGTERM')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000)
    }
  })
  const registry = new BridgeRegistry(); registerActions(registry, { service })
  await service.importConfig(); await service.applyPending()
  const intent = () => JSON.parse(readFileSync(layout.intent(dataDir), 'utf8'))
  const finish = async () => { await waitFor(() => !service.repairStatus().running, 15_000); return service.repairStatus() }
  return { service, registry, root, dataDir, storePath, children, intent, finish }
}

it('零参数修复：真实守护和本机回环复验后才成功，复制摘要不带令牌', async () => {
  const f = await setup()
  await expect(f.registry.execute('tunnel.repair', { force: true })).rejects.toThrow()
  expect(await f.registry.execute('tunnel.repair', undefined)).toMatchObject({ outcome: 'started' })
  expect(f.service.repairStatus().running).toBe(true)
  expect(await f.finish()).toMatchObject({ outcome: 'recovered', phase: 'finished' })
  expect(f.service.status()).toMatchObject({ state: '已连', exitIp: '203.0.113.7' })
  expect(readFakeStore(f.storePath)['Wi-Fi/socks-proxy']).toMatchObject({ enabled: true })
  const view = JSON.stringify(await f.registry.execute('tunnel.repairStatus', undefined))
  expect(view).not.toContain(f.intent().sessionToken)
  expect(view).not.toContain('credentials')
}, 20_000)

it('旧成功快照不算本次修复；守护未回应时限时退出为尚不能确认', async () => {
  const f = await setup(350, false)
  writeFileSync(layout.state(f.dataDir), JSON.stringify({ state: 'connected', sessionToken: 'old-attempt',
    exitIp: '203.0.113.8', lastVerifiedAt: Date.now() }))
  f.service.repair()
  expect(await f.finish()).toMatchObject({ outcome: 'unknown', code: 'TUNNEL_REPAIR_TIMEOUT' })
  expect(f.intent().desired).toBe('user-disconnected')
})

it('组件缺失保留明确原因，不能当通道可用；账号未登录也不私自领取权益', async () => {
  const f = await setup()
  const deps = (f.service as unknown as { deps: { sidecarDir: string } }).deps
  deps.sidecarDir = join(f.root, 'missing-sidecar')
  f.service.repair()
  expect(await f.finish()).toMatchObject({ outcome: 'still_failing', code: 'TUNNEL_COMPONENT_MISSING' })
  // 主进程组件闸先于守护抛这个码，客户要看到的是可照做的一句，不是文件名清单。
  expect(f.service.repairStatus().message).toBe('工具箱网络组件缺失，请安装完整的最新版工具箱后重试。')
  expect(f.children).toHaveLength(0)
})

it('重复修复与连接/导入/应用不能插队，用户取消后不自动接回', async () => {
  const f = await setup()
  f.service.repair()
  expect(f.service.repair()).toMatchObject({ outcome: 'rejected' })
  expect(await f.service.start()).toMatchObject({ outcome: 'rejected' })
  expect(await f.service.importConfig()).toMatchObject({ outcome: 'rejected' })
  expect(await f.service.applyPending()).toMatchObject({ outcome: 'rejected' })
  const childrenBeforeStop = f.children.length
  await f.service.stop()
  expect(await f.finish()).toMatchObject({ outcome: 'cancelled' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(f.intent().desired).toBe('user-disconnected')
  expect(f.children).toHaveLength(childrenBeforeStop)
})

it('修复开始同时退出工具箱：退出指令不能被修复的迟到断开覆盖', async () => {
  const f = await setup()
  await f.service.start(); await waitFor(() => f.service.status().state === '已连', 10_000)
  f.service.repair()
  await f.service.requestShutdown()
  expect(await f.finish()).toMatchObject({ outcome: 'cancelled' })
  expect(f.intent().desired).toBe('shutdown')
}, 20_000)

it('新电脑已有别的代理但它出不了外网(端口没人听):接管建来信连接,把它的设置记成原值(创始人 09-13 夜:能用就复用,不能用就接通)', async () => {
  const f = await setup()
  // 用一个确定没人监听的口当「别的代理」:探测一定失败 → 走接管,⛔ 撞上本机真开着的代理
  const foreign = { enabled: true, host: '127.0.0.1', port: await freePort() }
  writeFileSync(f.storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': foreign }))
  f.service.repair()
  const result = await f.finish()
  expect(result.outcome).toBe('recovered')
  // ⛔ 把 18080 写死:入口端口按候选表走(被占就换下一个),别的树在跑测试、或客户机上真跑着别的代理
  // 占了 18080,这条就会红成「恢复错了」,而其实恢复完全正确、只是换了口。要验的是「指向守护此刻实际用的入口」。
  const bridgePort = JSON.parse(readFileSync(layout.state(f.dataDir), 'utf8')).bridgePort as number
  expect(bridgePort).toBeGreaterThan(0)
  expect(readFakeStore(f.storePath)['Wi-Fi/socks-proxy']).toEqual({ enabled: true, host: '127.0.0.1', port: bridgePort })
  expect(readFakeOps(f.storePath).some((op) => op.op === 'write')).toBe(true)
})

it('已连接再次修复，必须取得新的连接令牌和复验，不能复用旧成功', async () => {
  const f = await setup()
  await f.service.start(); await waitFor(() => f.service.status().state === '已连', 10_000)
  const previous = f.intent().sessionToken
  f.service.repair()
  expect(await f.finish()).toMatchObject({ outcome: 'recovered' })
  expect(f.intent().sessionToken).not.toBe(previous)
  expect(readFakeOps(f.storePath).filter((op) => op.op === 'write').length).toBeGreaterThanOrEqual(2)
}, 25_000)

it('恢复遇到他人改动时保留现场、不强制清账本，不宣称恢复成功', async () => {
  const f = await setup(500)
  await f.service.start(); await waitFor(() => f.service.status().state === '已连', 10_000)
  const foreign = { enabled: true, host: '127.0.0.1', port: 7890 }
  writeFileSync(f.storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': foreign }))
  f.service.repair()
  expect(await f.finish()).toMatchObject({ outcome: 'still_failing', code: 'TUNNEL_RESTORE_INCOMPLETE' })
  expect(readFakeStore(f.storePath)['Wi-Fi/socks-proxy']).toEqual(foreign)
  expect(f.intent().desired).toBe('user-disconnected')
}, 20_000)
