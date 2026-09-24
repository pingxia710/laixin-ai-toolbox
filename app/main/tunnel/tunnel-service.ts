// 通道服务门面:配置、账号领取与连接动作。互斥、状态闸、意图落盘、
// 守护监管、退出交接。renderer 传不进任何路径 / 节点 / 命令。
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateSessionToken, ledgerFailure, ledgerFailureCached, pendingSettingEntries } from '../../../sidecar/mac/ledger.mjs'
import { unrestoredEntriesCached } from '../../../sidecar/mac/restore.mjs'
import { readInstanceLockCached } from '../../../sidecar/shared/instance-lock.mjs'
import { importAccountConfig, commitPickedConfig, readPackageEntries, type ImportOutcome } from './import-service'
import { PackageReject, composeRoutes, packageDigest, sha256Hex, validatePackage, type RouteOverlay } from './package-format'
import { readCurrentInfo, readPendingInfo, type CurrentInfo } from './import-meta'
import { parseTarEntries } from './tar'
import { NetworkAccountError, type AccountConfiguration, type NetworkAccountAccess } from './account-client'
import { CONNECTION_LEASE_MS, verifyConnectionLease, type ConnectionLease } from './connection-lease'
import { DiagnosisReporter, type DiagnosisPayload, type DiagnosisStage } from './diagnosis-reporter'
import { platformForRuntime } from './sidecar-path'
import type { Platform } from '../precheck/software-platform'
import type { FaultNoteId } from '../../shared/fault-log-types'
import { ActionMutex, MUTEX_BUSY_CODE } from './mutex'
import { KNOWN_FAILURE_CODES } from './failure-codes'
import { layout, statSignature, writeFileAtomic } from './paths'
import { applyPending, currentBatchId, pendingBatchId, reconcilePointers, sweepStaging, hasInvalidPointers } from './transactions'
import { TRUST_LINES, type TrustContext } from './trust'
import { missingSidecarComponents, sshBinaryPresent } from './sidecar-path'
import { computeStatus, readDaemonState, readTrafficObservation, type DaemonStateView, type TunnelStatus, DISPLAY_STATES, networkPathReady } from './status-service'
import { DaemonSupervisor, RestoreInProgressError, type ResidentBridge, type SpawnedDaemon } from './supervisor'
import { repairBudgetMs, REPAIR_BUDGET_PER_ENTRY_MS } from './repair-budget'
import { explainRoute as explainRouteForHost, routeUnavailable, type RouteExplanation } from './route-explainer'
import { idleNetworkRepair, type NetworkRepairStatus } from '../../shared/network-repair'

export const DEFAULT_BRIDGE_PORT = 18080

// N-23:修复复验预算随工作量伸缩(依据与常量见 repair-budget.ts;那里也被 supervisor 的恢复
// deadline 共用,⛔ 两侧各造一套节奏)。此处再出口,现有引用面不变。
export { repairBudgetMs, REPAIR_BUDGET_BASE_MS, REPAIR_BUDGET_PER_ENTRY_MS, REPAIR_BUDGET_MAX_MS } from './repair-budget'
/** 入口端口候选:18080 在开发者机器上常被 Tomcat/Jenkins/别的代理占着,占了就换下一个,⛔ 直接报「端口占用」让客户自己找。 */
export const BRIDGE_PORT_CANDIDATES: readonly number[] = Object.freeze([18080, 18180, 18280, 18380, 18480, 0]) // 0 = 兜底任选空闲口(硬标准:点了连接就要连上)
export const DEFAULT_LOCAL_SOCKS_PORT = 18081

// N-24:断开等锁的兜底期限。持锁段都是短事务,正常远快于此;挂死时点断开也要在这个期限内给结果。
const STOP_LOCK_DEADLINE_MS = 10_000

/** 账号模块告诉通道「账号没了」的原因:暂时问不到 / 登录过期(⛔ 当退出);缺省 = 用户明确退出或换账号。 */
export type AccountAccessReason = 'temporary-unavailable' | 'login-expired'

/** 后台明确说「这份权益不能用了」的码;只有这些才断已建立的连接。其余一律按本地有效期继续(创始人 09-13)。 */
const DEFINITIVE_DENIALS: ReadonlySet<string> = new Set(['NETWORK_AUTHORIZATION_UNAVAILABLE', 'NETWORK_NO_APPLICATION', 'NETWORK_APPLICATION_PENDING'])
/** 点连接时后台这几种「问不到/答非所问」不挡客户:本地配置没到期就照连。会话变化、本地忙、要登录都不在列。 */
const BACKEND_TRANSIENT_FAILURES: ReadonlySet<string> = new Set(['NETWORK_SERVICE_UNAVAILABLE', 'NETWORK_RESPONSE_INVALID', 'NETWORK_LEASE_INVALID'])

export interface ActionResult {
  readonly outcome: string
  readonly code: string
  readonly message: string
}

export interface ImportResult extends ActionResult {
  readonly authorizationId: string
  readonly nodeLabel: string
  readonly expiresAt: string
  readonly source: string
  readonly pendingAvailable: boolean
}

export interface TunnelServiceDeps {
  readonly dataDir: string
  // 接收方运行平台;缺省按进程平台推导(开发与测试在 mac 上即 macos)。
  readonly platform?: Platform
  readonly sidecarDir: string
  readonly picker: () => Promise<string | undefined>
  readonly trust: TrustContext
  readonly now: () => number
  readonly spawnDaemon: (dataDir: string, runId?: string) => SpawnedDaemon
  readonly spawnRestore: (dataDir: string) => SpawnedDaemon | void
  readonly routesFile: string // routes.default.json 路径
  // 测试注入；生产从已验证的公司配置选择 SSH 或 VLESS/REALITY。
  readonly connectorOverride?: Record<string, unknown>
  /** D3:留一条故障经过(⛔ 正文)。缺省即不留痕,测试可注入。 */
  readonly recordFault?: (fault: { readonly network: string; readonly note?: FaultNoteId; readonly noteParams?: readonly string[] }) => void
  /** Phase 1 ④:监管器失败留痕(UNKNOWN 归因);生产写 <userData>/logs/tunnel-daemon.log,测试注入收集。 */
  readonly logFailure?: (event: string, detail?: string) => void
  /** 隔离故障用例可缩短修复等待；不从 renderer 接收。 */
  readonly repairTimeoutMs?: number
  /** 测试注入:预算输入记账(生产走 repairBudgetMs 按账本待结算条数伸缩)。 */
  readonly repairBudgetMs?: (pendingCount: number) => number
  /** 修复超时后等守护确认原设置恢复的宽限（有界）；默认 10 s。 */
  readonly repairRestoreGraceMs?: number
  /** 常驻接线；不给 = 主进程自己带守护的老路，一行行为都不变。 */
  readonly resident?: ResidentBridge
  /** 甲-1:常驻校准落定通知(生产仅安装版给——开发态校准从不发生,给了会让开机接续永远等)。
   *  给了它、常驻还没武装、席位也没人时,开机接续推迟到校准落定后再做:
   *  马上会被常驻任务拉起来的机器上,抢跑 spawn = 两份守护并存。 */
  readonly afterResidentCalibration?: (fn: () => void) => void
  /** FB-1 失败终态回传。不给 = 完全不回传（现有行为零变化）。
   * send 缺省时经当前账号会话直传（与 acknowledgement 同一鉴权）；无会话即放弃，⛔ 冒充已送达。 */
  readonly diagnosis?: {
    readonly enabled: () => boolean
    readonly version: () => string
    readonly send?: (payload: DiagnosisPayload) => Promise<void>
    readonly queuePath?: string
  }
}

const APPLY_ALLOWED_STATES: readonly string[] = [
  DISPLAY_STATES.unconfigured,
  DISPLAY_STATES.stoppedRestored,
  DISPLAY_STATES.userDisconnected
]

/** 修复流程里客户能照做的失败原因；不在表里的码只报「尚不能确认」并留现场。
 *  导出只为让用例能直接钉住「每个码是否真的有可照做的一句」（同 connectionMessage 的先例）。 */
export const REPAIR_REASONS: Record<string, string> = {
  '已有代理控制': '检测到其他代理或 PAC，请先在对应软件中断开代理，再点击检测并修复连接；来信没有覆盖它的设置。',
  '受管理环境': '系统代理受到组织策略或权限限制，请联系设备管理员；不会强行修改系统策略。',
  '端口占用': '来信需要的本机端口被占用，请关闭占用端口的代理软件后重试。',
  '组件缺失': '工具箱网络组件缺失，请安装完整的最新版工具箱后重试。',
  // 主进程的组件闸先于守护，抛的是这个码；不进表客户只会看到文件名清单。
  'TUNNEL_COMPONENT_MISSING': '工具箱网络组件缺失，请安装完整的最新版工具箱后重试。',
  '授权失效': '网络授权已到期，请在我的账号查看流量与有效期；修复不会延长或购买套餐。',
  '配额或授权问题': '网络流量或授权不可用，请在我的账号核对权益。',
  'TUNNEL_SETTINGS_NOT_APPLIED': '本机接入设置没有生效。已停止连接，请关闭其他代理后重试；仍失败请复制诊断给客服。',
  'TUNNEL_RESTORE_INCOMPLETE': '原设置仍未恢复：存在其他软件改动或读写失败。已保留现场，请关闭其他代理或 PAC 后重试；仍不行请复制诊断给客服。',
  // N-23:一次性恢复的受控失败从守护/主进程落盘后,修复流程遇到同样要给客户可照做的一句。
  'TUNNEL_RESTORE_TIMEOUT': '恢复原设置这一轮超时被中止。请再点一次「重试恢复原设置」；电脑很卡时请等它跑完，不要连续点击。',
  'TUNNEL_RESTORE_SPAWN_FAILED': '恢复程序未能启动，原设置还没有恢复。请再点一次「重试恢复原设置」；仍不行请重启电脑后重试。',
  // P0-1 TOP3(7/45):与 status-service instructions 表同一句可照做的话,⛔ 两头各说各的。
  '上游不可达': '通道出口暂时不可达。请检查本机网络后重试；持续失败请换一个网络（如手机热点），仍不行请复制诊断给客服。'
}

// 组件缺失时给客户的一句话:**⛔ 把十几个文件名摊给他看**——他既看不懂也做不了什么,要的是「怎么办」。
// 完整清单留在 status.componentMissing 与桥的诊断里,客服和我们能看到。
// (这条是被 schema 限长逼出来的:清单一变长就把 message 顶过 300 上限,整个动作结果被判非法——
//  但即便没有那个上限,摊一串文件名给客户看本身也是错的。)
export function componentMissingMessage(missing: readonly string[]): string {
  const head = missing.slice(0, 3).join('、')
  const rest = missing.length > 3 ? `等 ${String(missing.length)} 项` : ''
  return `工具箱网络组件缺失（缺 ${head}${rest}），请安装完整的最新版工具箱后重试；仍不行请复制诊断给客服。`
}

// N-25:意图文件的记忆化读(mtime+size 失效,loadLedgerCached 同一模式;⛔ TTL 时间窗)。
// 等待循环与状态映射每轮都问意图,盘面没变就不必全量重读;本进程与测试的写入都走原子替换,
// mtime 必变,缓存自失效。解析失败(缺文件/损坏)按无意图缓存,文件被重写后照常翻新。
const intentCache = new Map<string, { key: string; intent: { desired: string; sessionToken?: string } | undefined }>()

export class TunnelService {
  private readonly mutex = new ActionMutex()
  private readonly supervisor: DaemonSupervisor
  private accountAccess?: NetworkAccountAccess
  private accountRequest?: AbortController
  private accountRequestDone?: Promise<void>
  private accountDenied = false
  // 用户明确退出了账号(⛔ 登录过期/后台问不到):只有这时本地那份账号配置才不许再用。
  private signedOutExplicitly: boolean
  private pausedAccount?: string
  private configCache?: { accountId: string; batchId: string; digest: string; id: string; expiresAt: number; etag: string }
  private connectionLease?: { value: ConnectionLease; token: string; sessionToken: string; monotonicDeadline: number }
  private leaseTimer?: ReturnType<typeof setTimeout>
  private accountTemporary = false
  private acknowledgementPending = false
  private acknowledgedConfiguration = ''
  private repairController?: AbortController
  // FB-3 件二:客户主动断开的次数(stop() 意图入口递增)。start() 以「窗口内计数是否变化」
  // 识别「客户在连接过程中点了断开」,⛔ 把自救记成失败终态回传。
  private userStopSequence = 0
  private repairView: NetworkRepairStatus = { ...idleNetworkRepair }
  // FB-1:失败终态回传。deps.diagnosis 不给就是 undefined,所有挂钩一行都不走。
  private readonly diagnosisReporter?: DiagnosisReporter
  // 同一守护终态只回传一次的账(runId+code);cap 之外整表清空,防长驻进程无界增长。
  private reportedDaemonFailures = new Set<string>()
  // 甲-9 返工:本轮 spawn 发出去的 runId(supervisor 每轮 ensureRunning/退避重启都新发一个)。
  // 常驻轮不 spawn,一直是空串——state.json 错误码的「本轮归属」判据见 daemonStateIsCurrentRound。
  private spawnedDaemonRunId = ''
  // 甲-1 返工:开机接续被推迟到常驻校准落定(Windows 实测等待约 16s)。这扇窗口里:
  //  · 界面必须如实说「正在接续」——席位是空的,⛔ 说「已停止」还摆一个连接按钮(点了就双守护);
  //  · 客户点连接必须并进同一轮(挂到同一个校准落定回调),⛔ 立即 spawn。
  private residentTakeoverWaiting = false

  private readonly platform: Platform

  constructor(private readonly deps: TunnelServiceDeps) {
    this.platform = deps.platform ?? platformForRuntime(process.platform)
    if (deps.diagnosis !== undefined) {
      this.diagnosisReporter = new DiagnosisReporter({
        send: deps.diagnosis.send ?? ((payload) => this.deliverDiagnosis(payload)),
        enabled: deps.diagnosis.enabled,
        platform: this.platform,
        version: deps.diagnosis.version,
        now: deps.now,
        queuePath: deps.diagnosis.queuePath ?? join(deps.dataDir, 'diagnosis-pending.json')
      })
      // 「下次启动补传」:构造即启动时机;此刻多半还没有会话,flush 会原样保留队列。
      void this.diagnosisReporter.flushPending()
    }
    this.signedOutExplicitly = existsSync(join(deps.dataDir, 'account-signed-out'))
    // 任一进程再次启动先读账本 / 收尾指针(判据 3③ 主进程侧)
    reconcilePointers(deps.dataDir)
    sweepStaging(deps.dataDir)
    this.supervisor = new DaemonSupervisor({
      dataDir: deps.dataDir,
      // 记下本轮发给子进程的 runId:state.json 错误码只有带上它才算「本轮写的」(甲-9 返工)。
      spawnDaemon: (runId) => { this.spawnedDaemonRunId = runId; return deps.spawnDaemon(deps.dataDir, runId) },
      spawnRestore: () => deps.spawnRestore(deps.dataDir),
      resident: deps.resident,
      logFailure: deps.logFailure
    })
    const current = readCurrentInfo(deps.dataDir)
    if (current?.accountId && this.shouldResumeOnBoot(current)) {
      // 开机/重开工具箱接续上次连接(创始人 09-13「点连接必连」):上次是连着的(意图 connected,或正常退出时留下的
      // 「下次接着连」标记)且配置未到期 → 重写连接意图、直接拉起守护(守护自己先按账本恢复残留、再连)。
      // 账号模块随后若发现是别的账号或用户已退出,现有逻辑会断开。
      try {
        if (this.intentSnapshot()?.desired !== 'connected') {
          writeFileAtomic(layout.intent(deps.dataDir), `${JSON.stringify(this.composeConnectIntent(current))}\n`)
        }
        this.markResumeOnLaunch(false)
        // 甲-1:校准完成前(Windows 开机校准 ~1 秒后才跑)接续 ⛔ 抢跑起守护:
        // 席位上有在席常驻守护 → supervisor 自己认得,按常驻轮处理(不起第二份);
        // 席位也没人时推迟到校准落定,再决定叫醒还是 spawn——
        // 马上会被常驻任务拉起来的机器上,抢跑 spawn = 两份守护并存。
        const resident = deps.resident
        if (resident !== undefined && deps.afterResidentCalibration !== undefined && !resident.armed() && !resident.alive()) {
          this.residentTakeoverWaiting = true
          deps.afterResidentCalibration(() => this.completeResidentTakeover())
        } else {
          this.supervisor.ensureRunning()
        }
      } catch { this.supervisor.recoverOnBoot() }
    } else if (current?.accountId) this.disconnect()
    else this.supervisor.recoverOnBoot()
  }

  /** 校准落定后的接续补做(开机接续与等待期手动连接共用):落定后走 supervisor 同一套判断——
   *  武装了就叫醒常驻,没武装走 spawn 兜底。等待位在这里清除,⛔ 让「正在接续」显示过站不停。 */
  private completeResidentTakeover(): void {
    this.residentTakeoverWaiting = false
    // 等待期里客户(或断开路径)把意图写成了 user-disconnected:落定后 ⛔ 再把守护拉起来。
    // 意图文件是客户意愿的权威记录,落定时刻它说了算。
    if (this.intentSnapshot()?.desired === 'user-disconnected') return
    try { this.supervisor.ensureRunning() } catch { this.supervisor.recoverOnBoot() }
  }

  /** 连接路径的拉起入口。接续等待期内(常驻校准未落定)⛔ 立即 ensureRunning——此刻 armed、
   *  席位都还是空的,会走 spawn 老路起非常驻守护,随后落定的叫醒再拉常驻 = 双守护(真机实测
   *  TUNNEL_WRITE_RIGHT_HELD)。并进同一轮:挂到同一个校准落定队列,落定后走同一套判断。 */
  private ensureRunningForConnection(): void {
    if (!this.residentTakeoverWaiting || this.deps.afterResidentCalibration === undefined) {
      this.supervisor.ensureRunning()
      return
    }
    this.deps.afterResidentCalibration(() => this.completeResidentTakeover())
  }

  private shouldResumeOnBoot(current: NonNullable<ReturnType<typeof readCurrentInfo>>): boolean {
    if (ledgerFailure(this.deps.dataDir) || hasInvalidPointers(this.deps.dataDir)) return false
    const desired = this.intentSnapshot()?.desired
    // 正常退出工具箱会把意图写成 shutdown(那是给守护的关机命令),客户「下次接着连」的选择另存一个标记。
    const wantsResume = desired === 'connected' || (desired === 'shutdown' && existsSync(this.resumeMarkerPath()))
    if (!wantsResume) return false
    return this.localAuthorizationValid(current) && this.validateStored(current.batchId, false) === undefined
  }

  private resumeMarkerPath(): string { return join(this.deps.dataDir, 'resume-on-launch') }

  // 「下次打开接着连」:只在正常退出且当时连着时记下;用户明确断开/退出账号即清掉。
  private markResumeOnLaunch(resume: boolean): void {
    try {
      if (resume) writeFileAtomic(this.resumeMarkerPath(), `${JSON.stringify({ at: this.deps.now() })}\n`)
      else rmSync(this.resumeMarkerPath(), { force: true })
    } catch { /* 标记失败最多是重开后要手点一次连接 */ }
  }

  /** 本地那份配置在有效期内 = 许可(创始人 09-13):后台只在到期/撤销时才有发言权。 */
  private localAuthorizationValid(current = readCurrentInfo(this.deps.dataDir)): boolean {
    if (!current) return false
    const expiresAt = Date.parse(current.expiresAt)
    return Number.isFinite(expiresAt) && expiresAt > this.deps.now()
  }

  async importConfig(): Promise<ImportResult> {
    if (this.repairController) return rejectedImportBusy()
    // N-22:文件框在锁外。对话框非模态,客户盯着文件框多久,从前互斥锁就被攥多久——期间点
    // 连接/断开/应用全吃「另一个通道操作正在进行」,刚点过「取消修复并断开」的还要进等锁自旋。
    // 真正需要互斥的只有解析与提交;客户取消就不进锁。
    const picked = await this.deps.picker()
    if (picked === undefined) return mapImportOutcome({ outcome: 'cancelled' }, this.status().state)
    // 对话框开着时修复可能已启动(从前沿锁挡住的那扇门现在开着):提交前复核,修复进行中不导入。
    if (this.repairController) return rejectedImportBusy()
    const release = this.mutex.tryAcquire()
    if (release === undefined) {
      return rejectedImportBusy()
    }
    try {
      const outcome = await commitPickedConfig({
        dataDir: this.deps.dataDir,
        trust: this.deps.trust,
        now: this.deps.now,
        runtimePlatform: this.platform,
        sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier]
      }, picked)
      return mapImportOutcome(outcome, this.status().state)
    } finally {
      release()
    }
  }

  // Account module calls this in the main process after normal login/refresh/logout.
  // No session token, URL or account identity can be supplied through IPC.
  async setAccountAccess(access: NetworkAccountAccess | undefined, reason?: AccountAccessReason): Promise<ActionResult> {
    const active = this.accountAccess
    if (access && active && access.session.accountId === active.session.accountId &&
        access.session.accessToken === active.session.accessToken && access.session.deviceId === active.session.deviceId && active.client.sameEndpoint(access.client)) {
      // Periodic account checks must not abort a manual sync of the same authenticated session.
      await this.accountRequestDone
      if (this.accountAccess !== active) return accountFailure('NETWORK_SESSION_CHANGED')
      return this.syncAccountConfig()
    }
    if (this.repairController) {
      this.repairController.abort()
      this.disconnect()
    }
    if (access) this.markSignedOut(false)
    else if (reason === undefined) this.markSignedOut(true)
    // 账号暂时问不到 / 登录过期 ⛔ 拆客户正在用的网络:本地配置没到期就继续(创始人 09-13)。
    // 登录过期时旧会话已作废:先清租约与会话(clearConnectionLease 会顺手把「暂时」位复位,所以放在保留判断之前)。
    if (!access && reason === 'login-expired') { this.clearConnectionLease(); this.accountAccess = undefined }
    if (!access && reason !== undefined && this.retainLocalConnection()) return localContinuation()
    if (!access || !active || access.session.accountId !== active.session.accountId || access.session.accessToken !== active.session.accessToken ||
        !active.client.sameEndpoint(access.client)) this.clearConnectionLease()
    if (!access && reason !== undefined) this.rememberAccountPause()
    else if (!access || this.pausedAccount !== access.session.accountId) this.pausedAccount = undefined
    if (!access && reason === undefined || access && this.configCache?.accountId !== access.session.accountId) this.configCache = undefined
    this.acknowledgementPending = false
    this.acknowledgedConfiguration = ''
    const next = access ? { client: access.client, session: { ...access.session } } : undefined
    this.accountAccess = next
    this.accountDenied = false
    const previousRequest = this.accountRequestDone
    this.accountRequest?.abort()
    const current = readCurrentInfo(this.deps.dataDir)
    if (current?.accountId && current.accountId !== this.accountAccess?.session.accountId) {
      this.disconnect()
      if (access) {
        // N-25:等待条件单次求值(一轮一份状态快照)+等待类轮询放宽到 200ms;判定语义不变——
        // 出口仍是「状态落回可应用集且原设置已恢复」或超时。
        const deadline = Date.now() + 5000
        while (this.accountAccess === next && Date.now() < deadline) {
          const status = this.rawStatus()
          if (APPLY_ALLOWED_STATES.includes(status.state) && !status.unrestored) break
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    }
    await previousRequest
    if (this.accountAccess !== next) return accountFailure('NETWORK_SESSION_CHANGED')
    // 会话就位后先试一轮补传(启动时那轮多半因无会话而保留);失败由 reporter 自己攒住。
    if (access) void this.diagnosisReporter?.flushPending()
    return access ? this.syncAccountConfig() : { outcome: 'stopped', code: '', message: reason !== undefined ? '账号状态暂时无法确认，通道已暂停；确认有效后恢复先前连接' : '已退出账号，账号通道已断开' }
  }

  async syncAccountConfig(): Promise<ActionResult> {
    if (this.repairController) return rejectedBusy()
    return this.syncAccountConfiguration()
  }

  private async syncAccountConfiguration(): Promise<ActionResult> {
    const access = this.accountAccess
    if (!access) return accountFailure('NETWORK_LOGIN_REQUIRED')
    // 串行化守卫:同一时刻只容一个账号同步在途(从前由互斥锁保证)。在途期间的行为与从前一致:
    // 忙拒绝——⛔ 网络移出锁后放两个同步并发在途,各自领套餐、各自写本地状态。
    if (this.accountRequest !== undefined) return rejectedBusy()
    const controller = new AbortController()
    this.accountRequest = controller
    let complete!: () => void
    this.accountRequestDone = new Promise<void>((resolve) => { complete = resolve })
    const assertSession = () => {
      if (this.accountAccess !== access || controller.signal.aborted) throw new NetworkAccountError('NETWORK_SESSION_CHANGED')
    }
    try {
      const cached = this.validConfigCache(access)
      // 网络往返在锁外:后台再慢,互斥锁也只盖住「拿到结果写本地状态」的短窗口。
      // ⛔ 整个往返攥着锁——后台一慢,应用配置/导入配置全吃「另一个通道正在进行」,点什么都没反应;
      // 断开靠中止在途请求自救,其余动作没有这条退路(0.4.x 线上:后台一慢界面像卡死)。
      const config = await access.client.claim(access.session, controller.signal, cached)
      assertSession()
      const release = this.mutex.tryAcquire()
      if (release === undefined) return rejectedBusy()
      try {
        const current = readCurrentInfo(this.deps.dataDir)
        if (config.unchanged) {
          if (!cached || !this.validConfigCache(access)) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
          this.acceptConnectionLease(access, config, current!.configVersion)
          this.accountDenied = false
          await this.resumeAccountConnection(access, assertSession)
          await this.acknowledgeConfiguration(access, controller.signal)
          // 回执会吞掉中止错误(收敛包3·件5):返回前重申会话仍有效,⛔ 盖掉用户的断开。
          assertSession()
          return { outcome: 'unchanged', code: '', message: '账号权益已核验，配置没有变化' }
        }
        const entries = parseTarEntries(config.archive)
        const checked = validatePackage(entries, { now: this.deps.now(), trust: this.deps.trust,
          runtimePlatform: this.platform,
          currentAuthorizationId: config.id, currentVersion: current?.authorizationId === config.id ? current.configVersion : undefined,
          currentPackageDigest: current?.authorizationId === config.id ? this.storedPackageDigest(current) : undefined })
        if (Date.parse(checked.manifest.expiresAt) !== config.expiresAt) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
        if (config.lease && config.etag !== `"${sha256Hex(config.archive)}"`) throw new NetworkAccountError('NETWORK_RESPONSE_INVALID')
        this.acceptConnectionLease(access, config, checked.manifest.configVersion)
        this.accountDenied = false
        if (current?.accountId === access.session.accountId && this.validateStored(current.batchId, false) === undefined &&
            packageDigest(readPackageEntries(layout.batchDir(this.deps.dataDir, current.batchId)).filter((e) => e.path !== 'import-meta.json')) === checked.packageDigest) {
          this.cacheConfiguration(access, config, current.batchId, checked.packageDigest)
          await this.resumeAccountConnection(access, assertSession)
          await this.acknowledgeConfiguration(access, controller.signal)
          return { outcome: 'unchanged', code: '', message: '当前已是这个账号的最新配置' }
        }
        let resume = false
        if (current?.accountId === access.session.accountId) {
          const intentPath = layout.intent(this.deps.dataDir)
          if (existsSync(intentPath)) {
            try { resume = JSON.parse(readFileSync(intentPath, 'utf8')).desired === 'connected' } catch { /* A malformed intent never requests reconnection. */ }
          }
          this.disconnect()
          // N-25:同上——单次求值 + 200ms 等待节奏;assertSession 的会话闸保持每轮一查。
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const status = this.rawStatus()
            if (APPLY_ALLOWED_STATES.includes(status.state) && !status.unrestored) break
            await new Promise((resolve) => setTimeout(resolve, 200)); assertSession()
          }
        }
        const status = this.rawStatus()
        if (!APPLY_ALLOWED_STATES.includes(status.state) || status.unrestored) return accountFailure('NETWORK_DISCONNECT_REQUIRED')
        const imported = await importAccountConfig({ dataDir: this.deps.dataDir, picker: this.deps.picker,
          trust: this.deps.trust, now: this.deps.now, runtimePlatform: this.platform,
          sourceLineOf: (v) => TRUST_LINES[v.trust.tier] }, config.archive,
        { id: access.session.accountId, authorizationId: config.id, expiresAt: config.expiresAt }, assertSession)
        assertSession()
        if (imported.outcome === 'rejected') return { outcome: 'rejected', code: imported.code, message: imported.message }
        const applied = applyPending(this.deps.dataDir)
        if (applied.outcome !== 'applied') return accountFailure('NETWORK_RESPONSE_INVALID')
        this.cacheConfiguration(access, config, readCurrentInfo(this.deps.dataDir)!.batchId, checked.packageDigest)
        await this.acknowledgeConfiguration(access, controller.signal)
        assertSession()
        if (resume) {
          assertSession()
          const intent = this.composeConnectIntent(readCurrentInfo(this.deps.dataDir)!)
          writeFileAtomic(layout.intent(this.deps.dataDir), `${JSON.stringify(intent)}\n`)
          this.ensureRunningForConnection()
          return { outcome: 'applied', code: '', message: '已切换可用权益，正在重新连接' }
        }
        await this.resumeAccountConnection(access, assertSession)
        return { outcome: 'applied', code: '', message: '已自动取得并应用你的来信配置，点击连接即可使用' }
      } finally {
        release()
      }
    } catch (error) {
      // 只有账号侧的错误才算「账号失败」。下面那串动作——清租约、清 pausedAccount/configCache、
      // 置 accountDenied、真的 disconnect()——都是对账号或配置下的判断。
      // 本地故障(恢复在途时 supervisor.ensureRunning() 抛的 RestoreInProgressError,以及其他
      // 本地写入失败)不是账号失败:配置其实完好、后台也已确认没有变化。
      // ⛔ 把它说成「网络配置未通过核验」,更 ⛔ 顺手把通道断掉、把意图翻成 user-disconnected
      // ——暂停态下那等于取消了「权益恢复后自动接续」,客户得手动再点一次连接。
      if (!(error instanceof NetworkAccountError || error instanceof PackageReject)) {
        // N-07:恢复在途是「本地一时忙」;其余本地故障按 N-18 同一判据分开——真写入失败(带 fs
        // 错误码)文案不变;程序错误(TypeError 等)⛔ 说成写入失败指使客户清磁盘/查目录权限,
        // 清完照旧失败(甲-7:同步与连接同判据,客户那侧说一样的话)。
        const localCode = error instanceof RestoreInProgressError ? 'NETWORK_LOCAL_BUSY'
          : isLocalWriteFault(error) ? 'TUNNEL_LOCAL_WRITE_FAILED' : 'TUNNEL_LOCAL_UNEXPECTED'
        return accountFailure(localCode)
      }
      if (this.accountAccess === access && !(error instanceof NetworkAccountError && error.message === 'NETWORK_SESSION_CHANGED')) {
        // 只有后台明确说「不能用了」才断客户的网;后台打不通、回包不对、新包校验不过、登录态 401,
        // 都不是撤销——本地配置没到期就继续用(创始人 09-13:「点连接一定要连上」「前面动不动就死」)。
        const definitive = error instanceof NetworkAccountError && DEFINITIVE_DENIALS.has(error.message)
        if (!definitive && this.retainLocalConnection()) {
          if (error instanceof NetworkAccountError && error.message === 'NETWORK_LOGIN_REQUIRED') this.accountAccess = undefined
          return localContinuation()
        }
        this.clearConnectionLease()
        if (!definitive) this.rememberAccountPause()
        else { this.pausedAccount = undefined; this.configCache = undefined; this.accountDenied = true }
        if (error instanceof NetworkAccountError && error.message === 'NETWORK_LOGIN_REQUIRED') this.accountAccess = undefined
        if (definitive && readCurrentInfo(this.deps.dataDir)?.accountId) this.disconnect()
      }
      return error instanceof PackageReject ? { outcome: 'rejected', code: error.code, message: error.message }
        : accountFailure(error instanceof NetworkAccountError ? error.message : 'NETWORK_RESPONSE_INVALID')
    } finally {
      if (this.accountRequest === controller) this.accountRequest = undefined
      complete()
    }
  }

  async applyPending(): Promise<ActionResult> {
    if (this.repairController) return rejectedBusy()
    return this.applyPendingConfiguration()
  }

  private async applyPendingConfiguration(): Promise<ActionResult> {
    const release = this.mutex.tryAcquire()
    if (release === undefined) {
      return rejectedBusy()
    }
    try {
      const status = this.rawStatus()
      const state = status.state
      if (!APPLY_ALLOWED_STATES.includes(state) || status.unrestored !== '') {
        return {
          outcome: 'rejected',
          code: 'TUNNEL_STATE_NOT_ALLOWED',
          message: `当前状态「${state}」不能应用新配置;断开后应用，并等待原设置恢复`
        }
      }
      const pending = pendingBatchId(this.deps.dataDir)
      if (pending !== undefined) {
        const invalid = this.validateStored(pending, true)
        if (invalid !== undefined) return invalid
      }
      const outcome = applyPending(this.deps.dataDir)
      if (outcome.outcome === 'rejected') {
        return {
          outcome: 'rejected',
          code: outcome.code,
          message: outcome.code === 'TUNNEL_NO_PENDING' ? '没有待用配置' : '待用配置已损坏,请重新导入'
        }
      }
      return { outcome: 'applied', code: '', message: `已应用配置版本 ${this.status().configVersion}，点击「连接」验证线路` }
    } finally {
      release()
    }
  }

  async start(): Promise<ActionResult> {
    if (this.repairController) return rejectedBusy()
    // FB-3 件二:客户在连接过程中点断开是自救,不是「连不上」。判据用用户意图入口
    // (stop() 会写 user-disconnected 意图),全程比对计数;⛔ 靠错误码猜——同一码也可能来自真实账号变化。
    const stopsAtEntry = this.userStopSequence
    try {
      const result = await this.startConnection()
      // FB-1:发起即失败的终态。互斥忙(TUNNEL_BUSY)是「另一个操作在途」不是连不上;
      // cancelled 是客户自己取消——两类 ⛔ 冒充失败终态回传。窗口内客户主动断开同样 ⛔。
      if (result.outcome === 'rejected' && result.code !== '' && result.code !== MUTEX_BUSY_CODE &&
          this.userStopSequence === stopsAtEntry) {
        this.reportFailure(result.code, 'connect-start')
      }
      return result
    } catch (error) {
      // 恢复子进程在途时 supervisor.ensureRunning() 抛的 RestoreInProgressError:配置完好、本地一时忙,
      // 归 NETWORK_LOCAL_BUSY(与 syncAccountConfiguration 同判据)。其余普通 Error 是另一回事:
      // ⛔ 冒充「正在恢复」让客户白等,⛔ 冒充已知「本地忙」污染归因(FB-1)。
      // N-18:再按判据分开「真写入失败」与「非预期程序错误」——程序错误(TypeError 等)⛔ 说成
      // 写入失败指使客户清磁盘/查目录权限,清完照旧连不上;真写入失败(带 fs 错误码)文案不变。
      // ⛔ 漏给桥层兜底成「请重试或重新导入来信配置包」,指使配置完好的客户重新导入(0.4.10 起)。
      // 修复流程(带 signal 的 startConnection)有自己的收尾与归因,不走这条。
      if (!(error instanceof NetworkAccountError || error instanceof PackageReject)) {
        const localCode = error instanceof RestoreInProgressError ? 'NETWORK_LOCAL_BUSY'
          : isLocalWriteFault(error) ? 'TUNNEL_LOCAL_WRITE_FAILED' : 'TUNNEL_LOCAL_UNEXPECTED'
        if (this.userStopSequence === stopsAtEntry) this.reportFailure(localCode, 'connect-start')
        return accountFailure(localCode)
      }
      // NetworkAccountError 的 message 约定是受控码;FB-3 件一:⛔ 盲信——非受控文本由
      // reportFailure 出口统一归 UNKNOWN,机器文本(可能带路径)不上传。
      if (this.userStopSequence === stopsAtEntry) {
        this.reportFailure(error instanceof PackageReject ? error.code : error.message, 'connect-start')
      }
      throw error
    }
  }

  private async startConnection(signal?: AbortSignal, accountChecked = false): Promise<ActionResult> {
    this.pausedAccount = undefined
    const failure = ledgerFailure(this.deps.dataDir)
    if (failure) {
      // 账本损坏不再是单向砖(收敛包3·件4):先走恢复流程,成功即继续;失败才带诊断拒绝。
      const recovered = await this.supervisor.runRecoveryOnce()
      if (!recovered) {
        const still = ledgerFailure(this.deps.dataDir)
        return { outcome: 'rejected', ...(still ?? failure) }
      }
    }
    if (this.rawStatus().unrestored) return { outcome: 'rejected', code: 'TUNNEL_RESTORE_INCOMPLETE', message: '请先恢复原设置，再重新连接' }
    if (hasInvalidPointers(this.deps.dataDir)) return { outcome: 'rejected', code: 'TUNNEL_POINTER_INVALID', message: '配置记录损坏，原配置已保留，请联系客服协助处理' }
    // Account entitlements are checked by server time before every explicit connection.
    // A locally unexpired cached package alone cannot revive an expired/revoked account right.
    const intentBefore = readCurrentInfo(this.deps.dataDir)?.accountId ? this.intentSnapshot() : undefined
    const accountConfig = readCurrentInfo(this.deps.dataDir)
    if (!accountChecked && accountConfig?.accountId && this.accountAccess === undefined) {
      // 账号模块还没核验完(刚启动、离线、后台慢):本地配置没到期就连。只有用户明确退出过才要求先登录。
      if (this.signedOutExplicitly || !this.localAuthorizationValid(accountConfig)) return accountFailure('NETWORK_LOGIN_REQUIRED')
    } else if (!accountChecked && accountConfig?.accountId) {
      const checked = await this.syncAccountConfiguration()
      if (!['applied', 'unchanged', 'continued'].includes(checked.outcome)) {
        // 后台没给出「不能用」的明确答复(打不通/回包不对/本地一时忙)且本地配置没到期 → 照连;
        // 客户点了连接就是要用网,⛔ 因为我们自己的后台抖一下把他挡在外面(创始人 09-13)。
        // 同步时才发现登录过期(401)与账号模块先通知登录过期是同一件事:没明确退出过就按本地配置连。
        const loginLapsed = checked.code === 'NETWORK_LOGIN_REQUIRED' && !this.signedOutExplicitly
        const proceedLocally = (BACKEND_TRANSIENT_FAILURES.has(checked.code) || loginLapsed) && this.localAuthorizationValid(readCurrentInfo(this.deps.dataDir))
        if (!proceedLocally) return checked
        this.accountTemporary = true
      }
      // 收敛包3·件5:网络请求后重新检查用户意图——同步窗口内的断开,⛔ 被迟到的连接流程顶掉。
      if (intentBefore?.desired === 'connected') {
        const after = this.intentSnapshot()
        if (after && after.desired === 'user-disconnected' && after.sessionToken !== intentBefore.sessionToken) {
          return { outcome: 'rejected', code: 'TUNNEL_START_CANCELLED', message: '连接过程中检测到断开操作，已保持断开状态；请重新点击连接' }
        }
      }
    }
    if (signal?.aborted) return { outcome: 'cancelled', code: 'TUNNEL_REPAIR_CANCELLED', message: '已取消修复' }
    // 普通连接可能先在恢复子进程处等待，后来用户才点修复；迟到的普通连接不能插队。
    if (!signal && this.repairController) return rejectedBusy()
    const release = this.mutex.tryAcquire()
    if (release === undefined) {
      return rejectedBusy()
    }
    try {
      // 组件闸:ssh.exe 按需——只有 SSH 稳定版连接才要求;VLESS(升级版)不依赖它。
      // 闸在「未配置」之前:组件真缺时先给响亮的缺失原因,⛔ 让客户猜「没导入配置」。
      const info = readCurrentInfo(this.deps.dataDir) ?? readPendingInfo(this.deps.dataDir)
      const missing = missingSidecarComponents(this.platform, this.deps.sidecarDir, {
        requireSshBinary: info !== undefined && info.protocol !== 'vless-reality'
      })
      if (missing.length > 0) {
        return { outcome: 'rejected', code: 'TUNNEL_COMPONENT_MISSING', message: componentMissingMessage(missing) }
      }
      const current = readCurrentInfo(this.deps.dataDir)
      if (current === undefined) {
        return { outcome: 'rejected', code: 'TUNNEL_NOT_CONFIGURED', message: '尚未导入配置包' }
      }
      const batchId = currentBatchId(this.deps.dataDir)
      if (batchId !== undefined) {
        const invalid = this.validateStored(batchId, false)
        if (invalid !== undefined) return invalid
      }
      const intent = this.composeConnectIntent(current)
      writeFileAtomic(layout.intent(this.deps.dataDir), `${JSON.stringify(intent)}\n`)
      this.ensureRunningForConnection()
      return { outcome: 'started', code: '', message: '连接中' }
    } finally {
      release()
    }
  }

  async stop(): Promise<ActionResult> {
    // FB-3 件二:这里是客户断开的唯一入口(界面断开按钮 → actions/tunnel stop)。
    // 递增计数供 start() 识别「连接过程中客户主动断开」;内部流程的 disconnect() 不经过这里。
    this.userStopSequence += 1
    const repairing = this.repairController !== undefined
    this.repairController?.abort()
    if (repairing) {
      // 修复正在核对配置时持有互斥：先中止它在途的账号请求（让核对立刻收尾），再等它让出互斥，
      // ⛔ 把「另一个通道操作正在进行」红字回给刚点了取消的客户。
      // 锁也可能被别的操作占着：给 10 秒兜底（N-24）。正常情况锁是短事务，等它让出把断开真正做完；
      // 但持锁段一旦挂死，⛔ 永久转圈——到点不抢锁，直接写断开意图（意图写不需要锁），守护按意图真停，
      // 并如实说「不能确认已断开」：要么真停、要么如实说，⛔ 谎称已断开 ⛔ 回 TUNNEL_BUSY 让客户再点。
      this.accountRequest?.abort()
      await this.accountRequestDone
      let freed = false
      const lockDeadline = Date.now() + STOP_LOCK_DEADLINE_MS
      while (!freed) {
        const release = this.mutex.tryAcquire()
        if (release) { release(); freed = true }
        else if (Date.now() >= lockDeadline) {
          this.pausedAccount = undefined
          this.disconnect()
          return { outcome: 'unknown', code: 'TUNNEL_STOP_TIMEOUT',
            message: '已写入断开意图；通道停止确认超时，请重启工具箱后重试' }
        }
        else await new Promise((resolve) => setTimeout(resolve, 200)) // N-25:等待类轮询放宽到 200ms
      }
    }
    const result = await this.stopConnection()
    // N-26 轻暂停:客户断开就是暂停(共用 user-disconnected 意图)。落定后确保常驻任务禁用——
    // 「开机不会自动连接」的主进程侧轻保证;守护自禁(settleResidentTask)仍是主机制,这里是补手。
    if (result.outcome === 'stopped') this.ensureResidentDisabledAfterSettle()
    return result
  }

  /** N-26:暂停落定(意图 user-disconnected 且账本结清)后一次幂等禁用检查。等待有界,预算与恢复
   *  同账(repair-budget,⛔ 两侧另造节奏);没落定就不禁——恢复未完成时常驻任务还承担着崩溃拉回
   *  的职责,提前禁用会让「恢复中崩溃」没人管。禁用失败不影响已落定的断开,⛔ 弹窗打扰客户。 */
  private ensureResidentDisabledAfterSettle(): void {
    const resident = this.deps.resident
    if (resident?.ensureDisabled === undefined) return
    const budgetInput = pendingSettingEntries(this.deps.dataDir).length
    const deadline = Date.now() + (this.deps.repairBudgetMs?.(budgetInput) ?? repairBudgetMs(budgetInput))
    void (async () => {
      while (Date.now() < deadline) {
        if (pendingSettingEntries(this.deps.dataDir).length === 0 && !this.supervisor.isRestoring()) {
          try { await resident.ensureDisabled?.() } catch { /* 已尽力:守护自禁仍是主机制 */ }
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })()
  }

  private async stopConnection(signal?: AbortSignal): Promise<ActionResult> {
    this.pausedAccount = undefined
    this.clearConnectionLease()
    this.accountRequest?.abort()
    await this.accountRequestDone
    if (signal?.aborted) return { outcome: 'cancelled', code: 'TUNNEL_REPAIR_CANCELLED', message: '已取消修复' }
    const release = this.mutex.tryAcquire()
    if (release === undefined) {
      return rejectedBusy()
    }
    try {
      // 用户主动断开:意图持久化到账本与意图文件,守护不拉起、按账本恢复原设置。
      this.disconnect()
      const failure = ledgerFailure(this.deps.dataDir)
      if (failure) return { outcome: 'stopped', ...failure }
      return { outcome: 'stopped', code: '', message: '已断开,原设置恢复中' }
    } finally {
      release()
    }
  }

  /** 常驻接续是否在途:开机接续还在等校准落定,或 supervisor 的叫醒周期正在跑。 */
  private residentTakeoverInFlight(): boolean {
    return this.residentTakeoverWaiting || this.supervisor.waking
  }

  /** 断开意图写下之后，守护恢复原设置需要时间：在宽限内等它确认，再说恢复了 / 失败了 / 还没确认。 */
  private async awaitRestoreVerdict(graceMs: number): Promise<'restored' | 'failed' | 'pending'> {
    const stopToken = this.intentSnapshot()?.sessionToken
    const deadline = Date.now() + graceMs
    while (true) {
      const status = this.rawStatus()
      const daemon = readDaemonState(this.deps.dataDir)
      if (!this.supervisor.isRestoring()) {
        const confirmed = !this.supervisor.isRunning() || daemon !== undefined && daemon.intentToken === stopToken && (daemon.state === 'stopped-restored' || daemon.state === 'error')
        if (confirmed && !status.unrestored) return 'restored'
        if (confirmed && status.unrestored) return 'failed'
      }
      if (Date.now() >= deadline) return 'pending'
      await new Promise((resolve) => setTimeout(resolve, 200)) // N-25:等待类轮询放宽到 200ms
    }
  }

  repairStatus(): NetworkRepairStatus {
    return { ...this.repairView }
  }

  repair(): ActionResult {
    if (this.repairController) return rejectedBusy()
    const release = this.mutex.tryAcquire()
    if (!release) return rejectedBusy()
    release()
    const controller = new AbortController()
    this.repairController = controller
    this.repairView = { running: true, phase: 'restoring', outcome: 'running', code: '',
      message: '正在恢复来信管理的设置；不会覆盖其他软件的代理或 PAC。',
      startedAt: new Date().toISOString(), finishedAt: '' }
    void this.runRepair(controller).catch(() => {
      // 文件不可写等本机异常不允许变成主进程未处理拒绝，也不能谎报已断开或已修复。
      this.repairView = { ...this.repairView, running: false, phase: 'finished', outcome: 'unknown',
        code: 'TUNNEL_REPAIR_LOCAL_FAILURE', message: '本机修复操作未完成，连接状态尚不能确认。请退出工具箱后重开；仍不行请联系来信客服。',
        finishedAt: new Date().toISOString() }
      if (this.repairController === controller) this.repairController = undefined
    })
    return { outcome: 'started', code: '', message: '正在检测并修复连接，可以随时取消。' }
  }

  private async runRepair(controller: AbortController): Promise<void> {
    let timedOut = false
    let stopFailed = false
    const requestStop = () => {
      try { this.pausedAccount = undefined; this.disconnect() }
      catch { stopFailed = true }
    }
    // N-23:预算按此刻账本里真正待结算的条数伸缩(⛔ 固定 45 秒——慢机上一轮恢复就要 2-5 分钟)。
    const budgetInput = pendingSettingEntries(this.deps.dataDir).length
    const budget = this.deps.repairTimeoutMs ?? this.deps.repairBudgetMs?.(budgetInput) ?? repairBudgetMs(budgetInput)
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
      this.accountRequest?.abort()
      requestStop()
    }, budget)
    const check = () => { if (controller.signal.aborted) throw new Error('repair-interrupted') }
    const finish = (outcome: NetworkRepairStatus['outcome'], code: string, message: string) => {
      if (stopFailed) { outcome = 'unknown'; code = 'TUNNEL_REPAIR_LOCAL_FAILURE'; message = '未能写入停止连接指令，无法确认已经断开。请退出工具箱后重开；仍不行请联系来信客服。' }
      this.repairView = { ...this.repairView, running: false, phase: 'finished', outcome, code,
        message: message.slice(0, 300), finishedAt: new Date().toISOString() }
      // FB-1:修复结论「仍然失败」= 客户点了修复还是连不上,是失败终态;'unknown' 是我们不能
      // 确认(不等于失败),cancelled 是客户取消——两类 ⛔ 冒充失败回传。
      if (outcome === 'still_failing' && code !== '') this.reportFailure(code, 'repair')
    }
    const phase = (value: NetworkRepairStatus['phase'], message: string) => {
      check(); this.repairView = { ...this.repairView, phase: value, message }
    }
    const wait = async (ready: () => boolean) => {
      while (true) {
        check()
        if (ready()) return
        await new Promise((resolve) => setTimeout(resolve, 200)) // N-25:等待类轮询放宽到 200ms
      }
    }
    try {
      // 按原账本恢复，不清账、不接管他人设置；等待守护确认本次断开，不能拿旧状态过关。
      await this.stopConnection(controller.signal)
      check()
      const stopToken = this.intentSnapshot()?.sessionToken
      await wait(() => {
        const status = this.rawStatus()
        const daemon = readDaemonState(this.deps.dataDir)
        if (this.supervisor.isRestoring()) return false
        if (status.unrestored) {
          if (!this.supervisor.isRunning() || daemon?.state === 'error' && daemon.intentToken === stopToken) {
            throw Object.assign(new Error('repair-restore-failed'), { repairCode: 'TUNNEL_RESTORE_INCOMPLETE' })
          }
          return false
        }
        if (!this.supervisor.isRunning()) return true
        return daemon?.state === 'stopped-restored' && daemon.intentToken === stopToken
      })
      phase('syncing', '正在核验账号权益与网络配置；不会重新领取或购买套餐。')
      const synced = this.accountAccess ? await this.syncAccountConfiguration()
        : pendingBatchId(this.deps.dataDir) ? await this.applyPendingConfiguration() : undefined
      check()
      if (synced && !['applied', 'unchanged'].includes(synced.outcome)) {
        finish(synced.code === 'NETWORK_SERVICE_UNAVAILABLE' || synced.code === 'NETWORK_LOCAL_BUSY' ? 'unknown' : 'still_failing', synced.code, synced.message)
        return
      }
      phase('connecting', '正在重新连接并验证本机代理与通道出口；这不代表 AI 账号或对话已通过。')
      const started = await this.startConnection(controller.signal, true)
      check()
      // 主进程闸（组件缺失、未导入配置等）不经守护直接返回：文案同样走修复原因表，客户看到可照做的一句。
      if (started.outcome !== 'started') { finish('still_failing', started.code, REPAIR_REASONS[started.code] ?? started.message); return }
      const connectToken = this.intentSnapshot()?.sessionToken
      await wait(() => {
        const daemon = readDaemonState(this.deps.dataDir)
        // sessionToken 只在主进程内部比较，不进入 UI、诊断摘要或故障记录。
        if (!connectToken || daemon?.sessionToken !== connectToken) return false
        // 「有网可用」统一判据:复用电脑上已有外网时没有来信出口 IP 是正常的,⛔ 让这类客户永远修不完
        if (networkPathReady(this.rawStatus())) return true
        if (daemon.state === 'error') throw Object.assign(new Error('repair-connect-failed'), { repairCode: daemon.code })
        return false
      })
      finish('recovered', '', this.rawStatus().pathSource === 'reused'
        ? '网络已可用：正在使用本机原有的外网，未改动系统设置。请重新打开目标 AI，再登录或发一条消息确认。'
        : '已修复并通过本机代理和通道出口复验。请重新打开目标 AI，再登录或发一条消息确认。')
    } catch (error) {
      if (timedOut) {
        // 超时只说明复验没在限期内通过；断开意图刚写下、守护正逐项恢复原设置——⛔ 拿恢复中的账本当「未恢复」下结论
        // （独立验收：慢适配器下曾误报「其他软件改动或权限限制」，3.5 s 后原设置其实已恢复）。等守护确认（有界）再说。
        this.repairView = { ...this.repairView, phase: 'restoring', message: '复验超时，正在恢复原设置并等待确认…' }
        const verdict = await this.awaitRestoreVerdict(this.deps.repairRestoreGraceMs ?? 10_000)
        // N-23:超时文案按账本剩余条数给真实节奏(慢机单条上限),⛔ 在慢机上把「进行中」说成「超时」——
        // 真机实证:客户 4 分钟里连点三次修复全部超时,而守护两分钟后自己恢复完了。
        const remaining = pendingSettingEntries(this.deps.dataDir).length
        const remainingMinutes = Math.max(1, Math.ceil(remaining * REPAIR_BUDGET_PER_ENTRY_MS / 60_000))
        const paceHint = remaining > 0 ? `（还剩 ${String(remaining)} 项，按这台电脑的节奏预计还需约 ${String(remainingMinutes)} 分钟）` : ''
        if (verdict === 'failed') {
          finish('still_failing', 'TUNNEL_RESTORE_INCOMPLETE', '原设置仍未恢复：存在其他软件改动或读写失败。已保留现场，请关闭其他代理或 PAC 后重试；仍不行请复制诊断给客服。')
        } else if (verdict === 'restored') {
          finish('unknown', 'TUNNEL_REPAIR_TIMEOUT', '本次复验超时，尚不能确认恢复；已停止连接并恢复原设置。请检查网络，或换手机热点后重试。')
        } else {
          finish('unknown', 'TUNNEL_REPAIR_TIMEOUT', `本次复验超时；本机仍在恢复原设置${paceHint}，不必反复点击修复。请稍后查看连接状态，或复制诊断给客服。`)
        }
      } else if (controller.signal.aborted) {
        // 取消按钮承诺的是「取消修复并断开」：收尾在这里就补写断开意图，⛔ 依赖 stop() 再补——
        // 锁被长期占用（导入开着文件对话框）时它补不上这一环，通道就还在连（0.4.10 起）。
        // 关机意图（退出工具箱）是更晚、更强的指令，⛔ 被修复的迟到断开覆盖。
        if (this.intentSnapshot()?.desired !== 'shutdown') requestStop()
        finish('cancelled', 'TUNNEL_REPAIR_CANCELLED', '已取消修复，不会继续自动连接；原设置按已有记录恢复。')
      } else {
        const code = (error as { repairCode?: string } | null)?.repairCode
        requestStop()
        finish(code && REPAIR_REASONS[code] ? 'still_failing' : 'unknown', code && REPAIR_REASONS[code] ? code : 'TUNNEL_REPAIR_UNCONFIRMED',
          code && REPAIR_REASONS[code] ? REPAIR_REASONS[code] : '本次修复未能确认恢复，已停止继续连接。请复制诊断给客服，保留现场继续排查。')
      }
    } finally {
      clearTimeout(timeout)
      if (this.repairController === controller) this.repairController = undefined
      if (this.repairView.outcome !== 'cancelled') {
        try { this.deps.recordFault?.({ network: this.repairView.outcome === 'recovered' ? 'AI_DIAG_REPAIR_RECOVERED' : 'AI_DIAG_REPAIR_UNRESOLVED',
          note: this.repairView.outcome === 'recovered' ? 'network_repair_recovered' : 'network_repair_unresolved' }) }
        catch { /* 诊断落盘失败不改变已经复验的连接结论。 */ }
      }
    }
  }

  /** 复用了电脑上现有外网代理时的代理地址(守护写在 state.json);没复用返回 undefined。 */
  reusedProxy(): { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number } | undefined {
    const daemon = readDaemonState(this.deps.dataDir)
    return daemon?.state === 'connected' && daemon.reusedProxy ? daemon.reusedProxy : undefined
  }

  /** 本次实际监听的入口端口(守护写在 state.json;没连上或读不到就是默认值)。终端接入与诊断探针按它来。 */
  activeBridgePort(): number {
    const port = readDaemonState(this.deps.dataDir)?.bridgePort
    return Number.isInteger(port) && port! > 0 && port! <= 65535 ? port! : DEFAULT_BRIDGE_PORT
  }

  status(): TunnelStatus {
    if (this.accountTemporary && !this.localAuthorizationValid()) this.expireLocalContinuation()
    // N-25:一次状态读只碰一次盘——配置信息在这里读一份,一路透传给 rawStatus/computeStatus
    // 与本函数共用(现状是同一表达式读两三次)。
    const currentInfo = readCurrentInfo(this.deps.dataDir)
    const pendingInfo = readPendingInfo(this.deps.dataDir)
    const status = this.rawStatus(currentInfo, pendingInfo)
    // 甲-1 返工:常驻接续等待期(开机接续等校准落定 / supervisor 正在叫醒守护)界面必须如实说
    // 「正在接续」。此刻席位是空的,computeStatus 只能算出「已停止并恢复原设置」——客户照着
    // 旁边的「连接通道」按钮点下去,推迟的叫醒一执行就是双守护(Windows 真机实测)。
    // 用独立的「正在接续」态而不是「连接中」:渲染层给「连接中」的主按钮是「取消连接」,
    // 而这条验收线的要求恰是「等待期内点连接通道仍要并进同一轮、落定后能连上」。
    // 客户明示断开时意图文件是权威,映射闸拦住,⛔ 把「刚取消」说成接续中。
    if (status.state === DISPLAY_STATES.stoppedRestored && this.residentTakeoverInFlight() &&
        this.intentSnapshot()?.desired !== 'user-disconnected') {
      return { ...status, state: DISPLAY_STATES.resuming, message: '正在接续上次的连接，请稍候' }
    }
    if (this.accountTemporary && !status.unrestored) return { ...status,
      message: '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验',
      backend: '后台暂不可达，按本地有效期继续', authorization: '本地配置有效期内，等待重新核验' }
    if (this.pausedAccount && !status.unrestored) return { ...status, state: DISPLAY_STATES.error,
      message: '账号状态暂时无法确认，通道已暂停；有效权益恢复后会接续连接。可点击断开取消自动恢复',
      authorization: '等待重新确认账号权益', backend: '账号校验暂不可用', exitIp: '', lastVerifiedAt: '' }
    const privateToAnotherSession = [currentInfo, pendingInfo]
      .some((info) => info?.accountId && this.configForeignToSession(info.accountId))
    if (!privateToAnotherSession) {
      if (currentInfo?.accountId) return { ...status,
        authorization: '配置由当前登录账号领取，期限以配置为准',
        backend: this.acknowledgementPending ? '配置已应用，设备回执待同步' : '后台：已接入账号配置领取' }
      return status
    }
    const restoring = status.unrestored || [DISPLAY_STATES.connected, DISPLAY_STATES.connecting, DISPLAY_STATES.degraded, DISPLAY_STATES.error].some((state) => state === status.state)
    return { ...status, state: restoring ? DISPLAY_STATES.error : DISPLAY_STATES.unconfigured,
      message: ledgerFailure(this.deps.dataDir)?.message ?? (restoring ? '账号已退出或切换，正在断开原通道；请等待原设置恢复' : '请登录并领取当前账号的网络配置'), source: '', authorization: '',
      backend: '', nodeLabel: '', exitIp: '', lastVerifiedAt: '', configVersion: '', expiresAt: '', pendingAvailable: false,
      currentConfig: '', pendingConfig: '', canApplyPending: false, traffic: '' }
  }

  explainRoute(host: string): RouteExplanation {
    const current = readCurrentInfo(this.deps.dataDir)
    if (!current || this.validateStored(current.batchId, false) !== undefined) return routeUnavailable()
    return explainRouteForHost(host, this.routeTable(current))
  }

  /** D3:上次看到的累计被打断条数,只用来判断「又多了几条」。 */
  private seenInterruptedStreams: number | undefined

  // D3:守护每次结算「通道中断时有几条连接正在回数据」都会把累计值写进 traffic.json。
  // 这里只在它变大时补一条故障记录,客服才看得到「那次是回答到一半断的」。
  // 只写网络码与条数,⛔ 网址、报文与任何正文;记不下来也 ⛔ 影响状态读取。
  private recordInterruptedStreams(): void {
    const observed = readTrafficObservation(this.deps.dataDir)?.interruptedStreams
    if (!Number.isSafeInteger(observed) || observed === undefined) return
    if (this.seenInterruptedStreams === undefined) { this.seenInterruptedStreams = observed; return }
    if (observed <= this.seenInterruptedStreams) {
      this.seenInterruptedStreams = observed // 换了一次连接会从 0 重新数,跟着回落
      return
    }
    // 这一轮新被打断了几条 = 累计值的增量;客服要的是「那次断了几条」⛔ 开机以来的总数。
    const interrupted = observed - this.seenInterruptedStreams
    this.seenInterruptedStreams = observed
    // 网络码 + C8 的说明模板 id 与条数参数。⛔ 网址、报文与任何正文——说明字段是受控枚举,
    // 装不下自由文本;条数也要过 C8 的参数校验(≤15 字符),不合格就只丢这个参数。
    this.deps.recordFault?.({ network: 'AI_DIAG_STREAM_INTERRUPTED', note: 'stream_interrupted', noteParams: [String(interrupted)] })
  }

  // N-25:status() 已读的配置信息可作为入参透传(一次状态读只碰一次盘);其余调用点不传,
  // 照旧自读(记忆化命中,只剩 stat)。
  private rawStatus(preReadCurrent?: CurrentInfo, preReadPending?: CurrentInfo): TunnelStatus {
    this.recordInterruptedStreams()
    const daemonState = readDaemonState(this.deps.dataDir)
    const currentInfo = preReadCurrent ?? readCurrentInfo(this.deps.dataDir)
    const pendingInfo = preReadPending ?? readPendingInfo(this.deps.dataDir)
    // ssh.exe 是按需组件:只有 SSH 稳定版分配才计入缺失;VLESS(升级版)不依赖它。
    const info = currentInfo ?? pendingInfo
    const requireSshBinary = info !== undefined && info.protocol !== 'vless-reality'
    const unexpectedExitAt = this.supervisor.lastUnexpectedExitAt(daemonState)
    const status = computeStatus({
      dataDir: this.deps.dataDir,
      daemonState: this.supervisor.currentState(daemonState),
      daemonUnexpectedExitAt: unexpectedExitAt,
      daemonSurrendered: this.supervisor.surrendered,
      preReadInfo: { current: currentInfo, pending: pendingInfo },
      componentMissing: missingSidecarComponents(this.platform, this.deps.sidecarDir, { requireSshBinary }),
      sshBinary: this.platform === 'windows' ? (sshBinaryPresent(this.platform, this.deps.sidecarDir) ? '有' : '无') : ''
    })
    this.reportDaemonTerminalFailure(daemonState, status.state, unexpectedExitAt)
    return status
  }

  // FB-1:客户「连不上」的异步终态 —— 守护写进 state.json 的 error、异常退出、监管放弃。
  // 只认 display 层确认的异常态,⛔ 把「连接中/待确认」等过程态当失败回传;修复在途时由修复
  // 流程自己上报(同一失败不算两笔)。判不出原因(无码)就如实记 UNKNOWN,⛔ 挑个近似的已知码。
  private reportDaemonTerminalFailure(daemonState: DaemonStateView | undefined, displayState: string, unexpectedExitAt: number | undefined): void {
    if (this.diagnosisReporter === undefined || this.repairController !== undefined) return
    if (displayState !== DISPLAY_STATES.error) return
    let code: string
    // 守护在本轮写下的 state.json error 带精确码的优先取它(甲-9):error 态与随后 exit(65) 并存时,
    // ⛔ 让「意外退出」把精确码掩成 UNKNOWN——那正是 TUNNEL_RESTORE_INCOMPLETE / LEDGER_* 的死法,
    // UNKNOWN 虚高会把「已知原因」误判成「说不出原因」,污染 FB-1 的排期数据。
    // 但 rawStatus 递进来的是没按轮过滤的 state.json:上一轮的 error 会一直躺在盘上,新一轮守护
    // 还没来得及写状态就被杀时,旧码还在 error 态——⛔ 拿它冒充这一轮的死因(甲-9 返工)。
    // 判据见 daemonStateIsCurrentRound:只信本轮写下的码;判不出是陈货还是本轮的,照基线认,
    // 可证是陈货且本轮正有崩溃要归因,就按意外退出如实 UNKNOWN。
    if (daemonState?.state === 'error' && this.daemonStateIsCurrentRound(daemonState)) {
      code = typeof daemonState.code === 'string' && daemonState.code !== '' ? daemonState.code : 'UNKNOWN'
    } else if (unexpectedExitAt !== undefined || this.supervisor.surrendered) {
      code = 'UNKNOWN' // 现场随进程丢失,原因判不出
    } else {
      // 挂钩三源都没命中时,补认显示层正凭以显示「异常」的本地可判源(甲-9):账本损坏/未恢复/配置指针损坏。
      // 守护稳定已连期间不碰账本,账本被外部弄坏由主进程先发现的窗口,三源永远不会命中。
      // ⛔ 再扩大到别的显示原因——源判读只加这些有现成精确码的;诊断读数坏了 ⛔ 弄坏状态读取。
      try {
        const failure = ledgerFailureCached(this.deps.dataDir)
        if (failure) code = failure.code
        else if (unrestoredEntriesCached(this.deps.dataDir).length > 0) code = 'TUNNEL_RESTORE_INCOMPLETE'
        else if (hasInvalidPointers(this.deps.dataDir)) code = 'TUNNEL_POINTER_INVALID'
        else return
      } catch { return }
    }
    // 意外退出/放弃按死亡时刻记账:每次崩溃各有一笔,轮询重放同一笔死亡时去重;
    // ⛔ 拿盘上陈旧的 runId 当账头——两轮「没写状态就被杀」会并进同一笔,下一轮崩溃又被吞掉。
    const episodeKey = unexpectedExitAt !== undefined ? `exit:${String(unexpectedExitAt)}` : `${daemonState?.runId ?? ''}`
    const runKey = `${episodeKey}:${code}`
    if (this.reportedDaemonFailures.has(runKey)) return
    if (this.reportedDaemonFailures.size >= 500) this.reportedDaemonFailures.clear()
    this.reportedDaemonFailures.add(runKey)
    this.reportFailure(code, 'connect-run')
  }

  // state.json 的 error 是不是「本轮守护」写下的(甲-9 返工)。state.json 没有按轮清场:
  // 守护只在写出新状态时覆盖它,上一轮留下的 error 带旧码躺在盘上是常态。
  //  · spawn 轮:比对主进程发给本轮子进程的 runId——ensureRunning/退避重启每轮新发,对得上才算本轮;
  //  · 常驻轮:runId 是守护自己生成的,主进程不知道,改比席位锁:daemon.lock 的 at 是现任守护
  //    抢到席位的时刻,daemon-core 每次写 state 都盖 updatedAt,本轮写出的必不早于本轮抢席,
  //    上一轮写的码必早于本轮抢席,到这里现形。本进程 spawn 过就只认 spawn 的 runId——
  //    常驻时代的遗留锁和它留下的 state 同属旧轮、会互相「印证」,⛔ 让它们合伙冒充本轮死因。
  // 席位锁不在(夹具形态/本轮还没 spawn 过)就无从对账:按基线照认,⛔ 让返工把基线的回传弄丢。
  private daemonStateIsCurrentRound(daemonState: DaemonStateView): boolean {
    if (this.spawnedDaemonRunId !== '') return daemonState.runId === this.spawnedDaemonRunId
    try {
      // N-25:状态路径的席位锁读走记忆化(ino+mtime+size 失效);锁的抢/破/释放不在此列。
      const acquiredAt = readInstanceLockCached(this.deps.dataDir)?.holder?.at
      if (typeof acquiredAt !== 'number') return true
      const writtenAt = (daemonState as { updatedAt?: unknown }).updatedAt
      return typeof writtenAt === 'number' && writtenAt >= acquiredAt
    } catch { return true }
  }

  /** 失败终态统一出口:补上授权 ID(空串=还没导入配置),异常就地吞掉,⛔ 影响连接动作本身。
   * FB-3 件一:出口收口——只有受控码按原样回传,表外一律归 UNKNOWN(守护 state.json 的 code
   * 字段不校验、error.message 是非受控文本,都可能带路径)。真实消息留在本机日志,⛔ 上传。 */
  private reportFailure(rawCode: string, stage: DiagnosisStage): void {
    if (rawCode === '' || this.diagnosisReporter === undefined) return
    const code = KNOWN_FAILURE_CODES.has(rawCode) ? rawCode : 'UNKNOWN'
    try {
      this.diagnosisReporter.report({ code, stage, authorizationId: readCurrentInfo(this.deps.dataDir)?.authorizationId ?? '' })
    } catch { /* 回传失败不影响客户动作 */ }
  }

  /** 生产直传:与 acknowledgement 同一鉴权。无会话/设备直接放弃——⛔ 入队冒充「待补传」,
   * 没登录的客户永远没有可用的补传时机。 */
  private async deliverDiagnosis(payload: DiagnosisPayload): Promise<void> {
    const access = this.accountAccess
    if (!access || !access.session.deviceId) {
      throw Object.assign(new Error('DIAGNOSIS_NO_SESSION'), { diagnosisPermanent: 'auth' as const })
    }
    await access.client.reportDiagnosis(access.session, new AbortController().signal, payload)
  }

  // 明确退出时停止:退出意图经受限桥退出钩子登记;守护自行恢复并退出。
  async requestShutdown(): Promise<void> {
    this.repairController?.abort()
    this.pausedAccount = undefined
    this.clearConnectionLease()
    this.accountAccess = undefined
    this.accountRequest?.abort()
    this.supervisor.prepareForShutdown()
    if (this.supervisor.isRunning()) {
      if (this.intentSnapshot()?.desired === 'connected') this.markResumeOnLaunch(true)
      writeFileAtomic(layout.intent(this.deps.dataDir), `${JSON.stringify({ desired: 'shutdown', updatedAt: this.deps.now() })}\n`)
    } else {
      this.supervisor.recoverOnBoot()
    }
    // 守护退出后账本里若还有没还回去的系统设置(退出时写失败到了上限),主进程走前再派一次一次性恢复,
    // ⛔ 把指向死端口的代理留给客户(发布审查 R1)。
    try { await this.supervisor.waitForExit() } finally {
      if (!this.supervisor.isRunning() && !this.supervisor.isRestoring() && !ledgerFailure(this.deps.dataDir) && pendingSettingEntries(this.deps.dataDir).length > 0) {
        this.supervisor.recoverOnBoot()
        const deadline = Date.now() + 5_000
        while (this.supervisor.isRestoring() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200)) // N-25:等待类轮询放宽到 200ms
      }
    }
  }

  private rememberAccountPause(): void {
    const current = readCurrentInfo(this.deps.dataDir)
    if (!current?.accountId) return
    try {
      if (JSON.parse(readFileSync(layout.intent(this.deps.dataDir), 'utf8')).desired === 'connected') this.pausedAccount = current.accountId
    } catch { /* Missing or invalid intent never authorizes automatic reconnection. */ }
  }

  private async resumeAccountConnection(access: NetworkAccountAccess, assertSession: () => void): Promise<void> {
    if (this.pausedAccount !== access.session.accountId) return
    const deadline = Date.now() + 5_000
    while (this.rawStatus().unrestored && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200)); assertSession() // N-25:等待类轮询放宽到 200ms
      if (this.pausedAccount !== access.session.accountId) return
    }
    assertSession()
    if (this.rawStatus().unrestored || this.pausedAccount !== access.session.accountId) return
    const current = readCurrentInfo(this.deps.dataDir)
    if (!current || this.validateStored(current.batchId, false)) return
    writeFileAtomic(layout.intent(this.deps.dataDir), `${JSON.stringify(this.composeConnectIntent(current))}\n`)
    this.ensureRunningForConnection()
    this.pausedAccount = undefined
  }

  private validConfigCache(access: NetworkAccountAccess) {
    const cache = this.configCache
    const current = readCurrentInfo(this.deps.dataDir)
    if (!cache || !current || cache.accountId !== access.session.accountId || current.accountId !== cache.accountId ||
        cache.batchId !== current.batchId || cache.id !== current.authorizationId ||
        cache.expiresAt !== Date.parse(current.expiresAt) || cache.expiresAt <= this.deps.now()) return undefined
    try {
      const entries = readPackageEntries(layout.batchDir(this.deps.dataDir, cache.batchId)).filter((entry) => entry.path !== 'import-meta.json')
      return packageDigest(entries) === cache.digest ? cache : undefined
    } catch { return undefined }
  }

  private cacheConfiguration(access: NetworkAccountAccess, config: { id: string; expiresAt: number; etag?: string }, batchId: string, digest: string): void {
    this.configCache = config.etag ? { accountId: access.session.accountId, batchId, digest, id: config.id, expiresAt: config.expiresAt, etag: config.etag } : undefined
  }

  private acceptConnectionLease(access: NetworkAccountAccess, config: AccountConfiguration, version: number): void {
    if (!config.lease) { this.clearConnectionLease(); return }
    let value: ConnectionLease
    try {
      value = verifyConnectionLease(config.lease, { accountId: access.session.accountId, authorizationId: config.id,
        configVersion: version, configDigest: (config.etag ?? '').slice(1, -1), expiresAt: config.expiresAt },
      [...(this.deps.trust.trustedIssuers ?? []), ...this.deps.trust.signingPublicKeys], this.deps.now())
    } catch { throw new NetworkAccountError('NETWORK_LEASE_INVALID') }
    const old = this.connectionLease
    const deadline = performance.now() + Math.min(CONNECTION_LEASE_MS, value.notAfter - this.deps.now())
    this.connectionLease = { value, token: config.lease, sessionToken: access.session.accessToken,
      monotonicDeadline: old?.token === config.lease ? Math.min(old.monotonicDeadline, deadline) : deadline }
    this.accountTemporary = false
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
  }

  // 明确退出账号要跨重启记住(⛔ 重开工具箱又能不登录就用上一账号的配置):标记落盘,再次登录时清掉。
  private markSignedOut(signedOut: boolean): void {
    this.signedOutExplicitly = signedOut
    const marker = join(this.deps.dataDir, 'account-signed-out')
    try {
      if (signedOut) writeFileAtomic(marker, `${JSON.stringify({ at: this.deps.now() })}\n`)
      else rmSync(marker, { force: true })
    } catch { /* 标记读写失败不影响本次会话内的判断(内存位仍在) */ }
  }

  /** 本地配置是否属于「别人」:只有用户明确退出过、或当前登录的是另一个账号,才不许用它。账号模块还没核验完不算。 */
  private configForeignToSession(accountId: string): boolean {
    if (this.signedOutExplicitly) return true
    const access = this.accountAccess
    return access !== undefined && access.session.accountId !== accountId
  }

  // 后台问不到时保住客户正在用的网:意图是 connected 且本地配置没到期就继续(⛔ 再按 3 分钟租约算)。
  // 守护自己按 authorization.expiresAt 到期即停,主进程这里不再另起定时器。
  private retainLocalConnection(): boolean {
    if (ledgerFailure(this.deps.dataDir)) return false
    if (!this.localAuthorizationValid()) return false
    if (this.intentSnapshot()?.desired !== 'connected') return false
    this.accountTemporary = true
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
    return true
  }

  private expireLocalContinuation(): void {
    if (!this.accountTemporary) return
    this.rememberAccountPause()
    this.clearConnectionLease()
    this.disconnect()
  }

  private clearConnectionLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
    this.connectionLease = undefined
    this.accountTemporary = false
  }

  private async acknowledgeConfiguration(access: NetworkAccountAccess, signal: AbortSignal): Promise<void> {
    const current = readCurrentInfo(this.deps.dataDir)
    const lease = this.connectionLease?.value
    if (!current || !lease || !access.session.deviceId) return
    const signature = sha256Hex(Buffer.from(JSON.stringify([access.session.accountId, access.session.accessToken,
      access.session.deviceId, current.authorizationId, current.configVersion, lease.configDigest])))
    if (signature === this.acknowledgedConfiguration) return
    try {
      await access.client.acknowledge(access.session, signal, { authorizationId: current.authorizationId,
        configVersion: current.configVersion, configDigest: lease.configDigest })
      if (this.accountAccess === access) { this.acknowledgementPending = false; this.acknowledgedConfiguration = signature }
    } catch (error) {
      // Applied configuration remains applied; retry the readback receipt at the next authenticated sync.
      if (this.accountAccess === access) this.acknowledgementPending = true
      if (error instanceof NetworkAccountError && ['NETWORK_LOGIN_REQUIRED', 'NETWORK_AUTHORIZATION_UNAVAILABLE'].includes(error.message)) throw error
    }
  }

  private storedPackageDigest(current: NonNullable<ReturnType<typeof readCurrentInfo>>): string | undefined {
    try {
      const entries = readPackageEntries(layout.batchDir(this.deps.dataDir, current.batchId)).filter((entry) => entry.path !== 'import-meta.json')
      const expiresAt = Date.parse(current.expiresAt)
      return validatePackage(entries, { now: Number.isFinite(expiresAt) ? Math.min(this.deps.now(), expiresAt - 1) : this.deps.now(), trust: this.deps.trust, runtimePlatform: this.platform,
        currentAuthorizationId: current.authorizationId, currentVersion: undefined }).packageDigest
    } catch { return undefined }
  }

  private validateStored(batchId: string, replacement: boolean): ActionResult | undefined {
    try {
      const current = readCurrentInfo(this.deps.dataDir)
      const target = replacement ? readPendingInfo(this.deps.dataDir) : current
      if (target?.accountId && this.configForeignToSession(target.accountId)) return accountFailure('NETWORK_LOGIN_REQUIRED')
      if (target?.accountId && this.accountDenied) return accountFailure('NETWORK_AUTHORIZATION_UNAVAILABLE')
      const entries = readPackageEntries(layout.batchDir(this.deps.dataDir, batchId))
        .filter((entry) => entry.path !== 'import-meta.json')
      validatePackage(entries, {
        now: this.deps.now(), trust: this.deps.trust, runtimePlatform: this.platform,
        currentVersion: replacement && target?.authorizationId === current?.authorizationId ? current?.configVersion : undefined,
        currentAuthorizationId: target?.accountId ? target.authorizationId : current?.authorizationId,
        currentPackageDigest: replacement && target?.authorizationId === current?.authorizationId && current
          ? this.storedPackageDigest(current) : undefined
      })
      return undefined
    } catch (error) {
      return {
        outcome: 'rejected',
        code: error instanceof PackageReject ? error.code : 'TUNNEL_CONFIG_INVALID',
        message: error instanceof PackageReject ? error.message : '配置无法读取，请重新导入来信发放的配置包'
      }
    }
  }

  private intentSnapshot(): { desired: string; sessionToken?: string } | undefined {
    // N-25:记忆化读——盘面签名(mtime+size)没变就复用上次解析;写入都是原子替换,缓存自失效。
    const path = layout.intent(this.deps.dataDir)
    const key = statSignature(path)
    const cached = intentCache.get(this.deps.dataDir)
    if (cached !== undefined && cached.key === key) return cached.intent
    const intent = this.readIntentFromDisk()
    intentCache.set(this.deps.dataDir, { key, intent })
    return intent
  }

  private readIntentFromDisk(): { desired: string; sessionToken?: string } | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(layout.intent(this.deps.dataDir), 'utf8'))
      if (parsed && typeof parsed === 'object' && typeof (parsed as { desired?: unknown }).desired === 'string') {
        const record = parsed as { desired: string; sessionToken?: unknown }
        return { desired: record.desired, sessionToken: typeof record.sessionToken === 'string' ? record.sessionToken : undefined }
      }
    } catch { /* 意图文件缺失或损坏按无意图处理 */ }
    return undefined
  }

  private disconnect(): void {
    // 等待位不在这里清:内部流程(账号切换等)也会走 disconnect,清掉会让「并进同一轮」失效。
    // 客户意愿由意图文件表达,completeResidentTakeover 落定时看它;界面映射另有意图闸。
    this.markResumeOnLaunch(false)
    writeFileAtomic(layout.intent(this.deps.dataDir), `${JSON.stringify({ desired: 'user-disconnected', sessionToken: generateSessionToken(), updatedAt: this.deps.now() })}\n`)
    if (!this.supervisor.isRunning()) this.supervisor.recoverOnBoot()
  }

  private composeConnectIntent(current: NonNullable<ReturnType<typeof readCurrentInfo>>): Record<string, unknown> {
    const routes = this.routeTable(current)
    const batchDir = layout.batchDir(this.deps.dataDir, current.batchId)
    return {
      desired: 'connected',
      authorization: { id: current.authorizationId, expiresAt: Date.parse(current.expiresAt) },
      sessionToken: generateSessionToken(),
      updatedAt: this.deps.now(),
      bridgePort: DEFAULT_BRIDGE_PORT,
      bridgePortCandidates: [...BRIDGE_PORT_CANDIDATES],
      // 「客户这台电脑本来就能到 AI 服务就用它、不改他的设置」。判据与探测都在守护侧；
      // 这里给开关是因为真实探测 ⛔ 在用例里默认发生（开着专线的机器上会把用例集体带进复用分支）。
      reuseDirect: true,
      // 隐藏多节点:这份授权带几个入口就给几个,守护把它们一起交给内核探活择路;单节点包这里就是一项,形状不变。
      ...(this.deps.connectorOverride === undefined && current.protocol === 'vless-reality' && current.nodes.length > 1
        ? { connectors: current.nodes.map((entry) => ({
          kind: 'vless-reality', node: { host: entry.host, port: entry.port },
          credentialPath: join(batchDir, 'credentials', entry.credentialName),
          localPort: DEFAULT_BRIDGE_PORT, verifyUrl: entry.verifyUrl ?? current.verifyUrl, verifyFallbackUrl: current.verifyFallbackUrl
        })) }
        : {}),
      connector: this.deps.connectorOverride ?? (current.protocol === 'vless-reality' ? {
        kind: 'vless-reality', node: { host: current.node.host, port: current.node.port },
        credentialPath: join(batchDir, 'credentials', current.credentialName),
        localPort: DEFAULT_BRIDGE_PORT, verifyUrl: current.verifyUrl, verifyFallbackUrl: current.verifyFallbackUrl
      } : {
        kind: 'ssh-socks',
        node: { host: current.node.host, port: current.node.port, sshUser: current.node.sshUser },
        keyPath: join(batchDir, 'credentials', current.credentialName),
        knownHostsPath: join(batchDir, 'hostkey.pub'),
        localPort: DEFAULT_LOCAL_SOCKS_PORT,
        verifyUrl: `http://${current.node.host}/toolbox-exit-ip` // 节点 echo 端点待 01 供给(待真机)
      }),
      routes
    }
  }

  private routeTable(current: NonNullable<ReturnType<typeof readCurrentInfo>>) {
    const batchDir = layout.batchDir(this.deps.dataDir, current.batchId)
    const overlayPath = join(batchDir, 'overlay.json')
    const overlay = existsSync(overlayPath)
      ? (JSON.parse(readFileSync(overlayPath, 'utf8')) as RouteOverlay)
      : undefined
    const defaults = JSON.parse(readFileSync(this.deps.routesFile, 'utf8')) as {
      directSuffixes: string[]
      protectedDirectSuffixes: string[]
      dedicatedSuffixes?: string[]
    }
    return composeRoutes(defaults, overlay)
  }
}

function localContinuation(): ActionResult {
  return { outcome: 'continued', code: 'NETWORK_LEASE_CONTINUATION', message: '账号后台暂时问不到，按本地套餐有效期继续提供网络' }
}

// N-18:「真写入失败」判据,照 ai-access/config-write-fault.ts 先例(具体 fs 错误码,
// ⛔ 另起一套宽泛的错误体系):错误本体或其 cause 带文件系统错误码 → 写入失败,客户清磁盘/查权限
// 是有用功;不带(TypeError/ReferenceError 等程序错误)→ 非预期程序错误,⛔ 指使客户清磁盘。
const localWriteFaultCodes = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'EIO'])

/** N-18 判据导出:桥层翻译 stop 异常时区分「真写入失败」与「未预期程序错误」。 */
export function isLocalWriteFault(error: unknown): boolean {
  const candidates: readonly unknown[] = [error, (error as { readonly cause?: unknown } | undefined)?.cause]
  return candidates.some((candidate) => {
    const code = (candidate as NodeJS.ErrnoException | undefined)?.code
    return typeof code === 'string' && localWriteFaultCodes.has(code)
  })
}

/** 受控失败码 → 客户可见 ActionResult。桥层(actions/tunnel)翻译动作异常时共用,⛔ 再漏给通用兜底。 */
export function accountFailure(code: string): ActionResult {
  const messages: Record<string, string> = {
    NETWORK_LOGIN_REQUIRED: '请先登录来信账号', NETWORK_SESSION_CHANGED: '账号已变化，请重新获取配置',
    NETWORK_NO_APPLICATION: '当前账号尚未申请网络套餐', NETWORK_APPLICATION_PENDING: '网络申请正在处理中，批准后可自动获取配置',
    NETWORK_AUTHORIZATION_UNAVAILABLE: '当前套餐不可使用，请打开「我的账号」页查看额度、期限或开通状态',
    NETWORK_LEASE_INVALID: '连接授权核验未通过，请重新同步来信配置',
    NETWORK_DISCONNECT_REQUIRED: '请先断开通道，原设置恢复后再获取新配置',
    NETWORK_SERVICE_UNAVAILABLE: '暂时无法获取网络配置，请稍后重试', NETWORK_RESPONSE_INVALID: '网络配置未通过核验，原配置保留',
    NETWORK_LOCAL_BUSY: '工具箱正在恢复原设置，还没完成，请稍后再试一次',
    TUNNEL_LOCAL_WRITE_FAILED: '工具箱写入本地数据失败（磁盘已满或目录不可写），请清理磁盘空间或检查数据目录后重试',
    // N-18:非预期程序错误。⛔ 把机器原文(可能带路径)写进文案;最终用词待创始人确认。
    // 甲-7:开头不再限定「连接」——同一码也归同步路径(配置变化同步/点连接后同步),措辞照
    // TUNNEL_REPAIR_LOCAL_FAILURE 的中性写法,两种场景都说得通。
    TUNNEL_LOCAL_UNEXPECTED: '工具箱遇到一个未预期的问题，刚才的操作没能完成。请退出工具箱后重开；仍不行请复制诊断给客服。'
  }
  return { outcome: 'rejected', code: Object.hasOwn(messages, code) ? code : 'NETWORK_RESPONSE_INVALID', message: messages[code] ?? messages.NETWORK_RESPONSE_INVALID }
}

function rejectedBusy(): ActionResult {
  return {
    outcome: 'rejected',
    code: MUTEX_BUSY_CODE,
    message: '另一个通道操作正在进行,请稍候'
  }
}

function rejectedImportBusy(): ImportResult {
  return { ...rejectedBusy(), authorizationId: '', nodeLabel: '', expiresAt: '', source: '', pendingAvailable: false }
}

function mapImportOutcome(outcome: ImportOutcome, displayState: string): ImportResult {
  if (outcome.outcome === 'cancelled') {
    return { outcome: 'cancelled', code: '', message: '已取消', authorizationId: '', nodeLabel: '', expiresAt: '', source: '', pendingAvailable: false }
  }
  if (outcome.outcome === 'rejected') {
    return {
      outcome: 'rejected',
      code: outcome.code,
      message: outcome.message,
      authorizationId: '',
      nodeLabel: '',
      expiresAt: '',
      source: '',
      pendingAvailable: false
    }
  }
  const connecting =
    displayState === DISPLAY_STATES.connected || displayState === DISPLAY_STATES.connecting
  return {
    outcome: 'imported',
    code: '',
    message: connecting ? '已落待用版本;断开后应用' : '已导入为待用版本',
    authorizationId: outcome.authorizationId,
    nodeLabel: outcome.nodeLabel,
    expiresAt: outcome.expiresAt,
    source: outcome.sourceLine,
    pendingAvailable: true
  }
}
