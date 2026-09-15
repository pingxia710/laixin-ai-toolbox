import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, makeTempDir, removeTempDir, startFakeUpstream, waitFor } from './helpers'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(timeoutMs = 10_000) {
  const root = makeTempDir('laixin-cancel-repair-')
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
  await service.importConfig(); await service.applyPending()
  const intent = () => JSON.parse(readFileSync(layout.intent(dataDir), 'utf8'))
  const mutex = () => (service as unknown as { mutex: { tryAcquire(): (() => void) | undefined } }).mutex
  return { service, root, dataDir, storePath, children, intent, mutex }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 把修复推进到 connecting 阶段：connected 意图已写、守护已拉起——客户点「取消修复并断开」时通道还在连的那一幕。 */
async function reachConnectingPhase(f: Awaited<ReturnType<typeof setup>>) {
  f.service.repair()
  // phase('connecting') 与其后的 startConnection 同步段之间没有事件循环空隙：看到 connecting 时
  // connected 意图必然已写入、互斥也已在 finally 里让出，此刻从外面持锁不会打断修复自己的连接。
  await waitFor(() => f.service.repairStatus().phase === 'connecting', 15_000)
  expect(f.intent().desired).toBe('connected')
}

it('取消修复时锁被长期占用(模拟导入配置的文件对话框)：取消后通道要真停,⛔ 谎称「正在停止连接」', async () => {
  const f = await setup()
  await reachConnectingPhase(f)
  // importConfig 开着文件选择对话框时会这样长期持锁
  const release = f.mutex().tryAcquire()
  expect(release).toBeDefined()
  try {
    const childrenBeforeStop = f.children.length
    const stopping = f.service.stop()
    let settled = false
    void stopping.then(() => { settled = true }, () => { settled = true })
    // 老代码等锁 3 秒后就带着「已取消修复，正在停止连接」返回,而断开意图根本没写、通道还在连。
    // 给足超过 3 秒:取消的收尾必须已经补上断开意图(守护随即真停),⛔ 提前交回一句没做的事。
    await sleep(3_500)
    expect(f.intent().desired).toBe('user-disconnected')
    expect(f.service.repairStatus()).toMatchObject({ outcome: 'cancelled' })
    expect(settled).toBe(false) // 还没撒谎也没交差:在等锁,准备把断开做完
    release!()
    expect(await stopping).toMatchObject({ outcome: 'stopped', message: '已断开,原设置恢复中' })
    expect(f.intent().desired).toBe('user-disconnected')
    // 通道真的停了:状态离开已连/连接中,守护按用户断开收尾,⛔ 强杀
    await waitFor(() => ['用户主动断开', '已停止并恢复原设置'].includes(f.service.status().state), 10_000)
    expect(f.children).toHaveLength(childrenBeforeStop)
  } finally {
    release?.()
  }
}, 30_000)

it('锁正常释放时取消修复照常真的停止(防止改成「永远停不了」)', async () => {
  const f = await setup()
  await reachConnectingPhase(f)
  const childrenBeforeStop = f.children.length
  expect(await f.service.stop()).toMatchObject({ outcome: 'stopped', message: '已断开,原设置恢复中' })
  expect(f.intent().desired).toBe('user-disconnected')
  // stop() 与修复视图收尾并发:finish 要等修复自己的下一个轮询 tick,⛔ 拿「还没来得及收尾」当「没取消」
  await waitFor(() => !f.service.repairStatus().running, 15_000)
  expect(f.service.repairStatus()).toMatchObject({ outcome: 'cancelled' })
  await waitFor(() => ['用户主动断开', '已停止并恢复原设置'].includes(f.service.status().state), 10_000)
  expect(f.children).toHaveLength(childrenBeforeStop)
}, 25_000)
