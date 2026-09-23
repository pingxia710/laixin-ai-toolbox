// N-23 主导分支端到端(09-18 晚真机 HUAWEI 钉死):慢机上每个设置写 30-40s,一轮恢复 2-5 分钟,
// 而修复复验预算固定 45s+10s——修复必然超时,客户反复点、反复「复验超时」。
// 这里按比例缩小注入慢机节奏(每写 8s × 8 项 = 64s > 55s 旧预算;新预算 45s+8×30s=285s 盖得住)。
// 验收线:同样的慢机节奏,一次修复要么 recovered、要么给「预计还需 X 分钟」的真实说法,⛔ 把进行中说成超时。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, makeTempDir, removeTempDir, startFakeUpstream, reapDaemons } from './helpers'

const SLOW_WRITE_MS = 8_000
const SERVICES = ['Wi-Fi', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7']
const WRITTEN = { enabled: true, host: '127.0.0.1', port: 18080 }

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(options: { repairTimeoutMs?: number } = {}): Promise<{ service: TunnelService; dataDir: string }> {
  const root = makeTempDir('laixin-slow-repair-')
  cleanups.push(() => removeTempDir(root))
  const upstream = await startFakeUpstream()
  cleanups.push(() => upstream.killAll())
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const adapter = fileURLToPath(new URL('./fixtures/slow-adapter.mjs', import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const children: ChildProcess[] = []
  const launch = (command: string, runId = '') => {
    const child = spawn(process.execPath, [join(sidecarDir, 'tunnel-daemon.mjs'), command, '--data-dir', dataDir,
      '--adapter', adapter, '--run-id', runId, '--intent-poll-ms', '30', '--verify-interval-ms', '60000'],
    { env: { ...process.env, ...fakeAdapterEnv(storePath), FAKE_ADAPTER_SERVICES: SERVICES.join(','), SLOW_ADAPTER_WRITE_MS: String(SLOW_WRITE_MS) },
      stdio: 'ignore' })
    children.push(child); return child
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (_dir, runId) => launch('start', runId), spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'),
    // 出口可复验:慢机节奏下修复应当「等得住并修好」,⛔ 用不可达出口把用例变成纯超时演练。
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.9' },
    ...(options.repairTimeoutMs !== undefined ? { repairTimeoutMs: options.repairTimeoutMs } : {}) })
  cleanups.push(async () => {
    // 超时用例收尾时恢复子进程可能仍在途:stop 会如实抛「仍在恢复」,⛔ 让它打断整条清理链
    await service.stop().catch(() => undefined)
    expect(await reapDaemons(children)).toEqual([])
  })
  await service.importConfig(); await service.applyPending()
  // 硬重启现场:上一轮连接写下的 8 项设置还在系统里生效(账本 applied),进程全没了。
  // 假「系统设置」里预置这些值,恢复时每项都要真写一次原值(慢机节奏的载体)。
  const store: Record<string, unknown> = {}
  for (const name of SERVICES) store[`${name}/socks-proxy`] = WRITTEN
  writeFileSync(storePath, `${JSON.stringify(store, null, 1)}\n`)
  writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify(SERVICES.map((name, index) => ({
    id: `slow-${String(index)}`, kind: 'setting', service: name, item: 'socks-proxy',
    originalValue: null, writtenValue: WRITTEN, sessionToken: 'previous-session', time: 1, status: 'applied', note: ''
  })), null, 1)}\n`, { mode: 0o600 })
  return { service, dataDir }
}

const repairDone = (service: TunnelService) => new Promise<{ outcome: string; code: string; message: string }>((resolve) => {
  void service.repair()
  const timer = setInterval(() => {
    const view = service.repairStatus()
    if (!view.running) { clearInterval(timer); resolve(view) }
  }, 100)
})

it('慢机节奏注入:一轮恢复 64s 超过旧固定预算 55s——修复必须等住并最终 recovered(基线:TUNNEL_REPAIR_TIMEOUT)', async () => {
  const { service } = await setup()
  const verdict = await repairDone(service)
  expect(verdict.outcome).toBe('recovered')
  expect(verdict.code).toBe('')
}, 480_000)

it('慢机上若仍超时,文案给「预计还需约 X 分钟」的真实节奏,⛔ 只说「超时」让客户反复点', async () => {
  // 注入 2s 预算强制走超时分支(生产走 repairBudgetMs 伸缩;这条只验超时文案对慢机的诚实)。
  const { service } = await setup({ repairTimeoutMs: 2_000 })
  const verdict = await repairDone(service)
  expect(verdict.code).toBe('TUNNEL_REPAIR_TIMEOUT')
  expect(verdict.message).toContain('仍在恢复原设置')
  expect(verdict.message).toContain('预计还需约')
  expect(verdict.message).toContain('分钟')
}, 240_000)
