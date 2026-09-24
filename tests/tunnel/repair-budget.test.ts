// N-23 修复复验预算随工作量伸缩(09-18 晚真机 HUAWEI 钉死的主导分支):
// 三个用户环境变量每个写 30-40s,一轮 restore+apply 全 14 项要 2-5 分钟,而修复复验预算固定 45s+10s——
// 慢机上修复必然超时,客户反复点、反复超时。预算改为「基础 + 账本待结算条数 × 单条上限」,封顶防病态账本。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { TunnelService, repairBudgetMs, REPAIR_BUDGET_BASE_MS, REPAIR_BUDGET_PER_ENTRY_MS, REPAIR_BUDGET_MAX_MS } from '../../app/main/tunnel/tunnel-service'
import { layout } from '../../app/main/tunnel/paths'
import { pendingSettingEntries } from '../../sidecar/mac/ledger.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, makeTempDir, removeTempDir, startFakeUpstream, waitFor, reapDaemons } from './helpers'

it('预算随账本条数伸缩:0 条=基础;条数越多越长;病态账本封顶', () => {
  expect(REPAIR_BUDGET_BASE_MS).toBe(45_000)
  expect(REPAIR_BUDGET_PER_ENTRY_MS).toBe(30_000)
  expect(repairBudgetMs(0)).toBe(REPAIR_BUDGET_BASE_MS)
  // 真机形状:14 项待结算 → 45s + 14×30s = 7 分 45 秒,盖得住实测 2-5 分钟的一轮恢复
  expect(repairBudgetMs(14)).toBe(45_000 + 14 * 30_000)
  expect(repairBudgetMs(14)).toBeGreaterThan(5 * 60_000)
  expect(repairBudgetMs(10_000)).toBe(REPAIR_BUDGET_MAX_MS)
})

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// 接线:runRepair 的预算输入必须是「此刻账本里真正待结算的设置条数」(⛔ 写死 0 或常量)。
it('修复启动时按账本待结算条数取预算(注入记账函数核对输入;正常修复照常 recovered)', async () => {
  const root = makeTempDir('laixin-repair-budget-')
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
  const budgetInputs: number[] = []
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (_dir, runId) => launch('start', runId), spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'),
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.9' },
    repairBudgetMs: (count) => { budgetInputs.push(count); return 45_000 } })
  cleanups.push(async () => {
    await service.stop().catch(() => undefined)
    expect(await reapDaemons(children)).toEqual([])
  })
  await service.importConfig(); await service.applyPending()
  await service.start()
  await waitFor(() => existsSync(layout.state(dataDir)) &&
    JSON.parse(readFileSync(layout.state(dataDir), 'utf8')).state === 'connected' &&
    pendingSettingEntries(dataDir).length > 0, 15_000)
  const pendingBeforeRepair = pendingSettingEntries(dataDir).length

  service.repair()
  await waitFor(() => !service.repairStatus().running, 20_000)
  expect(service.repairStatus().outcome).toBe('recovered')
  // 预算函数被咨询且输入=此刻账本待结算条数(连接状态下账本里是我们写下的账目)
  expect(budgetInputs).toHaveLength(1)
  expect(budgetInputs[0]).toBe(pendingBeforeRepair)
  expect(budgetInputs[0]).toBeGreaterThan(0)
}, 30_000)
