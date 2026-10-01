// wakeCycle 的「客户断开立刻收手」:注释承诺客户中途退出/断开即收手,实现只查
// quitting/restoring/residentActive——客户在叫醒窗口内点断开(意图 user-disconnected)时,
// 周期仍会继续叫醒,把守护叫回来打断客户明示的意愿。可注入 shouldAbortWake 读意图。
// 未修代码上红(shouldAbortWake 被忽略,叫醒照发);变异去检查即红。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonSupervisor, type ResidentBridge, type SpawnedDaemon } from '../../app/main/tunnel/supervisor'

const child = (): SpawnedDaemon => ({ pid: 1, on: () => undefined, once: () => undefined })

function harness(resident: ResidentBridge, shouldAbortWake?: () => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'wake-abort-'))
  const logged: Array<{ event: string; detail: string }> = []
  const supervisor = new DaemonSupervisor({
    dataDir: root,
    spawnDaemon: () => child(),
    spawnRestore: () => child(),
    resident,
    wait: async () => {},
    logFailure: (event: string, detail?: string) => logged.push({ event, detail: detail ?? '' }),
    ...(shouldAbortWake !== undefined ? { shouldAbortWake } : {})
  } as unknown as ConstructorParameters<typeof DaemonSupervisor>[0])
  return { supervisor, root, logged, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 200; index += 1) await Promise.resolve()
}

function residentBridge(wake: () => Promise<boolean>): { resident: ResidentBridge; wakes: { count: number } } {
  const wakes = { count: 0 }
  const resident: ResidentBridge = {
    armed: () => true,
    alive: () => false,
    seatRunId: () => undefined,
    wake: async () => { wakes.count += 1; return wake() }
  }
  return { resident, wakes }
}

describe('叫醒周期的客户断开收手', () => {
  it('叫醒窗口内客户断开:不再发起下一次叫醒,不走到放弃/恢复', async () => {
    let aborted = false
    const { resident, wakes } = residentBridge(async () => {
      // 第一次叫醒已发出后客户点了断开:后续轮次必须在叫醒前收手。
      aborted = true
      return false
    })
    const h = harness(resident, () => aborted)
    h.supervisor.ensureRunning()
    await settle()
    expect(wakes.count).toBe(1) // 第一次已发出;变异(去检查)会继续叫满三轮 → 红
    expect(h.supervisor.surrendered).toBe(false)
    expect(h.supervisor.waking).toBe(false)
    h.cleanup()
  })

  it('等待叫醒时已处于客户断开意图:一次都不叫', async () => {
    const { resident, wakes } = residentBridge(async () => false)
    const h = harness(resident, () => true)
    h.supervisor.ensureRunning()
    await settle()
    expect(wakes.count).toBe(0)
    expect(h.supervisor.surrendered).toBe(false)
    h.cleanup()
  })

  it('未断开时周期照旧:三轮叫醒、耗尽走放弃(行为不变)', async () => {
    const { resident, wakes } = residentBridge(async () => false)
    const h = harness(resident, () => false)
    h.supervisor.ensureRunning()
    await settle()
    expect(wakes.count).toBe(3)
    expect(h.supervisor.surrendered).toBe(true)
    h.cleanup()
  })
})
