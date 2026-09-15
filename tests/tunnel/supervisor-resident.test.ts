// 常驻接入(主进程侧,0.5.0):常驻模式下守护由系统承载,主进程 ⛔ 自己 spawn,
// 只在「客户点了连接而守护不在」时叫醒它;连着叫不醒则把系统代理还给客户(与 spawn 路径同一个出口)。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonSupervisor, RESIDENT_WAKE_BACKOFF_MS, type ResidentBridge } from '../../app/main/tunnel/supervisor'

interface FakeChild {
  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): void
}

function makeChild() {
  const listeners: Array<(code: number | null, signal: string | null) => void> = []
  return {
    child: { on: (event: string, cb: (code: number | null, signal: string | null) => void) => { if (event === 'exit') listeners.push(cb) } } as unknown as FakeChild,
    die: () => { for (const listener of listeners.splice(0)) listener(null, 'SIGKILL') }
  }
}

/** 可编排的常驻:叫醒次数、席位是否有活人都由用例说了算。 */
function makeResident(options: { active?: boolean; alive?: boolean; wakeSucceeds?: boolean } = {}) {
  const state = { active: options.active ?? true, alive: options.alive ?? false }
  let wakes = 0
  const bridge: ResidentBridge = {
    armed: () => state.active,
    alive: () => state.alive,
    wake: async () => {
      wakes += 1
      // 「叫醒就起来」的常驻:叫过之后席位上就有活人了。
      if (options.wakeSucceeds === true) state.alive = true
      return options.wakeSucceeds ?? false
    }
  }
  return { bridge, state, wakes: () => wakes }
}

function makeHarness(resident?: ResidentBridge) {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-resident-'))
  const spawned: Array<{ child: FakeChild; die: () => void }> = []
  let restoreSpawned = 0
  const waits: number[] = []
  const supervisor = new DaemonSupervisor({
    dataDir: root,
    spawnDaemon: () => { const made = makeChild(); spawned.push(made); return made.child },
    spawnRestore: () => { restoreSpawned += 1; return undefined },
    resident,
    // 用例里不真等:记下等了多久,立刻返回。
    wait: async (ms) => { waits.push(ms) }
  })
  return {
    supervisor, spawned, waits, root,
    restoreSpawned: () => restoreSpawned,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

/** 叫醒周期是异步的:让出事件循环直到它跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

describe('常驻接入 · 主进程侧', () => {
  it('不给常驻接线时一行行为都不变:照旧自己 spawn', () => {
    const h = makeHarness()
    h.supervisor.ensureRunning()
    expect(h.spawned.length).toBe(1)
    expect(h.supervisor.isRunning()).toBe(true)
    h.cleanup()
  })

  it('常驻模式下 ⛔ 自己 spawn——守护不在时改为叫醒', async () => {
    const resident = makeResident({ alive: false, wakeSucceeds: true })
    const h = makeHarness(resident.bridge)
    h.supervisor.ensureRunning()
    await settle()
    // 正向证据:确实叫过一次(⛔ 只断言「没 spawn」——一件都没做也长这样)
    expect(resident.wakes()).toBe(1)
    expect(h.spawned.length).toBe(0)
    expect(h.supervisor.isRunning()).toBe(true)
    h.cleanup()
  })

  it('常驻守护已经在跑:既不 spawn 也不叫,⛔ 把它踢下线重来', async () => {
    const resident = makeResident({ alive: true })
    const h = makeHarness(resident.bridge)
    // 正向证据:先证明它确实认得出「在跑」
    expect(h.supervisor.isRunning()).toBe(true)
    h.supervisor.ensureRunning()
    await settle()
    expect(resident.wakes()).toBe(0)
    expect(h.spawned.length).toBe(0)
    h.cleanup()
  })

  it('席位没活人 = 守护不在,哪怕开关开着', () => {
    const resident = makeResident({ active: true, alive: false })
    const h = makeHarness(resident.bridge)
    expect(h.supervisor.isRunning()).toBe(false)
    // 正向证据:同一个 supervisor,席位上有人时说得出 true——否则这条恒假也会绿
    resident.state.alive = true
    expect(h.supervisor.isRunning()).toBe(true)
    h.cleanup()
  })

  it('本轮不归常驻管时 ⛔ 读席位锁:上一任守护没退干净不该让开机接续跳过 spawn', () => {
    // 席位上确实有活人(上一任还没退),但本轮不是常驻承载
    const resident = makeResident({ active: false, alive: true })
    const h = makeHarness(resident.bridge)
    expect(h.supervisor.isRunning()).toBe(false)
    h.supervisor.ensureRunning()
    // 正向证据:走的是 spawn 老路,客户开机连得上
    expect(h.spawned.length).toBe(1)
    h.cleanup()
  })

  it('退避序列为 500ms/2s/5s,最多叫三轮', () => {
    // ⛔ 拿 RESIDENT_WAKE_BACKOFF_MS.length 当下面那条的期望值:期望跟着实现一起变,改成一轮也照绿。
    expect(RESIDENT_WAKE_BACKOFF_MS).toEqual([500, 2_000, 5_000])
  })

  it('连着叫不醒:按退避再叫三轮,仍无活人则把系统代理还给客户并置放弃位', async () => {
    const resident = makeResident({ alive: false, wakeSucceeds: false })
    const h = makeHarness(resident.bridge)
    h.supervisor.ensureRunning()
    await settle()
    expect(resident.wakes()).toBe(3)
    // 这道兜底丢了,客户会撞上「守护起不来 + 代理指死端口 + 界面看不出问题」
    expect(h.restoreSpawned()).toBe(1)
    expect(h.supervisor.surrendered).toBe(true)
    expect(h.supervisor.isRunning()).toBe(false)
    h.cleanup()
  })

  it('叫醒中途客户点了退出:立刻收手,⛔ 把守护叫回来打断客户明示的意愿', async () => {
    const resident = makeResident({ alive: false, wakeSucceeds: false })
    const h = makeHarness(resident.bridge)
    h.supervisor.prepareForShutdown()
    h.supervisor.ensureRunning()
    await settle()
    expect(resident.wakes()).toBe(0)
    expect(h.restoreSpawned()).toBe(0)
    h.cleanup()
  })

  it('叫醒失败但守护其实起来了:以席位为准,⛔ 拿叫醒的返回值当结论', async () => {
    const resident = makeResident({ alive: false, wakeSucceeds: false })
    const h = makeHarness(resident.bridge)
    // wake 报 false,但守护真的抢到了席位
    const original = resident.bridge.wake
    ;(resident.bridge as { wake: () => Promise<boolean> }).wake = async () => {
      const result = await original()
      resident.state.alive = true
      return result
    }
    h.supervisor.ensureRunning()
    await settle()
    expect(resident.wakes()).toBe(1)
    expect(h.supervisor.surrendered).toBe(false)
    expect(h.supervisor.isRunning()).toBe(true)
    h.cleanup()
  })

  it('客户运行中关掉开关:当前这一轮不断,守护退出后才回到 spawn 老路', async () => {
    // 开关开着 + 常驻守护跑着
    const resident = makeResident({ active: true, alive: true })
    const h = makeHarness(resident.bridge)
    h.supervisor.ensureRunning()
    await settle()
    expect(h.supervisor.isRunning()).toBe(true)
    expect(h.spawned.length).toBe(0)

    // 客户把开关拨到关 → 常驻项当场卸掉,但这一轮守护还在跑
    resident.state.active = false
    expect(h.supervisor.isRunning()).toBe(true) // ⛔ 把连着的界面抹成未连接
    expect(h.supervisor.currentState({ state: 'connected', runId: '常驻守护自己发的' })?.state).toBe('connected')

    // 守护退出(客户点断开/关机)→ 下一轮回到 spawn 老路
    resident.state.alive = false
    expect(h.supervisor.isRunning()).toBe(false)
    h.supervisor.ensureRunning()
    expect(h.spawned.length).toBe(1) // 正向证据:确实走了老路,⛔ 只断言「没叫醒」
    expect(resident.wakes()).toBe(0)
    h.cleanup()
  })

  it('常驻连着时状态 ⛔ 被抹成未连接,且 ⛔ 拿主进程的 runId 去比常驻守护的', () => {
    const resident = makeResident({ alive: true })
    const h = makeHarness(resident.bridge)
    // 常驻守护的 runId 是它自己生成的,主进程从来没见过
    const view = h.supervisor.currentState({ state: 'connected', runId: '常驻守护自己发的' })
    expect(view?.state).toBe('connected')
    // 正向证据:守护真的不在时,connected 仍然要被抹掉(否则这条只是恒真)
    resident.state.alive = false
    expect(h.supervisor.currentState({ state: 'connected', runId: '常驻守护自己发的' })).toBeUndefined()
    h.cleanup()
  })

  it('常驻重新连上后异常标记要清掉:⛔ 让「上次异常退出」永远挂在界面上', async () => {
    const resident = makeResident({ alive: false, wakeSucceeds: false })
    const h = makeHarness(resident.bridge)
    h.supervisor.ensureRunning()
    await settle()
    // 正向证据:先证明确实记下了异常(叫不醒三轮之后)
    expect(h.supervisor.lastUnexpectedExitAt({ state: 'error' })).toBeTypeOf('number')
    // 守护回来了、状态连上了 → 标记清掉
    resident.state.alive = true
    expect(h.supervisor.lastUnexpectedExitAt({ state: 'connected', runId: '常驻守护自己发的' })).toBeUndefined()
    h.cleanup()
  })
})
