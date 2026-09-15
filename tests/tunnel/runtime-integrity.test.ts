import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPending, currentBatchId, readPointer, sweepOrphanBatches, writePendingPointer } from '../../app/main/tunnel/transactions'
import { layout } from '../../app/main/tunnel/paths'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { appendSettingEntry, loadLedger } from '../../sidecar/mac/ledger.mjs'
import { ConnectorError } from '../../sidecar/mac/connectors.mjs'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })
const batchA = '20260908000100-aaaaaaaa'
const batchB = '20260908000200-bbbbbbbb'
function fixture() {
  const root = makeTempDir('toolbox-integrity-')
  roots.push(root)
  const dataDir = join(root, 'device')
  mkdirSync(layout.batchDir(dataDir, batchA), { recursive: true })
  mkdirSync(layout.batchDir(dataDir, batchB), { recursive: true })
  writeFileSync(layout.currentPointer(dataDir), batchA)
  writePendingPointer(dataDir, batchB)
  return { root, dataDir }
}

it('篡改 rollback 不能删除数据目录外文件，应用拒绝且 current 不变', () => {
  const { root, dataDir } = fixture()
  const victim = join(root, 'victim')
  mkdirSync(victim)
  writeFileSync(join(victim, 'marker'), 'keep')
  writeFileSync(layout.rollbackPointer(dataDir), '../../victim')
  expect(applyPending(dataDir).outcome).toBe('rejected')
  expect(readFileSync(join(victim, 'marker'), 'utf8')).toBe('keep')
  expect(currentBatchId(dataDir)).toBe(batchA)
})

it.each(['../escape', '/tmp/escape', '..\\escape', 'bad-id', '20260908000100-aaaaaaaa\nextra'])('拒绝非法指针 %s 并保留批次', (value) => {
  const { dataDir } = fixture()
  writeFileSync(layout.currentPointer(dataDir), value)
  expect(readPointer(layout.currentPointer(dataDir))).toBeUndefined()
  sweepOrphanBatches(dataDir)
  expect(existsSync(layout.batchDir(dataDir, batchA))).toBe(true)
})

it('imports 被换成符号链接时不清理外部目录', () => {
  const root = makeTempDir('toolbox-integrity-link-'); roots.push(root)
  const dataDir = join(root, 'device'); mkdirSync(dataDir)
  const victim = join(root, 'victim'); mkdirSync(victim)
  mkdirSync(join(victim, batchA)); writeFileSync(join(victim, batchA, 'marker'), 'keep')
  symlinkSync(victim, layout.imports(dataDir))
  sweepOrphanBatches(dataDir)
  expect(existsSync(join(victim, batchA, 'marker'))).toBe(true)
})

function corruptLedger(dataDir: string, body = '{broken') {
  const store = join(dataDir, 'fake-system.json')
  const written = { enabled: true, host: '127.0.0.1', port: 18081 }
  appendSettingEntry(dataDir, { service: 'Wi-Fi', item: 'socks-proxy', originalValue: null,
    writtenValue: written, sessionToken: 'sess-test', time: Date.now() })
  writeFileSync(store, JSON.stringify({ 'Wi-Fi/socks-proxy': written }))
  writeFileSync(join(dataDir, 'ledger.json'), body)
  return store
}
const sidecarDir = fileURLToPath(new URL('../../sidecar/mac/', import.meta.url))
const adapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
it('坏账本经真实 start/restore/status 报受控错误，重启不变成空账本，原设置不被猜写', () => {
  const { dataDir } = fixture()
  const store = corruptLedger(dataDir)
  const before = readFileSync(store, 'utf8')
  for (const command of ['start', 'restore', 'status', 'start']) {
    const run = spawnSync(process.execPath, [join(sidecarDir, 'tunnel-daemon.mjs'), command,
      '--data-dir', dataDir, '--adapter', adapter], { env: { ...process.env, FAKE_ADAPTER_STORE: store }, encoding: 'utf8', timeout: 5000 })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(65)
    expect(run.stdout + run.stderr).toContain('LEDGER_CORRUPT')
    expect(readFileSync(store, 'utf8')).toBe(before)
  }
  const bad = readdirSync(dataDir).filter((name) => name.startsWith('ledger.json.bad-'))
  expect(bad).toHaveLength(1)
  expect(readFileSync(join(dataDir, bad[0]), 'utf8')).toBe('{broken')
  writeFileSync(join(dataDir, 'ledger.json'), '[]')
  expect(() => loadLedger(dataDir)).toThrow('恢复记录损坏')
})

it.each(['{}', '[null]', '[{"kind":"setting","status":"applied"}]'])('账本结构损坏也拒绝恢复: %s', (body) => {
  const { dataDir } = fixture(); corruptLedger(dataDir, body)
  expect(() => loadLedger(dataDir)).toThrow('恢复记录损坏')
})

it('主进程能带坏账本启动并显示真实故障，连接和应用拒绝', async () => {
  const { dataDir } = fixture(); corruptLedger(dataDir)
  let spawns = 0
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => undefined,
    trust: { whitelistDigests: [], signingPublicKeys: [] }, now: Date.now,
    spawnDaemon: () => { spawns++; return { on: () => undefined } }, spawnRestore: () => { spawns++ },
    routesFile: join(sidecarDir, 'routes.default.json') })
  expect(service.status()).toMatchObject({ state: '异常', canApplyPending: false })
  expect(service.status().unrestored).toContain('恢复记录损坏')
  expect(await service.start()).toMatchObject({ outcome: 'rejected', code: 'LEDGER_CORRUPT' })
  expect((await service.applyPending()).outcome).toBe('rejected')
  // 收敛包3·件4:坏账本不再直接拒绝——启动(recoverOnBoot)与 start 各派一次一次性恢复;
  // 假恢复进程修不好账本,连接仍被 LEDGER_CORRUPT 拒绝,原语义(不静默清砖)不变。
  expect(spawns).toBe(2)
  expect(await service.stop()).toMatchObject({ code: 'LEDGER_CORRUPT' })
  await service.requestShutdown()
})


it.each(['disconnect', 'shutdown', 'parent-exit', 'reconnect', 'reverify'])('连接后账本损坏：%s 停止连接并明确未恢复', async (trigger) => {
  const { dataDir } = fixture()
  const clock = new FakeClock()
  const store = join(dataDir, 'fake-system.json')
  const settings = createAdapter({ FAKE_ADAPTER_STORE: store } as NodeJS.ProcessEnv)
  let lose: ((error: ConnectorError) => void) | undefined
  let stopped = 0; let closed = 0; let exitCode: number | undefined; let parentAlive = true
  writeFileSync(join(dataDir, 'intent.json'), JSON.stringify({ desired: 'connected', connector: { kind: 'loopback-probe' } }))
  const daemon = createDaemon({ random: () => 0, dataDir, clock, adapter: settings,
    connectorFactory: () => ({ kind: 'loopback-probe', start: () => undefined,
      stop: () => { stopped++ }, verify: async () => ({ exitIp: '203.0.113.7' }),
      localProxyPort: () => 18081, onLost: (callback) => { lose = callback } }),
    bridgeFactory: () => ({ listen: () => undefined, close: () => { closed++ } }),
    parentAlive: () => parentAlive, onExit: (code) => { exitCode = code }, intentPollMs: 50, parentPollMs: 50, verifyIntervalMs: trigger === 'reverify' ? 100 : 30000 })
  await daemon.run()
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).state).toBe('connected')
  const before = readFileSync(store, 'utf8')
  writeFileSync(join(dataDir, 'ledger.json'), '{broken')
  if (trigger === 'disconnect') writeFileSync(join(dataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected' }))
  if (trigger === 'shutdown') daemon.requestShutdown()
  if (trigger === 'parent-exit') parentAlive = false
  if (trigger === 'reconnect') lose?.(new ConnectorError('上游不可达', 'local probe'))
  clock.advance(trigger === 'reconnect' ? 2000 : trigger === 'reverify' ? 100 : 50)
  await flushMicrotasks()
  expect(exitCode).toBe(65)
  expect(stopped).toBe(1); expect(closed).toBe(1)
  expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))).toMatchObject({ state: 'error', code: 'LEDGER_CORRUPT' })
  expect(readFileSync(store, 'utf8')).toBe(before)
})
