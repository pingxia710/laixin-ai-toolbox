import { describe, expect, it } from 'vitest'
import type * as LedgerModule from '../../sidecar/shared/ledger.mjs'

// 身份对账本身已有 tests/tunnel/lock-holder-identity.test.ts 守着(路人顶用当场判死)。
// 这里守的是**另一件事**:启动时刻的记忆到底有没有挡住探测。
// 2026-09-16 实测缺陷:TTL 5 秒与主进程状态轮询 5 秒完全相等,每次轮询缓存刚好过期,
// 挡掉 0% —— Windows 上每 5 秒同步起一次 PowerShell,稳态下 20 次点击 8 次超过 1 秒、
// 一次 12 秒无响应,打开窗口从 1.8 秒拖到 15.4 秒。缓存在那之前没有任何用例守着。
type Ledger = typeof LedgerModule
const ledgerUrl = new URL('../../sidecar/shared/ledger.mjs', import.meta.url).href
// 缓存是模块级的,**每条用例必须独立实例** —— 共用会让上一条的时间戳污染下一条。
const freshLedger = async (): Promise<Ledger> => await import(`${ledgerUrl}?case=${String(Math.random())}`) as Ledger

describe('启动时刻记忆', () => {
  it('主进程 5 秒轮询节奏下必须挡住绝大多数探测', async () => {
    const ledger = await freshLedger()
    const record = { pid: process.pid, startedAt: ledger.currentProcessStartedAt(), at: Date.now() }
    let reads = 0
    let clock = Date.now()
    for (let t = 0; t < 600_000; t += 5_000) {
      clock = Date.now() + t
      ledger.lockHolderAlive(record, { now: () => clock, readStartedAt: () => { reads++; return record.startedAt } })
    }
    // 10 分钟 120 次调用。TTL 若退回 5 秒(与轮询周期相等)这里是 120 —— 等于没有缓存。
    expect(reads).toBeLessThanOrEqual(25)
    expect(reads).toBeGreaterThan(0)   // ⛔ 走到「一次都不读」——那是另一种坏法
  })

  it('首次询问仍然当场读、当场判,⛔ 先答保守值', async () => {
    const ledger = await freshLedger()
    const record = { pid: process.pid, startedAt: ledger.currentProcessStartedAt(), at: Date.now() }
    // 路人顶了这个 PID:启动时刻对不上,**第一次问就要判死**
    const answer = ledger.lockHolderAlive(record, { readStartedAt: () => record.startedAt - 600_000 })
    expect(answer).toBe(false)
  })

  it('读不出身份时保守按「在」,⛔ 朝「踢掉活守护」那个方向错', async () => {
    const ledger = await freshLedger()
    const record = { pid: process.pid, startedAt: ledger.currentProcessStartedAt(), at: Date.now() }
    // PID 刚消失前的窗口、系统不支持查询 —— 读不出来。误判成「不在」会把活着的守护踢掉,
    // 那比多等一轮糟得多,所以必须朝「在」错。
    expect(ledger.lockHolderAlive(record, { readStartedAt: () => undefined })).toBe(true)
  })
})
