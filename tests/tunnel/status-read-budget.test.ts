// N-25 计数用例:通道操作与恢复等待期的主进程 IO 风暴。
// 现行实现(53ab07c 复核):等待循环 50ms×每轮两次 rawStatus() 全量重读——5 秒切换窗口
// 约 200 次 rawStatus(每轮 state.json/manifest/traffic.json 全量读 + 22 次 existsSync),
// status() 同一表达式两读 readCurrentInfo。杀软慢机上表现为主进程每秒近千次同步 IO。
// 修法(只动「怎么读」):①等待条件单次求值+轮询放宽 200ms;②状态读 mtime+size 记忆化
// (loadLedgerCached 同模式);③missingSidecarComponents 进程内缓存;④status() 透传已读结果。
// 判据(规划增补):等待窗口内状态读/syscall 频率降到现行 1/5 以下——这里钉绝对上限,
// 未修代码上必红,反向变异(去记忆化/回退节奏)同样翻红。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { NetworkAccountError } from '../../app/main/tunnel/account-client'
import type { NetworkAccountAccess } from '../../app/main/tunnel/account-client'
import { currentBatchId } from '../../app/main/tunnel/transactions'
import { layout } from '../../app/main/tunnel/paths'
import { daemonStateDiskReads, daemonStateReadCalls, trafficDiskReads } from '../../app/main/tunnel/status-service'
import { importMetaDiskReads, importMetaReadCalls } from '../../app/main/tunnel/import-meta'
import { sidecarGateProbes } from '../../app/main/tunnel/sidecar-path'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(removeTempDir) })

// 现场:账号 A 的配置已应用,账本留一条未恢复项(状态=异常,等待条件在窗口内保持为假)。
// 切换到账号 B 触发 setAccountAccess 的 5 秒等待循环——与生产的账号切换/断开窗口同构。
function setup() {
  const root = makeTempDir('laixin-n25-budget-')
  roots.push(root)
  const dataDir = join(root, 'data')
  const built = buildPackageEntries({})
  const packageDir = writePackageDir(join(root, 'package'), built)
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
    now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: () => { throw new Error('N-25 计数用例不拉守护') },
    spawnRestore: () => undefined, routesFile: join(sidecarDir, 'routes.default.json') })
  const accessB = {
    client: {
      sameEndpoint: () => false,
      claim: async () => { throw new NetworkAccountError('NETWORK_RESPONSE_INVALID') },
      acknowledge: async () => undefined,
      reportDiagnosis: async () => undefined
    },
    session: { accountId: 'customer-b', accessToken: 'token-b', deviceId: 'device-b' }
  } as unknown as NetworkAccountAccess
  return { service, dataDir, accessB }
}

async function prepareAppliedConfigWithUnrestoredLedger(dataDir: string): Promise<void> {
  const metaPath = join(layout.batchDir(dataDir, currentBatchId(dataDir)!), 'import-meta.json')
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>) : {}
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, accountId: 'customer-a' })}\n`)
  // 未恢复项:守护上一轮写下的系统设置等待恢复——等待类循环的稳定「未达成」条件。
  writeFileSync(join(dataDir, 'ledger.json'), `${JSON.stringify([
    { id: 'n25-0', kind: 'setting', service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: null, writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
      sessionToken: 'previous-session', time: 1, status: 'applied', note: '' }
  ], null, 1)}\n`, { mode: 0o600 })
}

interface ReadBudget { readonly [key: string]: number }

function snapshot(): ReadBudget {
  return {
    daemonStateCalls: daemonStateReadCalls(), daemonStateDisk: daemonStateDiskReads(),
    importMetaCalls: importMetaReadCalls(), importMetaDisk: importMetaDiskReads(),
    trafficDisk: trafficDiskReads(), probes: sidecarGateProbes()
  }
}

function deltas(before: ReadBudget): ReadBudget {
  const after = snapshot()
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key]! - before[key]!]))
}

it('账号切换等待窗口(5 秒)内:状态读 ≤60 次、盘上真实读 ≤8 次、组件探测 ≤40 次', async () => {
  const f = setup()
  expect((await f.service.importConfig()).outcome).toBe('imported')
  expect((await f.service.applyPending()).outcome).toBe('applied')
  await prepareAppliedConfigWithUnrestoredLedger(f.dataDir)
  f.service.status() // 预热:首次解析与缓存填充不计入等待窗口
  const before = snapshot()
  const result = await f.service.setAccountAccess(f.accessB)
  // 流程收尾与现行语义一致(假上游拒绝同步);计数只看读取节奏,不看判定结果。
  expect(result.code).toBe('NETWORK_RESPONSE_INVALID')
  const delta = deltas(before)
  // ①等待条件单次求值+200ms 节奏:5 秒窗口 ≤25 轮(现行 50ms×每轮 1-2 次 = 97 次状态读,红)。
  // 配置读每轮 current+pending 各一次(≤50)加流程收尾零星几读,上限 75(现行约 290,红)。
  expect(delta.daemonStateCalls).toBeLessThanOrEqual(60)
  expect(delta.importMetaCalls).toBeLessThanOrEqual(75)
  // ②mtime 记忆化:窗口内盘面无变化,真实读盘解析应为个位数(现行每轮全量重读)
  expect(delta.daemonStateDisk).toBeLessThanOrEqual(8)
  expect(delta.importMetaDisk).toBeLessThanOrEqual(8)
  expect(delta.trafficDisk).toBeLessThanOrEqual(8)
  // ③组件清单进程内缓存(现行每轮 22 次 existsSync,5 秒约 4400 次)
  expect(delta.probes).toBeLessThanOrEqual(40)
}, 30_000)

it('status() 连续 100 次(盘面无变化):配置读/状态读各 ≤5 次、组件探测 ≤40 次', async () => {
  const f = setup()
  expect((await f.service.importConfig()).outcome).toBe('imported')
  expect((await f.service.applyPending()).outcome).toBe('applied')
  await prepareAppliedConfigWithUnrestoredLedger(f.dataDir)
  const before = snapshot()
  for (let index = 0; index < 100; index += 1) f.service.status()
  const delta = deltas(before)
  // 现行:每次 status() 约 4 次 readCurrentInfo(含 rawStatus 与 computeStatus 各自重读)+1 次
  // readDaemonState+1 次 traffic.json+22 次 existsSync → 100 次调用全部超限(红)。
  // 修后:②记忆化+④透传后,只有首轮各解析一次,其余全是 mtime 命中。
  expect(delta.importMetaDisk).toBeLessThanOrEqual(5)
  expect(delta.daemonStateDisk).toBeLessThanOrEqual(5)
  expect(delta.trafficDisk).toBeLessThanOrEqual(5)
  expect(delta.probes).toBeLessThanOrEqual(40)
})
