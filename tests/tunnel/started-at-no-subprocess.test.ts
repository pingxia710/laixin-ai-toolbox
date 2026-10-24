// 甲-1 返工(2026-09-16 真机验收 · 问题 1):Windows 判活的启动时刻探测 ⛔ 起子进程。
//
// 原实现 spawnSync('powershell', …):主进程状态轮询每 5 秒走到一次,PowerShell 冷启动几百毫秒
// 起步、忙时拖满 5 秒超时 —— 真机实测:窗口出现 1.8s → 15.4s,稳态 20 次点击 8 次 >1s、一次 12s 无响应。
// 修复:koffi 直调 kernel32(OpenProcess + GetProcessTimes),同步语义不变(首问仍当场读当场判,
// lock-holder-identity 的「路人顶用当场判死」照旧),但一次子进程都不起。
// 这里用「记录并拒绝一切 spawnSync」的桩顶住 node:child_process,平台按 win32 注入、
// 原生绑定用纯 JS 桩 —— 修复前(win32 分支调 spawnSync)断言当场红。
import { describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import type * as LedgerModule from '../../sidecar/shared/ledger.mjs'

const { spawnSyncCalls } = vi.hoisted(() => ({ spawnSyncCalls: [] as unknown[][] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof ChildProcess
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      spawnSyncCalls.push(args)
      return { status: 1, stdout: '', stderr: '' }
    }
  }
})

// Windows 现在时刻对应的 FILETIME(lo/hi 两个 32 位,100ns since 1601)。BigInt 精确折算,取整毫秒。
function filetimeForEpochMs(epochMs: number): { lo: number; hi: number } {
  const hundredNs = (BigInt(epochMs) + 11_644_473_600_000n) * 10_000n
  return { lo: Number(hundredNs & 0xFFFFFFFFn), hi: Number(hundredNs >> 32n) }
}

const ledgerUrl = new URL('../../sidecar/shared/ledger.mjs', import.meta.url).href
type Ledger = typeof LedgerModule
const freshLedger = async (): Promise<Ledger> => await import(ledgerUrl) as Ledger

describe('Windows 启动时刻探测(判活身份对账的数据源)', () => {
  it('⛔ 起子进程:注入的原生绑定当场读出启动时刻,spawnSync 一次都不许调', async () => {
    const ledger = await freshLedger()
    // 一台「该进程 2026-09-16 12:34:56 启动」的机器
    const realStartedAt = Date.UTC(2026, 8, 16, 12, 34, 56)
    const binding = {
      open: (pid: number) => (pid === 4242 ? { handle: 'fake' } : null),
      creationTime: () => filetimeForEpochMs(realStartedAt),
      close: () => undefined
    }
    const startedAt = ledger.readProcessStartedAt(4242, () => 0, { platform: 'win32', windowsBinding: binding })
    expect(startedAt).toBe(realStartedAt) // 身份对账的数据源照常工作(PID 复用防线不回退)
    expect(spawnSyncCalls).toEqual([]) // 修复前:win32 分支 spawnSync('powershell') → 红
  })

  it('进程打不开(崩溃后的 PID 窗口)或 koffi 拿不到 → undefined,⛔ 起子进程顶数', async () => {
    const ledger = await freshLedger()
    // OpenProcess 失败:进程刚好消失/无权打开 → undefined,判活按既有语义保守处理
    const binding = { open: () => null, creationTime: () => undefined, close: () => undefined }
    expect(ledger.readProcessStartedAt(4242, () => 0, { platform: 'win32', windowsBinding: binding })).toBeUndefined()
    // koffi 缺失(非打包/加载失败):同样 undefined —— ⛔ 回退起子进程,那会把卡顿请回主进程路径
    expect(ledger.readProcessStartedAt(4242, () => 0, { platform: 'win32', windowsBinding: null })).toBeUndefined()
    expect(spawnSyncCalls).toEqual([])
  })

  it('FILETIME → Unix 毫秒换算:整毫秒样本往返一致;字段不齐如实 undefined', async () => {
    const ledger = await freshLedger()
    const epochMs = Date.UTC(2026, 8, 16, 12, 34, 56, 789)
    expect(ledger.filetimeToEpochMs(filetimeForEpochMs(epochMs))).toBe(epochMs)
    expect(ledger.filetimeToEpochMs(undefined)).toBeUndefined()
    expect(ledger.filetimeToEpochMs({ lo: 1 })).toBeUndefined()
  })
})
