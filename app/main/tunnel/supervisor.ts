// 守护监管(主进程侧):spawn / 意外退出检测 / 一次性恢复。
// 判据 3②:守护突然退出 → 主进程状态进「异常」并列未恢复项;3③:再启动先处理未恢复项。
import { pendingSettingEntries, ledgerFailure } from '../../../sidecar/mac/ledger.mjs'
import { randomUUID } from 'node:crypto'
import { readDaemonState, type DaemonStateView } from './status-service'

export interface SpawnedDaemon {
  readonly pid?: number | undefined
  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): void
  once?(event: 'error', callback: (error: Error) => void): void
}

// 收敛包3·件1:守护非预期退出后按此序列有限重启;三次都失败则放弃并恢复系统代理。
export const DAEMON_RESTART_BACKOFF_MS = Object.freeze([2_000, 10_000, 30_000])

// 常驻模式下重启归系统管(LaunchAgent KeepAlive / 计划任务 RestartOnFailure),主进程 ⛔ 抢这个活;
// 主进程只负责「客户点了连接、而守护此刻不在」时把它叫起来。叫不醒时按此序列再叫,仍无活人则放弃并还原——
// 这是 spawn 路径 surrenderAndRestore 的等价物,丢了它客户会撞上「守护起不来 + 代理指死端口 + 界面看不出问题」。
export const RESIDENT_WAKE_BACKOFF_MS = Object.freeze([500, 2_000, 5_000])
/** 每次叫醒后等守护抢到席位的窗口。launchctl kickstart 立刻返回,守护起来要一点时间。 */
export const RESIDENT_WAKE_PROBE_MS = 3_000

/** 常驻守护没有子进程句柄,主进程只能隔着系统问它。三个问题都由调用方按平台实现。 */
export interface ResidentBridge {
  /** 常驻项此刻装着吗(开关开着 + 系统里确实有那个 LaunchAgent / 计划任务)。
   *  ⛔ 直接拿它当「本轮归不归常驻管」——两者在客户拨开关的那一刻会分岔,见 residentActive()。 */
  armed(): boolean
  /** 叫醒(mac launchctl kickstart / win schtasks /run)。返回 false 只是「这次没叫动」,还要探席位才算数。 */
  wake(): Promise<boolean>
  /** daemon.lock 里的持有者还活着吗——常驻模式下这是「守护在不在」的唯一事实来源。 */
  alive(): boolean
}

// N-07:「恢复在途」专用类型。恢复子进程在途时连接动作拿到的失败,配置完好、本地一时忙;
// 与其他本地故障(磁盘满/数据目录不可写等普通 Error)必须分得开——客户要分清「等恢复」和「写入失败」,
// 回传侧也要分清已知「本地忙」和真正的本地故障,⛔ 混回普通 Error 让磁盘满冒充「正在恢复」。
export class RestoreInProgressError extends Error {
  constructor() {
    super('原设置恢复中，请稍后重试')
    this.name = 'RestoreInProgressError'
  }
}

export interface SupervisorDeps {
  readonly dataDir: string
  readonly spawnDaemon: (runId: string) => SpawnedDaemon
  readonly spawnRestore: () => SpawnedDaemon | void
  // 测试注入;缺省用真实 setTimeout/clearTimeout。
  readonly scheduleRestart?: (fire: () => void, delayMs: number) => unknown
  readonly cancelRestart?: (handle: unknown) => void
  /** 常驻接线;不给 = 老路(主进程自己 spawn),一行行为都不变。 */
  readonly resident?: ResidentBridge
  /** 测试注入;缺省真实等待。 */
  readonly wait?: (ms: number) => Promise<void>
}

export class DaemonSupervisor {
  private daemon: SpawnedDaemon | undefined
  private expectExit = false
  private unexpectedExit: { at: number } | undefined
  private runId = ''
  private restoring: SpawnedDaemon | undefined
  private restoreWatchers: Array<(ok: boolean) => void> = []
  private restartAttempts = 0
  private restartHandle: unknown
  private quitting = false
  private surrenderedFlag = false
  private waking = false
  private residentRound = false

  constructor(private readonly deps: SupervisorDeps) {}

  // 收敛包3·件1:放弃位。置位后状态层显示「网络守护已停止,点连接重试」。
  get surrendered(): boolean {
    return this.surrenderedFlag
  }

  ensureRunning(): void {
    if (this.daemon !== undefined) {
      return
    }
    // 用户显式拉起连接 = 新的一轮:清退避与放弃状态。
    this.resetRestartState()
    if (this.restoring) throw new RestoreInProgressError()
    const resident = this.deps.resident
    if (resident && this.residentActive()) {
      // 常驻模式:⛔ 自己 spawn(会和系统拉起的那个抢客户的设置,单实例锁只是兜底不是设计)。
      // 已经在跑就什么都不用做;不在就叫醒它——客户上次点过断开,守护还原后正常退出了,
      // 系统按设计不会拉它,得有人立刻叫,⛔ 等下次登录。
      this.residentRound = true
      if (!resident.alive()) this.beginWake()
      return
    }
    this.residentRound = false
    this.runId = randomUUID()
    const child = this.deps.spawnDaemon(this.runId)
    this.daemon = child
    const exited = () => {
      if (this.daemon !== child) return
      this.daemon = undefined
      if (!this.expectExit) {
        this.unexpectedExit = { at: Date.now() }
        this.scheduleNextRestart()
      }
      this.expectExit = false
    }
    child.on('exit', exited)
    child.once?.('error', exited)
  }

  isRunning(): boolean {
    if (this.daemon !== undefined) return true
    // 常驻守护不归本进程管,句柄永远是空的:问席位锁。⛔ 无条件读锁——非常驻模式下
    // 主进程刚重启时上一任守护可能还没退干净,那一瞬的「有活人」会让开机接续跳过 spawn,客户开机连不上。
    return this.residentActive() && this.deps.resident?.alive() === true
  }

  /** 本轮守护归不归常驻管。⛔ 直接用 armed():客户运行中把开关拨到关会当场卸掉常驻项,
   *  但这一轮常驻守护还在跑(交界约定:关开关不断当前连接)——只看 armed() 会把连着的界面抹成未连接。
   *  守护一退出(客户点断开、关机),下面这条自然失效,下一轮回到 spawn 老路。 */
  private residentActive(): boolean {
    const resident = this.deps.resident
    if (!resident) return false
    if (resident.armed()) return true
    return this.residentRound && resident.alive()
  }

  isRestoring(): boolean {
    return this.restoring !== undefined
  }

  lastUnexpectedExitAt(state?: DaemonStateView): number | undefined {
    // 常驻守护的 runId 是它自己生成的,主进程不知道,⛔ 拿 this.runId 去比(永远不等,异常标记永远清不掉)。
    const connectedNow = this.residentActive()
      ? state?.state === 'connected' && this.isRunning()
      : this.daemon !== undefined && state?.runId === this.runId && state.state === 'connected'
    if (connectedNow) {
      this.unexpectedExit = undefined
      this.resetRestartState()
    }
    return this.unexpectedExit?.at
  }

  // 退避重启编排(收敛包3·件1):非预期退出 → 2s/10s/30s 各重启一次;
  // 仍退出则放弃:停止重启、派发按账本恢复(把系统代理放回原状),置 surrendered。
  private scheduleNextRestart(): void {
    if (this.surrenderedFlag || this.quitting) return
    if (this.restartAttempts >= DAEMON_RESTART_BACKOFF_MS.length) {
      this.surrenderAndRestore()
      return
    }
    const delayMs = DAEMON_RESTART_BACKOFF_MS[this.restartAttempts]
    this.restartAttempts += 1
    const schedule = this.deps.scheduleRestart ?? ((fire: () => void, ms: number) => setTimeout(fire, ms))
    this.restartHandle = schedule(() => {
      this.restartHandle = undefined
      if (this.quitting || this.daemon !== undefined || this.restoring !== undefined) return
      this.spawnRestartDaemon()
    }, delayMs)
  }

  private spawnRestartDaemon(): void {
    this.runId = randomUUID()
    const child = this.deps.spawnDaemon(this.runId)
    this.daemon = child
    const exited = () => {
      if (this.daemon !== child) return
      this.daemon = undefined
      if (!this.expectExit) {
        this.unexpectedExit = { at: Date.now() }
        this.scheduleNextRestart()
      }
      this.expectExit = false
    }
    child.on('exit', exited)
    child.once?.('error', exited)
  }

  private surrenderAndRestore(): void {
    this.surrenderedFlag = true
    this.watchRestore(this.deps.spawnRestore())
  }

  // ---- 常驻:叫醒周期 ----
  // 叫一次 → 探席位 → 没起来就退避再叫,三轮都没人则放弃并把系统代理还给客户(与 spawn 路径同一个出口)。
  private beginWake(): void {
    if (this.waking) return
    this.waking = true
    void this.wakeCycle().finally(() => { this.waking = false })
  }

  private async wakeCycle(): Promise<void> {
    const resident = this.deps.resident
    if (!resident) return
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < RESIDENT_WAKE_BACKOFF_MS.length; attempt += 1) {
      // 客户中途点了退出/断开,或一次性恢复接管了:立刻收手,⛔ 把守护叫回来打断客户明示的意愿。
      if (this.quitting || this.restoring !== undefined || !this.residentActive()) return
      // 叫醒失败也要探:kickstart 可能报错而守护其实已经起来了(⛔ 拿返回值当结论)。
      try { await resident.wake() } catch { /* 叫不动就靠下一轮 */ }
      if (await this.probeAlive(resident, wait)) {
        this.resetRestartState()
        this.unexpectedExit = undefined
        return
      }
      const backoff = RESIDENT_WAKE_BACKOFF_MS[attempt]
      if (attempt < RESIDENT_WAKE_BACKOFF_MS.length - 1) await wait(backoff)
    }
    if (this.quitting || this.restoring !== undefined) return
    // 三轮叫不醒:守护起不来,而系统代理可能还指着它的死端口。把代理还回去并置放弃位,
    // 状态层会显示「网络守护已停止,点连接重试」——⛔ 让客户对着一个看不出问题的界面断网。
    this.unexpectedExit = { at: Date.now() }
    this.surrenderAndRestore()
  }

  private async probeAlive(resident: ResidentBridge, wait: (ms: number) => Promise<void>): Promise<boolean> {
    const step = 100
    for (let waited = 0; waited < RESIDENT_WAKE_PROBE_MS; waited += step) {
      if (resident.alive()) return true
      if (this.quitting || this.restoring !== undefined) return false
      await wait(step)
    }
    return resident.alive()
  }

  private resetRestartState(): void {
    this.restartAttempts = 0
    this.surrenderedFlag = false
    if (this.restartHandle !== undefined) {
      const cancel = this.deps.cancelRestart ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      cancel(this.restartHandle)
      this.restartHandle = undefined
    }
  }

  currentState(state: DaemonStateView | undefined): DaemonStateView | undefined {
    // 「守护在不在」走 isRunning(常驻模式下问席位锁),⛔ 只看句柄——否则常驻连着时界面会被抹成未连接。
    if (!this.isRunning() && (state?.state === 'connected' || state?.state === 'connecting')) return undefined
    // runId 比对只在 spawn 模式成立:那时 runId 是本进程发的。常驻守护的 runId 本进程不知道,比了会永远卡「连接中」。
    if (this.daemon && state?.runId && state.runId !== this.runId) return { state: 'connecting' }
    return state
  }

  // 主进程再次启动:先读账本,有未恢复项或损坏标记先按规则处理(判据 3③ 主进程侧;
  // 收敛包3:损坏账本由 restore 子命令执行恢复流程,不再直接放弃)。
  recoverOnBoot(): void {
    if (this.daemon || this.restoring) return
    if (ledgerFailure(this.deps.dataDir) || pendingSettingEntries(this.deps.dataDir).length > 0) {
      this.watchRestore(this.deps.spawnRestore())
    }
  }

  // 连接动作前的同步恢复通道:等待一次性恢复子进程退出并复核账本与待恢复项。
  async runRecoveryOnce(timeoutMs = 15_000): Promise<boolean> {
    if (this.restoring !== undefined) {
      const deadline = Date.now() + timeoutMs
      while (this.restoring !== undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return this.restoring === undefined && !ledgerFailure(this.deps.dataDir) &&
        pendingSettingEntries(this.deps.dataDir).length === 0
    }
    if (!ledgerFailure(this.deps.dataDir) && pendingSettingEntries(this.deps.dataDir).length === 0) return true
    const child = this.deps.spawnRestore()
    if (!child) return false
    const finished = new Promise<boolean>((resolve) => { this.restoreWatchers.push((ok) => resolve(ok)) })
    this.watchRestore(child)
    return finished
  }

  private watchRestore(child: SpawnedDaemon | void): void {
    if (!child) return
    this.restoring = child
    const done = (code: number | null) => {
      if (this.restoring !== child) return
      this.restoring = undefined
      // 一次性恢复也可清理旧崩溃；否则新权益的配置替换会永远被旧异常挡住。
      const complete = code === 0 && !ledgerFailure(this.deps.dataDir) && pendingSettingEntries(this.deps.dataDir).length === 0 &&
        readDaemonState(this.deps.dataDir)?.state === 'stopped-restored'
      if (complete) this.unexpectedExit = undefined
      for (const watcher of this.restoreWatchers.splice(0)) watcher(complete)
    }
    child.on('exit', (code) => done(code))
    child.once?.('error', () => done(null))
  }

  async waitForExit(timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.daemon || this.restoring) {
      if (Date.now() >= deadline) throw new Error('通道恢复仍在进行，守护将独立完成恢复后退出')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  // 明确退出时停止的退出交接:守护走 intent=shutdown 自行恢复并退出,退出属预期。
  prepareForShutdown(): void {
    // 置位即可让在途的叫醒周期收手(它每轮都查);⛔ 在这里去停常驻守护——
    // 托盘「退出工具箱(断开 AI 网络)」是客户明示的意愿,走的是意图文件那条既有路径。
    this.quitting = true
    if (this.restartHandle !== undefined) {
      const cancel = this.deps.cancelRestart ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      cancel(this.restartHandle)
      this.restartHandle = undefined
    }
    if (this.daemon !== undefined) {
      this.expectExit = true
    }
  }
}
