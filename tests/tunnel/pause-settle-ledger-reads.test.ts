// N-25 延伸:停止落定等待循环(ensureResidentDisabledAfterSettle)在账本未结清时逐轮复查
// ledgerFailure / pendingSettingEntries。这两个读在旧实现里是全量读盘解析——循环 100ms 一轮、
// 预算 45s~15min,客户断开后主进程会对着同一份没变的账本重复整读几百上千次。
// 本用例按「真实打开 ledger.json 的次数」度量(记忆化命中时不打开文件):
// 等待期间盘面未变,读盘次数不随轮数增长。未修代码上红(每轮 2 次全量读);
// 换回非缓存读的变异同样红。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 计数只看 ledger.json 的 readFileSync(意图/state 等其余读取与本用例无关)。
const control = vi.hoisted(() => ({ ledgerReads: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const countingReadFileSync = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.endsWith('ledger.json')) control.ledgerReads += 1
    return (actual.readFileSync as (path: unknown, ...rest: unknown[]) => unknown)(path, ...rest)
  }
  return { ...actual, readFileSync: countingReadFileSync }
})

import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { makeResidentRuntime, residentSpecFor } from '../../app/main/tunnel/resident-bridge'

const roots: string[] = []
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  control.ledgerReads = 0
})

// 与 pause-resident-disable.test.ts 同形夹具,但账本留 1 条未结算设置账目:
// 落定条件(账本结清)永不满足,等待循环全程空转——这正是要审计的窗口。
function setup(): { dataDir: string; tunnel: TunnelService } {
  const dataDir = mkdtempSync(join(tmpdir(), 'n25-pause-reads-'))
  roots.push(dataDir)
  writeFileSync(join(dataDir, 'ledger.json'), JSON.stringify([{
    id: 'w-fixture-1', kind: 'setting', service: 'networksetup', item: 'webproxy-eth0',
    sessionToken: 'tok-fixture', note: '', status: 'applied',
    originalValue: { enabled: false }, writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
    time: 1
  }]))
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const runtime = makeResidentRuntime({
    dataDir,
    platform: 'windows',
    supported: true,
    probeInstalled: () => false,
    spec: () => residentSpecFor({ executable: '/工具箱', launch: { daemonPath: '/d.mjs', adapterPath: '/a.mjs', env: {} }, dataDir, logDir: '/logs' })
  })
  const tunnel = new TunnelService({
    dataDir, platform: 'windows', sidecarDir, trust: { whitelistDigests: [], signingPublicKeys: [] },
    now: () => Date.now(), picker: async () => undefined,
    spawnDaemon: () => ({ on: () => undefined }), spawnRestore: () => undefined,
    routesFile: join(sidecarDir, 'routes.default.json'), resident: runtime.bridge
  })
  return { dataDir, tunnel }
}

describe('停止落定等待循环的账本读取节奏', () => {
  it('账本未结清时空转多轮,ledger.json 读盘次数不随轮数增长', async () => {
    vi.useFakeTimers()
    const { tunnel } = setup()
    // stop() 返回前,落定等待已同步起跑(预算计算 + 首轮复查);从这里起度量循环本体。
    expect((await tunnel.stop()).outcome).toBe('stopped')
    const readsAtStart = control.ledgerReads
    // 2 秒窗口:修后 200ms 一轮 = 10 轮;旧实现 100ms 一轮 = 20 轮 × 每轮 2 次全量读 = 40 次。
    await vi.advanceTimersByTimeAsync(2_000)
    const delta = control.ledgerReads - readsAtStart
    // 首轮冷读至多 1 次(两个缓存读共用一次解析),其后盘面未变必须全部命中缓存、不再打开文件。
    expect(delta).toBeLessThanOrEqual(1)
    // 推过预算(1 条 × 30s + 45s 基础),等待循环收尾退出,不留悬挂定时器。
    await vi.advanceTimersByTimeAsync(80_000)
  })
})
