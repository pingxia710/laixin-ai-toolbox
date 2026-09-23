import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, makeTempDir, removeTempDir, startFakeUpstream, waitFor } from './helpers'

// N-24:点断开必有结果。修复路径的等锁自旋(tunnel-service.ts stop)没有 deadline——持锁段挂死时
// 断开永不返回、意图也没落盘,客户只能重启应用。这里注入永持锁的假 mutex 守三条线:
// ①挂死时 10 秒内如实返回(意图已写、不说「已断开」、不回 TUNNEL_BUSY);②锁正常释放时照常完整断开。
const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const root = makeTempDir('laixin-stop-deadline-')
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
    spawnDaemon: (_dir, runId) => launch('start', runId), spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'), repairTimeoutMs: 10_000, repairRestoreGraceMs: 800,
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.7' } })
  cleanups.push(async () => {
    await service.stop()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGTERM')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000)
    }
  })
  await service.importConfig(); await service.applyPending()
  const intent = () => JSON.parse(readFileSync(layout.intent(dataDir), 'utf8'))
  const mutex = () => (service as unknown as { mutex: { tryAcquire(): (() => void) | undefined } }).mutex
  return { service, root, dataDir, storePath, children, intent, mutex }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把修复推进到 connecting 阶段:此刻互斥必然已让出、守护已拉起,外面持锁即成「持锁段挂死」现场。 */
async function reachConnectingPhase(f: Awaited<ReturnType<typeof setup>>) {
  f.service.repair()
  await waitFor(() => f.service.repairStatus().phase === 'connecting', 15_000)
  expect(f.intent().desired).toBe('connected')
}

it('持锁段永挂死:断开 10 秒内如实返回且断开意图已落盘,⛔ 永久转圈 ⛔ 谎称已断开 ⛔ 回 TUNNEL_BUSY', async () => {
  const f = await setup()
  await reachConnectingPhase(f)
  // 注入永持锁的假 mutex:任何持锁段挂死(现实形态:慢机磁盘/网络卡死在持锁事务里)的等价现场。
  const release = f.mutex().tryAcquire()
  expect(release).toBeDefined()
  try {
    const started = Date.now()
    const stopping = f.service.stop()
    const sentinel = Symbol('never-settled')
    const result = await Promise.race([stopping.then((value) => value), sleep(14_000).then(() => sentinel)])
    expect(result).not.toBe(sentinel) // 修前在这里红:while(!freed) 无 deadline,断开永不返回
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(9_000) // 给锁留足机会:不是抢跑,是 10 秒兜底
    expect(waited).toBeLessThan(14_000)
    expect(result).toMatchObject({ outcome: 'unknown', code: 'TUNNEL_STOP_TIMEOUT',
      message: '已写入断开意图；通道停止确认超时，请重启工具箱后重试' })
    expect(result).not.toMatchObject({ outcome: 'stopped' }) // ⛔ 谎称已断开
    expect(result).not.toMatchObject({ code: 'TUNNEL_BUSY' }) // ⛔ 让客户再点一次
    expect(f.intent().desired).toBe('user-disconnected') // 断开意图已落盘(意图写不需要锁)
  } finally {
    release?.()
  }
}, 60_000)

it('锁在兜底期限内正常释放:照常完整断开,不因 deadline 改动而退化(回归)', async () => {
  const f = await setup()
  await reachConnectingPhase(f)
  const release = f.mutex().tryAcquire()
  expect(release).toBeDefined()
  const started = Date.now()
  const stopping = f.service.stop()
  await sleep(500)
  release!()
  expect(await stopping).toMatchObject({ outcome: 'stopped', message: '已断开,原设置恢复中' })
  expect(Date.now() - started).toBeLessThan(9_000) // 锁早就出了,兜底不该被等到
  expect(f.intent().desired).toBe('user-disconnected')
  await waitFor(() => ['用户主动断开', '已停止并恢复原设置'].includes(f.service.status().state), 10_000)
}, 40_000)
