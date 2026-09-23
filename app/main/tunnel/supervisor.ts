// 守护监管(主进程侧):spawn / 意外退出检测 / 一次性恢复。
// 判据 3②:守护突然退出 → 主进程状态进「异常」并列未恢复项;3③:再启动先处理未恢复项。
import { pendingSettingEntries, pendingSettingEntriesCached, ledgerFailure, ledgerFailureCached } from '../../../sidecar/mac/ledger.mjs'
import { randomUUID } from 'node:crypto'
import { readDaemonState, type DaemonStateView } from './status-service'
import { layout, writeFileAtomic } from './paths'
import { restoreDeadlineMs } from './repair-budget'
import { firstLineOf } from './failure-log'

export interface SpawnedDaemon {
  readonly pid?: number | undefined
  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): void
  once?(event: 'error', callback: (error: Error) => void): void
  /** N-23:deadline 到点杀掉楔死的一次性恢复子进程;真实 ChildProcess 本就带 kill。 */
  kill?(signal?: NodeJS.Signals): unknown
}

/**
 * N-23:一次性恢复子进程的 deadline 保底值。客户在案形态(0.5.11):恢复子进程被杀软拦住 PowerShell
 * 可以无限挂,restoring 永置位,后续恢复全部早退,界面永远「原设置尚未恢复」。给一轮有界机会:
 * 到点杀掉、写明原因(TUNNEL_RESTORE_TIMEOUT),restoring 必须可清。
 * 实际 deadline 按账本条数伸缩(restoreDeadlineMs),账本大时高于此保底——⛔ 固定 60s 杀掉慢机上合法的慢恢复。
 */
export { RESTORE_DEADLINE_FLOOR_MS as RESTORE_DEADLINE_MS } from './repair-budget'

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
  /** 甲-10 补刀:最近一次校准落在「注册被拒、由存量管理员任务承载」上(armed 照答「在」,
   *  但那份任务与本版定义对不上)。supervisor 的叫醒周期耗尽而席位仍空时,据此回落到
   *  主进程自己 spawn——任务拉不起守护,就不会冒出第二份;网络硬标准:⛔ 放弃式处理。 */
  staleCarry?(): boolean
  /** 当前用户无法停用的旧任务仍可能被系统再次调度。叫醒失败时 ⛔ 自起守护，否则会并存两份。 */
  unmanagedStale?(): boolean
  /** N-26 轻暂停:暂停落定后确保常驻任务处于禁用态(win schtasks /change /disable;mac 无需动作)。
   *  操作本身幂等;不给 = 0.5.12 前的接线(无此补手)。 */
  ensureDisabled?(): Promise<boolean>
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
  /** N-23:一次性恢复子进程的 deadline;测试注入短值,生产用 RESTORE_DEADLINE_MS。 */
  readonly restoreDeadlineMs?: number
  /** Phase 1 ④:结构化失败日志(进 <userData>/logs/tunnel-daemon.log,诊断包收录)。
   *  FB-1 的 UNKNOWN 多来自「现件随进程丢失」——意外退出/叫醒耗尽/恢复非正常退,这里留第一现场。 */
  readonly logFailure?: (event: string, detail?: string) => void
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
  private wakingFlag = false
  // 甲-10 补刀:存量承载模式下,一轮叫醒周期确认「叫不醒」后锁存——同一次运行里客户再点连接,
  // 直接自起,⛔ 再耗一轮叫醒(点连接到连上的额外等待就此封顶)。存量承载态消失即清零。
  private staleCarryWakeDead = false

  constructor(private readonly deps: SupervisorDeps) {}

  // 收敛包3·件1:放弃位。置位后状态层显示「网络守护已停止,点连接重试」。
  get surrendered(): boolean {
    return this.surrenderedFlag
  }

  /** 常驻叫醒周期在途(守护不在,正在叫它回来)。状态层据此如实显示「正在接续」——
   *  这个窗口里席位是空的,⛔ 让界面说「已停止/未连接」引客户去点连接(真机实测点了就双守护)。 */
  get waking(): boolean {
    return this.wakingFlag
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
      // 存量承载态消失(重装成功/开关重置):同轮叫不醒的锁存随之清零。
      if (resident.staleCarry?.() !== true) this.staleCarryWakeDead = false
      // 甲-10 补刀:存量任务对不上、且同一轮里已确认叫不醒——⛔ 再走叫醒(白等一轮),
      // 直接自起。此刻任务已证拉不起守护,不会冒出第二份。
      if (resident.staleCarry?.() === true && this.staleCarryWakeDead) {
        this.spawnOwnDaemon()
        return
      }
      // 常驻模式:⛔ 自己 spawn(会和系统拉起的那个抢客户的设置,单实例锁只是兜底不是设计)。
      // 已经在跑就什么都不用做;不在就叫醒它——客户上次点过断开,守护还原后正常退出了,
      // 系统按设计不会拉它,得有人立刻叫,⛔ 等下次登录。
      if (!resident.alive()) this.beginWake()
      return
    }
    this.spawnOwnDaemon()
  }

  /** 主进程自己起一份守护(spawn 老路;含退出检测与退避重启的接线)。 */
  private spawnOwnDaemon(): void {
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
    // 常驻守护不归本进程管,句柄永远是空的:问席位锁。席位上身份对账确认的活人只会是常驻守护
    // (非常驻守护按设计不取实例锁),所以校准完成前也可以放心按常驻轮处理(甲-1)。
    return this.residentActive() && this.deps.resident?.alive() === true
  }

  /** 本轮守护归不归常驻管。⛔ 直接用 armed():客户运行中把开关拨到关会当场卸掉常驻项,
   *  但这一轮常驻守护还在跑(交界约定:关开关不断当前连接)——只看 armed() 会把连着的界面抹成未连接。
   *  校准完成前同理(Windows 开机校准有 ~1 秒延迟,开机接续确定性地抢跑):armed() 还是假的,
   *  但席位锁上身份对账确认的在席守护只会是常驻形态起的——非常驻守护按设计不取实例锁——
   *  认出它按常驻轮处理,⛔ 走 spawn 老路起第二份(双守护并存:界面卡「连接中」/「另一个后台在管理」)。
   *  守护一退出(客户点断开、关机),这两条自然失效,下一轮回到 spawn 老路。 */
  private residentActive(): boolean {
    const resident = this.deps.resident
    if (!resident) return false
    if (resident.armed()) return true
    return resident.alive()
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
    // Phase 1 ④:意外退出正是 FB-1 记 UNKNOWN 的那类现件丢失,先留痕再排重启。
    this.deps.logFailure?.('daemon-unexpected-exit', `attempt=${String(this.restartAttempts + 1)}`)
    if (this.restartAttempts >= DAEMON_RESTART_BACKOFF_MS.length) {
      this.deps.logFailure?.('daemon-restart-surrendered', `attempts=${String(DAEMON_RESTART_BACKOFF_MS.length)}`)
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
    if (this.wakingFlag) return
    this.wakingFlag = true
    void this.wakeCycle().finally(() => { this.wakingFlag = false })
  }

  private async wakeCycle(): Promise<void> {
    const resident = this.deps.resident
    if (!resident) return
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < RESIDENT_WAKE_BACKOFF_MS.length; attempt += 1) {
      // 客户中途点了退出/断开,或一次性恢复接管了:立刻收手,⛔ 把守护叫回来打断客户明示的意愿。
      if (this.quitting || this.restoring !== undefined || !this.residentActive()) return
      // 叫醒失败也要探:kickstart 可能报错而守护其实已经起来了(⛔ 拿返回值当结论)。
      // Phase 1 ④:抛错/被拒都留痕——基线「叫不动就靠下一轮」把 reason 全吞了。
      try { await resident.wake() } catch (error) { this.deps.logFailure?.('wake-error', firstLineOf(error)) }
      if (await this.probeAlive(resident, wait)) {
        this.resetRestartState()
        this.unexpectedExit = undefined
        return
      }
      this.deps.logFailure?.('wake-miss', `attempt=${String(attempt + 1)}`)
      const backoff = RESIDENT_WAKE_BACKOFF_MS[attempt]
      if (attempt < RESIDENT_WAKE_BACKOFF_MS.length - 1) await wait(backoff)
    }
    if (this.quitting || this.restoring !== undefined) return
    // 当前用户无法停用的旧任务仍可能在下一分钟自己启动。即使本轮叫不醒，也 ⛔ 自起守护，
    // 否则将和它争抢网络设置；交回原设置并让客户按设置页的管理员自救处理。
    if (resident.unmanagedStale?.() === true) {
      this.unexpectedExit = { at: Date.now() }
      this.surrenderAndRestore()
      return
    }
    // 甲-10 补刀:存量承载(任务与本版定义对不上)三轮叫不醒 = 它指向的程序不在/属于别的账号,
    // 而系统代理可能还指着死端口。⛔ 置放弃位——「点连接重试」重试的还是只叫醒,永远连不上
    // (违反网络硬标准:点了连接必须连上)。回落到主进程自己 spawn:任务拉不起守护,就不会
    // 冒出第二份;拉得起的场合在上面探席位时早就成功了。锁存后同一次运行里再点连接直接自起。
    if (resident.staleCarry?.() === true) {
      this.deps.logFailure?.('wake-fallback-stale-carry', '存量任务三轮叫不醒,回落主进程自起')
      this.staleCarryWakeDead = true
      this.spawnOwnDaemon()
      return
    }
    // 三轮叫不醒:守护起不来,而系统代理可能还指着它的死端口。把代理还回去并置放弃位,
    // 状态层会显示「网络守护已停止,点连接重试」——⛔ 让客户对着一个看不出问题的界面断网。
    this.deps.logFailure?.('wake-exhausted', `attempts=${String(RESIDENT_WAKE_BACKOFF_MS.length)},放弃并恢复系统代理`)
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
    // N-23:自家常驻守护在席时,恢复归它按意图结算(它先拿写权、逐项还账,界面从账本与状态转呈真实进展)。
    // ⛔ 再派一次性恢复子进程跟它抢:基线写权 0 秒探测失败即退 65,账本没机会被碰,客户看「未完成(进程中断)」永远转圈。
    if (this.isRunning()) return
    if (ledgerFailure(this.deps.dataDir) || pendingSettingEntries(this.deps.dataDir).length > 0) {
      this.watchRestore(this.deps.spawnRestore())
    }
  }

  // 连接动作前的同步恢复通道:等待一次性恢复子进程退出并复核账本与待恢复项。
  async runRecoveryOnce(timeoutMs = 15_000): Promise<boolean> {
    if (this.restoring !== undefined) {
      const deadline = Date.now() + timeoutMs
      // N-25:等待类轮询放宽到 200ms(循环本身只看内存位,无 IO);
      // 退出复核按规划增补走记忆化账本读——恢复子进程改写账本后 mtime 变化,拿到的必是新账。
      while (this.restoring !== undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return this.restoring === undefined && !ledgerFailureCached(this.deps.dataDir) &&
        pendingSettingEntriesCached(this.deps.dataDir).length === 0
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
    let settled = false
    // deadline 与修复预算同源伸缩(N-23):慢机上一轮合法的恢复就要 2-5 分钟,固定 60s 会把它
    // 拦腰杀掉——那正是「把进行中说成失败」的翻版。按账本待结算条数放大,60s 保底。
    // 条数读不出来(损坏账本正是恢复要处理的现场,读数会抛)就按 0 条取保底——⛔ 让 deadline 计算把恢复路径本身炸掉。
    let deadlineCount: number
    try { deadlineCount = pendingSettingEntries(this.deps.dataDir).length } catch { deadlineCount = 0 }
    const deadlineMs = this.deps.restoreDeadlineMs ?? restoreDeadlineMs(deadlineCount)
    const done = (code: number | null, failure?: { code: string; message: string }) => {
      if (settled || this.restoring !== child) return
      settled = true
      clearTimeout(timer)
      this.restoring = undefined
      // 失败必须有名字(N-23 三条静默分支的教训):写权被占/启动失败/超时各有独立码落 state.json,
      // ⛔ done(null) 吞掉 spawn error 让界面永远停在「进程中断」。席位上有活守护时 ⛔ 盖它的状态。
      if (failure !== undefined) {
        this.deps.logFailure?.('restore-failed', failure.code)
        this.recordRestoreFailure(failure)
      } else if (code !== 0) {
        // 恢复子命令自己的退出码(65=未结算/写权被占):state.json 由子命令写过,这里补一行现场。
        this.deps.logFailure?.('restore-exit', `exit=${String(code)}`)
      }
      // 一次性恢复也可清理旧崩溃；否则新权益的配置替换会永远被旧异常挡住。
      const complete = failure === undefined && code === 0 && !ledgerFailure(this.deps.dataDir) &&
        pendingSettingEntries(this.deps.dataDir).length === 0 &&
        readDaemonState(this.deps.dataDir)?.state === 'stopped-restored'
      if (complete) this.unexpectedExit = undefined
      for (const watcher of this.restoreWatchers.splice(0)) watcher(complete)
    }
    const timer = setTimeout(() => {
      try { child.kill?.('SIGKILL') } catch { /* 杀不掉也不改「这轮没跑完」的事实 */ }
      done(null, { code: 'TUNNEL_RESTORE_TIMEOUT',
        message: '恢复原设置的操作没能在限定时间内完成，已中止这一轮。请再点一次「重试恢复原设置」；电脑很卡时请等它跑完，不要连续点击' })
    }, deadlineMs)
    child.on('exit', (code) => done(code))
    child.once?.('error', () => done(null, { code: 'TUNNEL_RESTORE_SPAWN_FAILED',
      message: '恢复程序未能启动，原设置还没有恢复。请再点一次「重试恢复原设置」；仍不行请重启电脑后重试' }))
  }

  /** 一次性恢复的失败结论落 state.json(带原因);席位有活守护或守护正带着活跃状态时不覆盖。 */
  private recordRestoreFailure(failure: { code: string; message: string }): void {
    if (this.isRunning()) {
      this.deps.logFailure?.('restore-failure-suppressed', `${failure.code} 席位有活守护,不覆盖`)
      return
    }
    const current = readDaemonState(this.deps.dataDir)
    if (current !== undefined && ['connected', 'connecting', 'degraded'].includes(current.state)) {
      this.deps.logFailure?.('restore-failure-suppressed', `${failure.code} 守护带着活跃状态,不覆盖`)
      return
    }
    try {
      writeFileAtomic(layout.state(this.deps.dataDir), `${JSON.stringify({
        state: 'error', code: failure.code, message: failure.message, updatedAt: Date.now()
      })}\n`)
    } catch { /* 状态写不进也不改「这一轮没跑完」的事实;账本与修复流程仍在 */ }
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
