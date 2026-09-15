// 守护核心(定稿第 2 轮 4/5、第 4 轮定稿 12):独立于 Electron 主进程。
// 职责:持账本执行写入与恢复、意图与实际分离(用户主动断开持久化、守护 ⛔ 拉起)、
// 状态机、五次快速退避后低频同节点恢复、短确认与探测目标故障区分、
// 父进程消失 → 按账本恢复再退出。全部 I/O 经注入的适配器 / 连接器 / bridge / 时钟。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { CONTROL_CODES } from './connectors.mjs'
import { appendIntentEntry, appendSettingEntry, generateSessionToken, isOptionalSettingService, isSettledSetting, lastIntent, loadLedger, markEntry, pendingSettingEntries, updateSettingEntry, withSettingsLock, assertSettingsLockHeld, SettingsBusyError, ENTRY_STATUS, LedgerError, ledgerFailure } from './ledger.mjs'
import { clearWriteRightOwner, publishWriteRightOwner, readWriteRightOwner, withWriteRight } from './write-right-owner.mjs'
import { markNotifyOwed, rebroadcastSettings, restoreLedger, unrestoredEntries, deepEqual } from './restore.mjs'
import { AI_SERVICE_PROBE_URLS, probeDirectReachability, probeExistingProxy } from './vless-connector.mjs'

// 退出时恢复系统代理写失败(注册表被杀软短暂锁住等)⛔ 直接退出留下指向死端口的代理(发布审查 R1):
// 按这个节奏重试到成功,约一分钟仍不成才带着「恢复未完成」退出交主进程/下次启动接着还。
export const SHUTDOWN_RESTORE_RETRY_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 20_000, 30_000])
// 快速梯子用尽后的慢节奏(GPT-6 复核 2a19530 #1):主进程 5 秒就退出了,守护是 detached 起的、比主进程活得久,
// 它就是那个「明确的恢复者」。写失败只要还是暂时性的(restore-failed),就每 30 秒再试,直到还回去为止;
// ⛔ 一分钟就带着「恢复未完成」走人——那会把指向死端口的系统代理留给客户。上限 30 分钟(60 轮),之后交给下次启动。
export const SHUTDOWN_RESTORE_SLOW_MS = 30_000
export const SHUTDOWN_RESTORE_SLOW_ROUNDS = 60

// 系统代理守卫(硬标准 09-13 晚:客户点了连接就要连上,⛔ 放弃):另一款代理软件也在守它的设置时,我们每次核对
// 都改回来,⛔ 止损、⛔ 停网;只在状态里说一句「另一款代理软件在反复修改系统代理」,提示客户关掉它。
// 反复修回不再逐次记账(本会话第一条账目已经记着真正的原值),账本 ⛔ 每 30 秒长一条。
const SETTINGS_CONTEST_NOTE_MS = 5 * 60_000
import { createPowerEventSource } from './power-events.mjs'

export const RECONNECT_BACKOFF_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 32_000])
export const SLOW_RECONNECT_MS = 60_000
// 网络抖动闸(D2):Wi-Fi 与热点来回切、地铁里信号断续时,网卡变化事件会一串地来。
// 每来一条就清退避、把次数归零、立刻重连 = 抖动期间反复拉起,而且退避永远长不起来。
// 所以事件驱动的立即恢复每 10 秒只放行一次;窗口内的后续网络变化只记不动,
// 恢复交给常规退避(2/4/8/16/32 秒)照常推进。
// 反过来说:网络连续稳定满 10 秒之后的下一次变化,又是一条新证据,立即恢复照旧生效。
export const NETWORK_SETTLE_MS = 10_000

/**
 * 按平台创建电源/网络事件源,把 wake 与 network-change 喂给守护。
 * **mac 与 Windows 都要创建**:只在 darwin 创建等于 Windows 的抖动闸没有输入——
 * 换网只能靠退避与 30 秒复验,主进程也只在 powerMonitor 'resume' 时补一条 wake(0.4.8 既有)。
 * 两个平台各有自己的 `power-events.mjs`(同名文件按平台目录解析,接口一致);
 * Windows 那份在 PowerShell 连续起不来时通过 onGiveUp 说一句,⛔ 无限重启空转。
 * platform 与 create 可注入,只为让用例能把两个分支都跑到。
 */
export function startPowerEvents({ platform = process.platform, emit, log, create = createPowerEventSource } = {}) {
  if (platform !== 'darwin' && platform !== 'win32') return { stop: () => undefined }
  return create({ emit, onGiveUp: (reason) => log?.(reason) })
}
const VERIFY_CONFIRM_MS = 1_000

// 致命受控码:配置 / 权限 / 身份问题,自动重连无意义,直接停。
// componentMissing(如随包 OpenSSH 缺失)在列:缺组件永远连不上,低频重试只会让客户
// 卡在「连接中」等不到一句人话,必须立即致命停止并给可操作文案。
const FATAL_CODES = new Set([
  CONTROL_CODES.portBusy,
  CONTROL_CODES.hostKeyMismatch,
  CONTROL_CODES.authFailed,
  CONTROL_CODES.quotaOrAuth,
  CONTROL_CODES.proxyConflict,
  CONTROL_CODES.managedPolicy,
  CONTROL_CODES.componentMissing,
  // 写入权被别人持有 / 认不出归属:再怎么重试也抢不到,而「反复抢」正是 2026-09-15 那次
  // 系统代理来回翻的根源。进稳定态等客户显式重新接管,⛔ 退避重连、⛔ 被网络事件唤起。
  'TUNNEL_WRITE_RIGHT_HELD',
  'TUNNEL_WRITE_RIGHT_UNKNOWN',
  // 同一连接周期内第二次被改就止损:对方明显在持续改,继续写回只是把系统代理来回翻。
  'TUNNEL_SETTINGS_CONTEST_STOPPED',
  // 另一份来信占着入口端口:换端口重试只会变成两份来信抢同一份系统代理,等客户处理那一份。
  'TUNNEL_PEER_LAIXIN_RUNNING'
])

/** 同一连接周期允许「被改→改回」的轮数上限(创始人 2026-09-15 定:两次连续被改即止损)。
 *  按**轮**计,⛔ 按项:一轮复验里四个注册表项一起被改,那是一次争抢,不是四次。 */
const SETTINGS_CONTEST_LIMIT = 2

/** 允许转呈给客户的对方状态词。⛔ 直接带对方的 message/code:那可能含路径或内部码。 */
const PEER_STATE_WORDS = Object.freeze({
  connected: '已连接',
  connecting: '正在连接',
  degraded: '连接不稳定',
  error: '出错了',
  'stopped-restored': '已停止并还原设置',
  'user-disconnected': '已断开',
  idle: '未连接'
})

export function intentPath(dataDir) {
  return join(dataDir, 'intent.json')
}

export function statePath(dataDir) {
  return join(dataDir, 'state.json')
}

export function trafficPath(dataDir) {
  return join(dataDir, 'traffic.json')
}

export function readIntentChecked(dataDir) {
  const path = intentPath(dataDir)
  if (!existsSync(path)) return { intent: undefined, corrupted: false }
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return { intent: undefined, corrupted: false }
  }
  try {
    return { intent: JSON.parse(source), corrupted: false }
  } catch {
    // intent.json 被杀软/同步盘弄脏(收敛包3·件1):改名留证,当「无意图」处理,
    // ⛔ 让 500ms 轮询把守护打死。
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* 改不动就下个 tick 再试 */ }
    return { intent: undefined, corrupted: true }
  }
}

export function readIntent(dataDir) {
  return readIntentChecked(dataDir).intent
}

// 同一数据目录的恢复权规则(全部恢复入口共用:退出流程、崩溃兜底):**状态文件已由别的守护写过** = 别的守护已实际接手
// (它启动时先按账本还旧账、再连、再写它自己的账),本进程从此不再改设置/账本/状态。
// ⛔ 把「意图文件里有别的会话要连接」当成已交接(GPT-6 复核 3d8d51f #1):那只是准备连接,新守护可能根本没起来,
// 恢复责任不能凭一个意图文件消失。没有 runId 的守护(测试形态)永远不判交接。
/**
 * 上一轮实际监听的入口端口。**判「注册表/网络设置里那个代理是不是我们自己的」时必须算上它**:
 * 候选口被占完时守护会退回系统随机分配,那个口不在候选表里;上次非正常退出留下的设置就指着它。
 * 认不出来的后果不是「少认一个」,而是我们把自己的残留当成客户的原值记进账本、退出时"还"给他一个死代理。
 */
export function lastBridgePort(dataDir) {
  try {
    const state = JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
    return typeof state?.bridgePort === 'number' ? state.bridgePort : undefined
  } catch { return undefined }
}

export function recoveryOwnedByOther(dataDir, runId) {
  if (typeof runId !== 'string' || runId === '') return false
  try {
    const state = JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
    return typeof state?.runId === 'string' && state.runId !== '' && state.runId !== runId
  } catch { return false } // 状态读不到:不算交接,宁可多还一次
}

// 顶层兜底(收敛包3·件1):未捕获异常/未处理的 Promise 拒绝 → 先按账本恢复系统代理、
// 写错误状态,再退出。⛔ 代理悬空着死让用户断网。
// 恢复权同一规则(GPT-6 复核 3d8d51f #2):别的守护已接手(状态文件是它的)→ 本进程的兜底只退出,⛔ 把新会话的设置还掉、账结掉、状态盖掉。
export function installCrashBailout({ dataDir, adapterOf, runId = '', exit = (code) => process.exit(code), log = () => undefined }) {
  let handled = false
  const handler = (origin) => (reason) => {
    if (handled) return
    handled = true
    log(`未捕获${origin === 'uncaughtException' ? '异常' : '的 Promise 拒绝'},先恢复系统代理再退出:${reason instanceof Error ? reason.message : String(reason)}`)
    // 「已恢复」以账本结算为准(发布审查 R5):restoreLedger 不抛不等于都还回去了。写失败先立刻再试一次。
    // 归属判定与恢复在同一把跨进程锁里做(⛔ 判完别人再插进来);锁等不到就不动设置,留给下一个恢复者。
    let restored = false
    let handedOver = false
    let writeRightHeldByOther = false
    try {
      const adapter = adapterOf()
      // 兜底恢复也是写系统代理(P1):没拿到全局写入权就一个字节都不碰——
      // 此刻系统代理归持权那一方管,我们崩了不等于可以去盖它的设置。
      const guarded = withWriteRight(adapter, () => {
        withSettingsLock(dataDir, () => {
          if (recoveryOwnedByOther(dataDir, runId)) { handedOver = true; return }
          let result = restoreLedger(dataDir, adapter)
          if (result.failed.length > 0) result = restoreLedger(dataDir, adapter)
          restored = result.failed.length === 0 && unrestoredEntries(dataDir).length === 0
        }, { owner: `crash:${runId}`, timeoutMs: 5_000 })
      }, log)
      writeRightHeldByOther = !guarded.ok
    } catch { /* 账本/适配器/锁不可用也要退出,不能卡死在兜底里 */ }
    if (handedOver) {
      log('同一数据目录已由别的守护接手:不碰设置与状态,直接退出')
      exit(70)
      return
    }
    try {
      writeState(dataDir, {
        state: 'error',
        code: 'DAEMON_CRASH',
        message: restored
          ? '守护异常退出，已恢复原设置；请重新连接'
          : writeRightHeldByOther
            ? '守护异常退出；这台电脑的网络设置正由另一个来信后台管理，本次未改动'
            : '守护异常退出，原设置恢复未完成，请重新打开工具箱重试'
      })
    } catch { /* 状态写不进也要退出 */ }
    exit(70)
  }
  const onUncaught = handler('uncaughtException')
  const onUnhandled = handler('unhandledRejection')
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)
  return {
    dispose: () => {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUnhandled)
    }
  }
}

export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true })
  const path = statePath(dataDir)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function writeTraffic(dataDir, traffic) {
  mkdirSync(dataDir, { recursive: true })
  const path = trafficPath(dataDir)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(traffic)}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function createDaemon(options) {
  return new DaemonCore(options)
}

class DaemonCore {
  constructor(options) {
    const {
      dataDir,
      runId = '',
      clock,
      adapter,
      connectorFactory,
      bridgeFactory,
      parentAlive,
      onExit,
      intentPollMs = 500,
      parentPollMs = 500,
      verifyIntervalMs = 30_000,
      random = Math.random,
      log = () => undefined
    } = options
    this.dataDir = dataDir
    this.runId = runId
    this.clock = clock
    this.adapter = adapter
    this.connectorFactory = connectorFactory
    this.bridgeFactory = bridgeFactory
    this.parentAlive = parentAlive
    this.onExit = onExit
    this.intentPollMs = intentPollMs
    this.parentPollMs = parentPollMs
    this.verifyIntervalMs = verifyIntervalMs
    this.random = random
    this.log = log

    this.intent = undefined
    this.connector = undefined
    this.bridge = undefined
    this.settingsApplied = false
    this.state = 'idle'
    this.sessionToken = ''
    this.reconnectAttempts = 0
    this.reconnectTimer = undefined
    this.verifyTimer = undefined
    this.trafficTimer = undefined
    this.lastTraffic = undefined
    this.confirmationTimer = undefined
    this.lastVerification = undefined
    this.verifyingConnector = undefined
    this.transitioning = false
    this.exited = false
    this.authorizationStopped = false
    this.authorizationTimer = undefined
    this.fatalStopped = false
    this.reconnectInFlight = false
    this.reconnectEpoch = 0
    this.lastEventRecoveryAt = undefined
    // D3「回答到一半断掉」:通道中断的那一刻,有几条连接正在回数据,就算几条被打断。
    // 用户自己点断开的 ⛔ 计入——那不是故障。⛔ 记网址、报文与任何正文,只累计条数。
    this.interruptedStreams = 0
    this.shutdownTask = undefined
    this.intentTimer = undefined
    this.parentTimer = undefined
    this.appliedItems = []
    this.intentCorruptionNoted = false
    // 断了不占代理(创始人 09-13):重连期间系统代理是否已先还给客户;还没还成功(注册表读写失败)时记着下次再还。
    this.settingsReleased = false
    this.settingsReleaseFailed = false
    this.notifyRetryTimer = undefined
    this.notifyRetries = 0
    // 本次实际监听的入口端口(候选里第一个没被占的);系统代理指向它。
    this.bridgePort = undefined
    // 「已有可用外网就复用」:客户电脑上别的代理能出外网时不改系统设置,记下它、只做定期复验;失效才改建来信连接。
    this.reusedProxy = undefined
    this.probeProxy = options.probeProxy ?? probeExistingProxy
    // 「这台电脑本来就能到 AI 服务吗」。⛔ 让它默认在用例里真跑:开着专线的开发机上会把用例集体
    // 带进复用分支(上一任接线做了又撤就是这么炸的)。真实探测只在意图显式带 reuseDirect 时才发生,
    // 而意图由主进程写;用例的意图不带这个字段,行为与从前一字不差。
    this.probeDirect = options.probeDirect ?? (() => probeDirectReachability(AI_SERVICE_PROBE_URLS))
    // 常驻自检(窗口 A 的 resident-integrity):由入口注入,守护本身 ⛔ 认识常驻那套东西。
    // 客户把应用拖进废纸篓时,主进程早就没了,唯一还攥着客户系统代理的就是这个进程。
    this.residentIntegrity = options.residentIntegrity
    this.residentSelfHeal = options.residentSelfHeal
    // 可选项(终端自动接入)这次没启用的原因,随状态给客户看,⛔ 挡网络。
    this.optionalNote = ''
  }

  activeBridgePort() {
    return this.bridgePort ?? this.intent?.bridgePort
  }

  /** 我们自己用过/可能用的入口端口。⛔ 靠端口长什么样去猜(候选口占满时系统分的口不长那样)。 */
  knownBridgePorts() {
    const ports = [this.bridgePort, this.intent?.bridgePort, ...(this.intent?.bridgePortCandidates ?? []), lastBridgePort(this.dataDir)]
    return ports.filter((port) => typeof port === 'number' && port > 0)
  }

  // 系统设置变更通知欠着:守护每 5 秒补发一次,最多 6 次;发成即止。⛔ 因为通知把恢复说成失败。
  scheduleNotifyRetry() {
    if (this.exited || this.notifyRetryTimer !== undefined) return
    this.notifyRetries = 0
    const tick = () => {
      this.notifyRetryTimer = undefined
      if (this.exited) return
      if (rebroadcastSettings(this.dataDir, this.adapter)) { this.log('系统设置变更通知已补发'); return }
      this.notifyRetries += 1
      if (this.notifyRetries >= 6) { this.log('系统设置变更通知补发未成功,已开着的软件可能要重开'); return }
      this.notifyRetryTimer = this.clock.setTimeout(tick, 5_000)
    }
    this.notifyRetryTimer = this.clock.setTimeout(tick, 5_000)
  }

  // 重连成功、设置重新写回后:上一轮「还给客户」时写失败、现值仍是我们的值的条目,收回成 applied
  // (它们本来就还在生效),⛔ 让界面一直挂着「原设置尚未恢复」。真正被别人改掉的不动。
  reclaimFailedRestores() {
    try { withSettingsLock(this.dataDir, () => this.reclaimFailedRestoresLocked(), { owner: `reclaim:${this.runId}` }) } catch { /* 锁被占:下次恢复照样按所有权处理 */ }
  }

  reclaimFailedRestoresLocked() {
    const equal = this.adapter.valuesEqual ?? deepEqual
    for (const entry of loadLedger(this.dataDir)) {
      if (entry.kind !== 'setting' || entry.status !== ENTRY_STATUS.restoreFailed) continue
      let current
      try { current = this.adapter.read({ service: entry.service, item: entry.item }) } catch { continue }
      if (!equal(current, entry.writtenValue, entry)) continue
      try { markEntry(this.dataDir, entry.id, { status: ENTRY_STATUS.applied, note: '' }) } catch { /* 下次恢复照样按所有权处理 */ }
      if (!this.appliedItems.some(({ ref }) => ref.service === entry.service && ref.item === entry.item)) {
        this.appliedItems.push({ ref: { service: entry.service, item: entry.item }, value: entry.writtenValue })
      }
    }
  }

  async run() {
    mkdirSync(this.dataDir, { recursive: true })
    let recoveryBlocked = false
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    // 任一进程再次启动时先读账本:有未恢复项先按规则处理,再做别的(判据 3③)。
    if (pendingSettingEntries(this.dataDir).length > 0) {
      const recovered = this.restoreSettings()
      if (this.exited) return
      if (recovered) this.log(`启动恢复:已恢复 ${recovered.restored.length} 项`)
      else {
        // 恢复没做完就 ⛔ 继续连接(P1):connect() 开头会把 fatalStopped 清掉,于是在**没还干净的设置**上
        // 又写一层——退出时再也还不回客户原来的样子。判据用「恢复是否成功」,⛔ 用 pendingSettingEntries:
        // 还原写失败的条目会转成 restore-failed,不再计入 pending,那条判据拦不住这一幕。
        //
        // ⛔ 在这里 return(第二轮 P1):那样意图轮询还没装,而外层 keepalive 让进程继续活着、
        // 监管器又认为守护在跑 —— 客户点「重新连接」只改了 intent 文件,守护永远不会读它,
        // 界面卡在「连接中」,客户只能退出重开工具箱。改成:本轮不连,但**照常装上轮询**,
        // 客户显式重试时 tickIntent 接得住,connect() 里会再试一次恢复。
        this.log('启动恢复未完成:本次不建立连接,继续监听意图等待客户重试')
        recoveryBlocked = true
      }
    }
    const persistedIntent = lastIntent(this.dataDir)
    const { intent: fileIntent, corrupted } = readIntentChecked(this.dataDir)
    this.intent = fileIntent ?? (persistedIntent === undefined ? undefined : { desired: persistedIntent })
    // 意图文件损坏已隔离:状态里留一句可见证据(收敛包3·件1)。
    if (corrupted && !this.intentCorruptionNoted) {
      this.intentCorruptionNoted = true
      this.writeStateNow(this.state, { code: 'INTENT_FILE_CORRUPT_RESET', message: '意图文件已损坏并重置' })
    }
    // 意图持久化双源一致:账本意图落后于意图文件时先落账(判据 2:重起后读账本意图仍有效)
    if (this.intent !== undefined && this.intent.desired !== persistedIntent) {
      if (!await this.recordIntent(this.intent.desired)) return
    }

    this.authorizationTimer = this.clock.setInterval(() => this.tickAuthorization(), this.intentPollMs)
    this.intentTimer = this.clock.setInterval(() => this.tickIntent(), this.intentPollMs)
    this.parentTimer = this.clock.setInterval(() => this.tickParent(), this.parentPollMs)
    if (this.intent?.desired === 'connected' && !recoveryBlocked) {
      await this.connect()
    } else if (this.intent?.desired === 'shutdown') {
      this.shutdown()
      return
    } else if (!recoveryBlocked) {
      if (unrestoredEntries(this.dataDir).length === 0) this.writeStateNow(this.intent?.desired === 'user-disconnected' ? 'user-disconnected' : 'idle')
    }
    // recoveryBlocked 时什么都不写:保留 restoreSettings 已写明的真因,⛔ 被 idle 盖掉。
  }

  tickIntent() {
    if (this.exited || this.shutdownTask) return
    const { intent: next, corrupted } = readIntentChecked(this.dataDir)
    if (corrupted && !this.intentCorruptionNoted) {
      this.intentCorruptionNoted = true
      this.writeStateNow(this.state, { code: 'INTENT_FILE_CORRUPT_RESET', message: '意图文件已损坏并重置' })
    }
    if (next === undefined || (next.desired === this.intent?.desired &&
        next.sessionToken === this.intent?.sessionToken && next.updatedAt === this.intent?.updatedAt)) {
      return
    }
    if (this.transitioning && next.desired === 'connected') return
    this.transitioning = true
    void this.applyIntent(next).catch(() => this.requestShutdown()).finally(() => {
      this.transitioning = false
    })
  }

  authorizationCode() {
    const authorization = this.intent?.authorization
    // Loopback probes are test-only connectors. Production intents must carry
    // the deadline from the package already verified by the main process.
    if (authorization === undefined && this.intent?.connector?.kind === 'loopback-probe') return undefined
    if (!authorization || typeof authorization.id !== 'string' || !authorization.id ||
        !Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= 0) return 'TUNNEL_AUTHORIZATION_INVALID'
    if (authorization.expiresAt <= this.clock.now()) return 'TUNNEL_AUTHORIZATION_EXPIRED'
    return undefined
  }

  tickAuthorization() {
    if (this.exited || this.authorizationStopped || this.intent?.desired !== 'connected') return
    const code = this.authorizationCode()
    if (code) void this.stopForAuthorization(code)
  }

  async stopForAuthorization(code) {
    if (this.authorizationStopped || this.exited) return
    this.authorizationStopped = true
    this.state = 'error'
    await this.stopConnection()
    if (!this.restoreSettings()) return
    if (!this.exited) this.writeStateNow('error', { code, message: code === 'TUNNEL_AUTHORIZATION_EXPIRED'
      ? '网络授权已到期，已断开通道；请查看有效套餐或更新来信配置'
      : '网络授权期限缺失或无效，请重新连接或更新来信配置' })
  }

  async assertCurrent(connector) {
    const code = this.authorizationCode()
    if (code || this.exited || this.authorizationStopped || this.intent?.desired !== 'connected' || this.connector !== connector) {
      await connector.stop()
      throw Object.assign(new Error(code ?? '连接已取消'), { code: code ?? 'TUNNEL_CONNECTION_CANCELLED' })
    }
  }

  async applyIntent(next) {
    this.intent = next
    if (!await this.recordIntent(next.desired) || this.intent !== next) return
    if (next.desired === 'connected') {
      await this.connect()
      return
    }
    if (next.desired === 'user-disconnected') {
      this.writeStateNow('user-disconnected')
      await this.stopConnection()
      if (!this.restoreSettings()) return
      this.writeStateNow('stopped-restored')
      return
    }
    if (next.desired === 'shutdown') {
      this.shutdown()
    }
  }

  tickParent() {
    if (this.exited) {
      return
    }
    // 常驻模式下没有父进程可看,这个节拍改成看「我自己的程序还在不在」:客户把应用拖进废纸篓了,
    // 我们得自己发现、把他的系统代理还回去、再把常驻项撤掉,⛔ 留一个指向死端口的代理和一个拉不起来的常驻项。
    if (this.residentIntegrity !== undefined) {
      if (this.residentIntegrity.check().missing) void this.runResidentSelfHeal()
      return
    }
    if (this.parentAlive()) {
      return
    }
    this.requestShutdown()
  }

  // 程序被删了:停连接 → 还原 → 卸常驻。还没还干净就**留在原地下一轮再试**,⛔ 退出——
  // 程序已经不在,退出后 launchd 也拉不起来它,再没有第二个人能把客户的代理还回去。
  async runResidentSelfHeal() {
    if (this.residentSelfHeal === undefined || this.selfHealing || this.exited || this.shutdownTask) return
    this.selfHealing = true
    try {
      await this.stopConnection()
      if (this.exited) return
      const outcome = this.residentSelfHeal()
      if (outcome?.shouldExit) {
        this.writeStateNow('stopped-restored')
        this.exit(0) // 0 ⇒ 常驻机制不再拉起(mac KeepAlive.SuccessfulExit=false / win 只认非零码)
        return
      }
      this.writeStateNow('error', { code: 'TUNNEL_RESIDENT_SELF_HEAL', message: '工具箱已被移除，正在把电脑的网络设置还原；完成前请不要关机' })
    } finally {
      this.selfHealing = false
    }
  }

  async connect() {
    if (this.shutdownTask || this.exited || this.intent?.desired !== 'connected') return
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    await this.stopConnection()
    if (this.shutdownTask || this.exited || this.intent?.desired !== 'connected') return
    if (!this.restoreSettings()) {
      if (this.settingsBusy) await this.handleConnectFailure(Object.assign(new Error('系统设置正被另一恢复任务占用'), { code: 'TUNNEL_SETTINGS_BUSY' }))
      return
    }
    this.authorizationStopped = false
    this.fatalStopped = false
    this.entryRotation = 0
    this.contender = undefined
    this.contenderProbedAt = undefined
    this.settingsContestRounds = 0
    this.sessionToken = this.intent?.sessionToken ?? generateSessionToken()
    this.reconnectAttempts = 0
    if (this.intent?.connector === undefined) {
      this.writeStateNow('error', { code: '配置缺失', message: '意图缺连接器,无法连接' })
      return
    }
    const code = this.authorizationCode()
    if (code) { await this.stopForAuthorization(code); return }
    this.writeStateNow('connecting')
    const request = this.intent
    try {
      if (await this.tryReuseExistingProxy()) return
      if (this.intent !== request) return
      await this.establish()
    } catch (error) {
      if (this.intent !== request) return
      await this.handleConnectFailure(error)
    }
  }

  // 「已有可用外网就复用、不抢」(创始人 09-13 晚):电脑上别的代理正开着且经它能出外网 → 不改任何系统设置,
  // 状态记为已连(复用),每个复验周期再探一次;探不通了才改建来信连接。PAC 没法求值 → 按不可判定处理,走来信连接。
  async tryReuseExistingProxy() {
    let existing
    try { existing = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() }) } catch { existing = undefined }
    // 电脑上没有设代理,不等于客户没有外网(他可能装着 VPN 走全局、人在墙外、公司有专线)。
    // 但「本来就能上网」⛔ 等于「能用 AI」——公司网络常放行 Google 却拦着 AI 服务,拿通用探测点当判据
    // 会让这种客户永远等不到我们接管(本机实测:能上外网的机器上,122 条用例集体走进复用分支)。
    // 这条要做,判据必须是「能不能到客户真正要用的那些服务」;探测原语已备
    // (vless-connector.probeDirectReachability),接线等判据定了再说。
    if (!existing || !['http', 'socks'].includes(existing.kind)) {
      // 没设代理 ⛔ 等于没有外网:客户可能装着 VPN 走全局、人在墙外、公司有专线。这条路能到 AI 服务
      // 就用它、一个字节不改客户的设置(GPT-6 4.3①)。PAC 仍按不可判定处理——求值要跑 JS,风险大于收益。
      return await this.tryReuseDirectPath()
    }
    try { await this.probeProxy(existing) } catch (error) {
      this.log(`电脑上已有代理 ${existing.host}:${String(existing.port)} 出不了外网(${error instanceof Error ? error.message : String(error)}),改建来信连接`)
      return false
    }
    if (this.exited || this.intent?.desired !== 'connected') return false
    this.reusedProxy = existing
    this.state = 'connected'
    this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
    this.writeReusedState()
    this.scheduleVerify()
    this.log(`电脑上已有代理 ${existing.host}:${String(existing.port)} 能出外网:复用它,不改系统设置`)
    return true
  }

  /**
   * 「客户这台电脑本来就能用 AI」:不改任何系统设置,记为已连(复用直连),每个复验周期再探一次。
   *
   * 三条边界,⛔ 放宽:
   *  · **只在意图显式带 reuseDirect 时才探**。默认不探——真实探测在开着专线的机器上会把用例
   *    集体带进这条分支(上一任撤线的原因)。
   *  · **判据是能不能到 AI 服务**,⛔ 通用探测点(公司网络常放行 Google 却拦 AI)。
   *  · **误判代价不对称**:判错成「他自己能用」→ 客户点了连接却没网;判错成「他不能用」→ 我们多接管
   *    一次,客户照样能用。所以探不通、拿不准、探测本身出错,一律当作不能直连。
   */
  async tryReuseDirectPath() {
    if (this.intent?.reuseDirect !== true) return false
    try { await this.probeDirect() } catch { return false }
    if (this.exited || this.intent?.desired !== 'connected') return false
    this.reusedProxy = { kind: 'direct', source: '本机已有外网' }
    this.state = 'connected'
    this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
    this.writeReusedState()
    this.scheduleVerify()
    this.log('这台电脑本来就能到 AI 服务:用它,不改系统设置')
    return true
  }

  // 读电脑当前的代理设置;读不到(瞬时错误)沿用上次记住的,⛔ 因为一次读失败就拆掉客户正在用的复用通路。
  currentExistingProxy(fallback) {
    let current
    try { current = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() }) } catch { return fallback }
    if (this.adapter.existingProxy === undefined) return fallback
    return current && ['http', 'socks'].includes(current.kind) ? current : undefined
  }

  writeReusedState() {
    const existing = this.reusedProxy
    // 直连形态没有 host/port,⛔ 套同一句模板(会写出「（undefined:undefined）」给客户看)。
    // 文案(创始人 2026-09-15 定):⛔ 写成「AI 可以正常用」——我们探通的是**通用外网**,
    // 那不代表客户的 AI 账号能登录、能对话。只陈述事实,把确认动作交回给客户。
    // 直连形态单独一句:它不是「其他代理」,套同一句模板就是在说假话。
    const message = existing.kind === 'direct'
      ? '这台电脑本来就能直接访问，来信未接管系统代理。请在目标 AI 软件中确认登录和对话。'
      : `检测到电脑上的其他代理（${String(existing.host)}:${String(existing.port)}）可联网，来信未接管系统代理。请在目标 AI 软件中确认登录和对话。`
    this.writeStateNow('connected', { ...this.lastVerification, code: 'TUNNEL_REUSED_EXISTING', reusedProxy: existing, message })
  }

  // 复用模式的复验:先重读电脑**当前**的代理设置(GPT-6 复核 2a19530 #2:⛔ 只探记住的旧地址——对方软件换了口/关了/
  // 切成 PAC,客户的应用已经走新设置,我们还对着旧口说「已连接」),再探当前那个:能出外网就继续复用(换了口就跟着换);
  // 出不了外网 / 已关闭 / 切成 PAC(不可判定)→ 确认轮后改建来信连接。客户主动断开(意图不是 connected)一律不接管。
  async reverifyReused(confirming) {
    const existing = this.reusedProxy
    // 直连形态:复验就是再探一次那条路还在不在(客户的 VPN 可能已经关了、人可能回国了)。
    // ⛔ 走下面那条「读当前代理设置」——直连本来就没有代理设置可读,一读就判成「已关闭」,
    // 会把一条好好的路当场拆掉改建来信连接。
    if (existing?.kind === 'direct') return await this.reverifyReusedDirect(existing, confirming)
    const current = this.currentExistingProxy(existing)
    try {
      if (current === undefined) throw new Error('电脑上的代理设置已被关闭或改成无法判定的形态')
      await this.probeProxy(current)
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      if (current.host !== existing.host || current.port !== existing.port || current.kind !== existing.kind) {
        this.log(`电脑上的代理已换成 ${current.host}:${String(current.port)} 且能出外网:继续复用它`)
        this.reusedProxy = current
      }
      this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
      this.writeReusedState()
    } catch {
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      if (!confirming) {
        this.writeStateNow('degraded', { ...this.lastVerification, code: 'TUNNEL_VERIFY_UNCONFIRMED', message: '本机现有外网暂未确认，正在复查' })
        this.confirmationTimer = this.clock.setTimeout(() => {
          this.confirmationTimer = undefined
          void this.reverify(true)
        }, VERIFY_CONFIRM_MS)
        return
      }
      this.log(`本机现有外网 ${existing.host}:${String(existing.port)} 已失效:改建来信连接`)
      this.reusedProxy = undefined
      this.clearVerify()
      this.writeStateNow('connecting')
      const request = this.intent
      try { await this.establish() } catch (error) {
        if (this.intent !== request) return
        await this.handleConnectFailure(error)
      }
    }
  }

  /** 直连复用的复验:探不通 → 确认轮 → 仍不通就改建来信连接(与代理复用同一节奏,⛔ 一次抖动就拆)。 */
  async reverifyReusedDirect(existing, confirming) {
    try {
      await this.probeDirect()
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
      this.writeReusedState()
      return
    } catch { /* 落到下面的确认轮 */ }
    if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
    if (!confirming) {
      this.writeStateNow('degraded', { ...this.lastVerification, code: 'TUNNEL_VERIFY_UNCONFIRMED', message: '本机现有外网暂未确认，正在复查' })
      this.confirmationTimer = this.clock.setTimeout(() => {
        this.confirmationTimer = undefined
        void this.reverify(true)
      }, VERIFY_CONFIRM_MS)
      return
    }
    this.log('这台电脑已经到不了 AI 服务了:改建来信连接')
    this.reusedProxy = undefined
    this.clearVerify()
    this.writeStateNow('connecting')
    const request = this.intent
    try { await this.establish() } catch (error) {
      if (this.intent !== request) return
      await this.handleConnectFailure(error)
    }
  }

  // 隐藏多节点:意图里带了多个入口且**全是**「壳」型连接器(vless-reality——它不起进程,全部本事在 xrayOutbound)时,
  // 把它们一起交给内核,由内核探活挑能用的那条。ssh-socks 会真起进程,多开等于多条隧道,⛔ 并入。
  //
  // 两层故障转移,缺一不可:
  //  ① 内核层(observatory + 均衡器):探活点可达时,某条入口被掐掉,下一个请求就走别的,客户无感。
  //  ② 守护层(本函数的轮转):探活点自己也不可达时(探测点被封、或所有节点都出不去),内核没有择路依据,
  //     只会固定用清单里的第一条——本机实测过这一幕。这时靠守护发现通道不通后轮转顺序、重建配置,
  //     让下一条排到第一位。慢几秒,但 ⛔ 让客户卡死在一条已经掐掉的入口上。
  entrySpecs() {
    const primary = this.intent?.connector
    const list = this.intent?.connectors
    const single = primary === undefined ? [] : [primary]
    if (!Array.isArray(list) || list.length <= 1) return single
    if (!list.every((spec) => spec?.kind === 'vless-reality')) return single
    const offset = (this.entryRotation ?? 0) % list.length
    return offset === 0 ? [...list] : [...list.slice(offset), ...list.slice(0, offset)]
  }

  /** 换下一条入口打头。返回是否真的换了(只有一条入口时不换)。 */
  rotateEntry() {
    const list = this.intent?.connectors
    if (!Array.isArray(list) || list.length <= 1) return false
    this.entryRotation = ((this.entryRotation ?? 0) + 1) % list.length
    const next = this.entrySpecs()[0]
    this.log(`换下一条入口重试:${String(next?.node?.host)}:${String(next?.node?.port)}(第 ${String(this.entryRotation + 1)}/${String(list.length)} 条)`)
    return true
  }

  async establish() {
    const spec = this.intent?.connector
    if (spec === undefined) {
      throw Object.assign(new Error('意图缺连接器'), { code: CONTROL_CODES.upstreamUnreachable })
    }
    this.adapter.preflight?.({ host: '127.0.0.1', port: this.activeBridgePort() })
    // 多入口:轮转后的第一条当主连接器(复验、本地口都走它),全部入口一起交给内核。
    const specs = this.entrySpecs()
    this.connector = this.connectorFactory(specs[0] ?? spec)
    this.entryConnectors = specs.length > 1 ? specs.map((entry, index) => (index === 0 ? this.connector : this.connectorFactory(entry))) : undefined
    const connector = this.connector
    connector.onLost((error) => { if (this.connector === connector) this.onConnectionLost(error) })
    await connector.start()
    await this.assertCurrent(connector)
    await this.ensureBridge()
    await this.assertCurrent(connector)
    const { exitIp } = await this.verifyConnection(connector)
    await this.assertCurrent(connector)
    this.applySettings()
    this.reclaimFailedRestores()
    this.verifySettings()
    this.settingsReleased = false
    this.settingsReleaseFailed = false
    this.repairedItems = undefined
    this.state = 'connected'
    this.lastVerification = { exitIp, lastVerifiedAt: this.clock.now() }
    this.writeStateNow('connected', this.lastVerification)
    this.scheduleTraffic()
    this.scheduleVerify()
  }

  async ensureBridge() {
    if (this.bridge !== undefined && this.bridge.isAlive?.() !== false) return
    await this.bridge?.close()
    // 入口端口按候选表依次试(18080 是开发者机器上常见的被占端口:Tomcat/Jenkins/别的代理):
    // 第一个能监听的就用,系统代理跟着指向它;全被占才报「端口占用」。已有中继活着时不换端口。
    const candidates = Array.isArray(this.intent.bridgePortCandidates) && this.intent.bridgePortCandidates.length > 0
      ? [this.bridgePort ?? this.intent.bridgePortCandidates[0], ...this.intent.bridgePortCandidates.filter((port) => port !== (this.bridgePort ?? this.intent.bridgePortCandidates[0]))]
      : [this.bridgePort ?? this.intent.bridgePort]
    let lastError
    for (const listenPort of candidates) {
      const bridge = this.bridgeFactory({
        upstream: { host: '127.0.0.1', port: this.connector.localProxyPort() },
        outbound: this.connector.xrayOutbound?.(),
        outbounds: this.entryConnectors?.map((entry) => entry.xrayOutbound?.()).filter(Boolean),
        verifyUrl: this.intent.connector.kind === 'loopback-probe' ? undefined : this.intent.connector.verifyUrl,
        verifyFallbackUrl: this.intent.connector.kind === 'loopback-probe' ? undefined : this.intent.connector.verifyFallbackUrl,
        verifyTimeoutMs: this.intent.connector.timeoutMs,
        listenPort,
        routes: this.intent.routes,
        dataDir: this.dataDir
      })
      this.bridge = bridge
      bridge.onLost?.((error) => this.onConnectionLost(error))
      bridge.onDegraded?.(() => this.onTrafficDegraded())
      try {
        await bridge.listen()
      } catch (error) {
        lastError = error
        if (error?.code !== CONTROL_CODES.portBusy || this.exited || this.intent?.desired !== 'connected') { this.bridge = undefined; throw error }
        // 先认一认占着它的是谁(创始人 2026-09-15 第 1 条):18080 是来信自己的固定入口,
        // 被占的第一嫌疑就是另一份来信。是自己人就 ⛔ 换端口继续抢——换了也只是两份来信
        // 各占一个端口去抢同一份系统代理。进稳定态,让客户去处理那一份。
        const owner = this.adapter.identifyPortOwner?.(listenPort)
        if (owner?.kind === 'laixin') {
          this.bridge = undefined
          // 后启动的这一份要**如实展示前一份的状态**(硬线二),⛔ 只说「有人占着」就完事。
          // 读不到就没有,降级为不带状态的那句话。
          const word = this.peerStateWord(readWriteRightOwner())
          throw Object.assign(new Error('这台电脑上已经有一份来信在运行；请先退出或卸载那一份，再重新连接'), {
            code: 'TUNNEL_PEER_LAIXIN_RUNNING',
            peer: { pid: owner.pid, name: owner.name },
            ...(word === undefined ? {} : { peerState: word })
          })
        }
        this.log(`入口端口 ${String(listenPort)} 被占,换下一个候选${listenPort === 0 ? '' : ''}`)
        this.bridge = undefined
        continue
      }
      const actualPort = typeof bridge.port === 'function' ? bridge.port() : listenPort
      if (listenPort === 0) this.log(`固定候选口全被占:改用系统分配的空闲口 ${String(actualPort)}`)
      if (this.bridge !== bridge || this.authorizationStopped || this.exited || this.intent?.desired !== 'connected') {
        await bridge.close()
        throw Object.assign(new Error('连接已取消'), { code: 'TUNNEL_CONNECTION_CANCELLED' })
      }
      if (this.bridgePort !== undefined && this.bridgePort !== actualPort && this.appliedItems.length > 0) {
        // 端口变了而系统代理还指着旧端口:清掉清单,让 applySettings 按新端口重新记账写入。
        this.appliedItems = []
        this.settingsApplied = false
      }
      this.bridgePort = actualPort
      return
    }
    throw lastError ?? Object.assign(new Error('入口端口全部被占'), { code: CONTROL_CODES.portBusy })
  }

  // allowFallback:回显失败后要不要再打通用探测点。首次连接与复验的确认轮打;复验的第一轮不打
  // (先进「待确认」等 1 秒再说,⛔ 每次抖动都多花两次探测的时间)。
  // 被动检测(照 mihomo):中继报告客户的真实请求在通道里连续失败 → 立刻复验,⛔ 干等 30 秒定时。
  // 复验自己会走「待确认 → 1 秒后确认 → 重连」;这里只负责把它提前。同一时刻只放一次,5 秒内不重复。
  onTrafficDegraded() {
    if (this.exited || !['connected', 'degraded'].includes(this.state) || this.intent?.desired !== 'connected') return
    const at = this.clock.now()
    if (this.lastPassiveCheckAt !== undefined && at - this.lastPassiveCheckAt < 5_000) return
    this.lastPassiveCheckAt = at
    this.log('客户请求在通道里连续失败:立即复验')
    void this.reverify()
  }

  async verifyConnection(connector, allowFallback = true) {
    const bridge = this.bridge
    try {
      return await (bridge?.verify ? bridge.verify() : connector.verify())
    } catch (error) {
      // 回显地址(配置里指定的那台服务器)打不通 ≠ 通道死了。再用通用探测点从通道里出去问一句:
      // 有回应就是通道活着,按已连处理(出口 IP 沿用上次或留空);⛔ 因为自家回显服务抖一下就把客户的网拆了。
      const probe = bridge?.probeReachability
      if (!allowFallback || typeof probe !== 'function' || error?.code === 'TUNNEL_CONNECTION_CANCELLED') throw error
      try { await probe() } catch { throw error }
      this.log('回显探测未通过,但通用探测点经通道可达:按已连处理(出口 IP 未知)')
      return { exitIp: this.lastVerification?.exitIp ?? '' }
    }
  }

  // ---- 系统代理写入权(创始人 2026-09-15 三条硬线) ----
  // 硬线一:它保护的是**写 WinINET 的权**,⛔ 阻止两个守护为了正常交接而同时存活。
  // 硬线二:拿不到权的一方 ⛔ 悄悄退出让界面失明——要把持有者的真实状态读出来转呈。
  // 硬线三:持有到恢复完成或明确移交为止;前任死活由内核的 abandoned 标记说了算,⛔ 靠超时猜。
  ensureWriteRight() {
    if (this.writeRight !== undefined) return { ok: true }
    // 平台不提供这把权(mac 现阶段):维持原有行为,⛔ 顺手改掉另一个平台的语义。
    if (typeof this.adapter.acquireWriteRight !== 'function') return { ok: true }
    let outcome
    try { outcome = this.adapter.acquireWriteRight({ timeoutMs: 0 }) } catch { outcome = undefined }
    if (outcome?.acquired !== true) {
      // 认不出原语(koffi 缺失)与「确实有人持有」都不许写系统代理:前者按未知冲突处理,由上层决定怎么说。
      return { ok: false, reason: outcome?.reason ?? 'unavailable', holder: readWriteRightOwner() }
    }
    this.writeRight = outcome
    // 每取得一次写入权换一个令牌,名片与本轮写出的 state 都带它。⛔ 复用 runId 之类的长寿标识:
    // 那样上一轮留下的旧 state 也会「匹配」,等于没校验。
    this.writeRightToken = randomBytes(12).toString('hex')
    publishWriteRightOwner({ pid: process.pid, runId: this.runId, dataDir: this.dataDir,
      resident: this.resident === true, token: this.writeRightToken })
    // 前任是崩掉的(内核标记 abandoned):它没机会按账本还原,先补上再接管,⛔ 直接往客户的设置上盖。
    if (outcome.abandoned === true) {
      this.log('上一个持有写入权的守护异常退出:先按账本补还原,再接管')
      // 恢复**成功之后才允许继续**(P1):restoreSettings 在有未恢复项、锁被占、账本错时返回 undefined。
      // 那时前一会话留下的设置还在系统里,继续 applySettings 就是往没还干净的状态上盖。
      // keepWriteRight:这次还原是为了接管,⛔ 在中途把权交出去。
      const recovered = this.restoreSettings({ keepWriteRight: true })
      if (recovered === undefined) {
        // 拒绝接管:交还权(让下一轮或别的实例有机会),恢复状态已由 restoreSettings 写明。
        this.releaseWriteRight()
        return { ok: false, reason: 'recovery-incomplete', holder: undefined }
      }
    }
    return { ok: true }
  }

  /** 交还写入权。还原完成、让路给别的代理、退出时都要走这里,⛔ 把权攥到进程被杀。 */
  releaseWriteRight() {
    const right = this.writeRight
    if (right === undefined) return
    this.writeRight = undefined
    this.writeRightToken = undefined
    clearWriteRightOwner(process.pid)
    try { right.release() } catch { /* 内核已回收 */ }
  }

  /**
   * 读持有者的**真实状态**并转呈(硬线二:拿不到权的一方 ⛔ 让界面失明)。
   *
   * 权威永远是互斥体,名片只是线索。所以这里层层设防,任何一步不对就降级为泛化提示:
   *  · 名片没有数据目录、或指向自己 → 不转呈
   *  · 名片太旧(超过 PEER_CARD_MAX_AGE_MS)→ 不信它,持有者可能早就换人了
   *  · 状态文件读不到 / 过大 / 不是 JSON → 不转呈
   *  · 状态不在白名单里 → 不转呈
   * 只输出白名单里的**状态词**。⛔ 把对方的 message / code / 路径 / PID / 日志带出来:
   * 那些可能含安装路径或内部码,客户看不懂,也不该看到别人机器上的细节。
   */
  peerStateWord(holder) {
    const dir = holder?.dataDir
    if (typeof dir !== 'string' || dir === '' || dir === this.dataDir) return undefined
    // 名片必须带本轮令牌。⛔ 用「名片多久没更新」判持有者死活:互斥体已经是权威,
    // 超时判活只会两头错——持有者活得好好的却过了 5 分钟就不再转呈,
    // 而刚换人时旧 state 又会被当成现况。
    if (typeof holder.token !== 'string' || holder.token === '') return undefined
    let raw
    try { raw = readFileSync(join(dir, 'state.json'), 'utf8') } catch { return undefined }
    if (typeof raw !== 'string' || raw.length > 65_536) return undefined
    let parsed
    try { parsed = JSON.parse(raw) } catch { return undefined }
    // 令牌对不上 = 这份 state 不是当前这一轮持权写的(旧守护遗留、或刚刚换过人)→ 不转呈。
    if (parsed?.writeRightToken !== holder.token) return undefined
    const state = typeof parsed?.state === 'string' ? parsed.state : undefined
    return state === undefined ? undefined : PEER_STATE_WORDS[state]
  }

  /** 拿不到写入权时的受控错误。⛔ 走重连退避——那正是这次反复横跳的来源。 */
  writeRightConflict({ reason, holder }) {
    if (reason === 'recovery-incomplete') {
      return Object.assign(new Error('上一次的网络设置尚未完全还原，本次不改动系统设置；请重试恢复'), {
        code: 'TUNNEL_RESTORE_INCOMPLETE', holder
      })
    }
    if (reason === 'unavailable') {
      return Object.assign(new Error('无法确认系统代理的归属，本次不改动系统设置'), {
        code: 'TUNNEL_WRITE_RIGHT_UNKNOWN', holder
      })
    }
    const word = this.peerStateWord(holder)
    const who = holder?.dataDir !== undefined && holder.dataDir !== this.dataDir
      ? '另一份来信（安装位置不同）正在管理这台电脑的网络'
      : '另一个来信后台正在管理这台电脑的网络'
    // 读得到对方真实状态就如实转呈;读不到就退回泛化说法,⛔ 编一个。
    const message = word === undefined
      ? `${who}；本次不改动系统设置`
      : `${who}（它当前：${word}）；本次不改动系统设置`
    return Object.assign(new Error(message), { code: 'TUNNEL_WRITE_RIGHT_HELD', holder, peerState: word })
  }

  applySettings() {
    const right = this.ensureWriteRight()
    if (!right.ok) throw this.writeRightConflict(right)
    withSettingsLock(this.dataDir, () => this.applySettingsLocked(), { owner: `apply:${this.runId}` })
  }

  applySettingsLocked() {
    this.flushPendingIntent()
    if (this.settingsApplied) this.verifySettingsLocked()
    // 写系统设置:每项先记账再写入(定稿第 2 轮 5)。
    const items = this.adapter.managedItems({ host: '127.0.0.1', port: this.activeBridgePort() })
    let changed = false
    for (const managed of items) {
      if (this.appliedItems.some(({ ref }) => ref.service === managed.ref.service && ref.item === managed.ref.item)) continue
      const optional = isOptionalSettingService(managed.ref.service)
      let originalValue
      try { originalValue = this.adapter.read(managed.ref) } catch (error) {
        // 可选项(终端接入)读不到(没权限/文件锁):跳过它,⛔ 让系统代理网络起不来(发布审查 R2)
        if (!optional) throw error
        this.noteOptionalSkipped(managed.ref, error)
        continue
      }
      const entry = appendSettingEntry(this.dataDir, {
        service: managed.ref.service,
        item: managed.ref.item,
        originalValue,
        writtenValue: managed.value,
        sessionToken: this.sessionToken,
        time: this.clock.now()
      })
      assertSettingsLockHeld(this.dataDir)
      try { this.adapter.write(managed.ref, managed.value) } catch (error) {
        if (!optional) throw error
        // 没写进去就把这条账目结掉(现值就是原值),⛔ 留成「未恢复」
        try { markEntry(this.dataDir, entry.id, { status: ENTRY_STATUS.restored, note: '可选项未写入(无权限或被占用),保留原状' }) } catch { /* 账目结不掉也不挡网络 */ }
        this.noteOptionalSkipped(managed.ref, error)
        continue
      }
      this.appliedItems.push(managed)
      changed = true
    }
    if (changed) this.broadcastSettingsBestEffort()
    this.settingsApplied = true
  }

  noteOptionalSkipped(ref, error) {
    this.optionalNote = '终端自动接入这次没启用（配置文件无法访问），浏览器与系统代理不受影响'
    this.log(`可选项 ${ref.service}/${ref.item} 跳过:${error instanceof Error ? error.message : String(error)}`)
  }

  // 设置已经写进系统 = 已生效(Chrome/Edge 自己监听注册表);变更通知只是让别的软件早点重读。
  // 通知通道(PowerShell/原生)坏了 ⛔ 让连接失败——那会让客户在「连接中」里打转。记欠账,守护定时补发。
  broadcastSettingsBestEffort() {
    try { this.adapter.broadcastSettingsChanged?.() } catch (error) {
      this.log(`系统设置变更通知失败,稍后补发:${error instanceof Error ? error.message : String(error)}`)
      try { markNotifyOwed(this.dataDir, true) } catch { /* 标记失败最多少补一次 */ }
      this.scheduleNotifyRetry()
    }
  }

  verifySettings(repair = false) {
    withSettingsLock(this.dataDir, () => this.verifySettingsLocked(repair), { owner: `verify:${this.runId}` })
  }

  verifySettingsLocked(repair = false) {
    const equal = this.adapter.valuesEqual ?? deepEqual
    // 「设置还满足接管要求吗」与「当前完整值还属于我们写的吗」是两个判断(GPT-6 复核 2bf4fa9 #2):
    // 比如 mac 的 PAC 项,关着就算满足(地址被别人改了也不必动),但退出时判归属要比完整值。
    const satisfied = this.adapter.settingSatisfied ? (current, value, ref) => this.adapter.settingSatisfied(current, value, ref) : equal
    const mismatch = () => Object.assign(new Error('本机接入设置未生效'), { code: 'TUNNEL_SETTINGS_NOT_APPLIED' })
    if (this.appliedItems.length === 0) throw mismatch()
    let changed = false
    // 本轮是否已计过一次争抢:一轮里多项同时被改算一次,⛔ 按项累加把上限瞬间打满。
    let contestedThisRound = false
    try {
      for (const applied of this.appliedItems) {
        const { ref } = applied
        const current = this.adapter.read(ref)
        if (satisfied(current, applied.value, ref)) continue
        if (!repair || !this.adapter.reapplyOnChange?.(ref)) throw mismatch()
        if (!contestedThisRound) {
          contestedThisRound = true
          this.settingsContestRounds = (this.settingsContestRounds ?? 0) + 1
        }
        // 止损(创始人 2026-09-15):第一次被改,允许读取现状并改回;同一连接周期内第二次又被改,
        // 就**停止自动写回**——保留对方此刻的实际设置,稳定报冲突原因。
        // ⛔ 再「已改回 4 次还继续」:那正是系统代理被来回翻的根源。
        // 这里 throw 出去后进稳定态(FATAL_CODES),退出时账本按 kept-modified 保留对方现值。
        if (this.settingsContestRounds >= SETTINGS_CONTEST_LIMIT) {
          // 止损也必须记账:对方此刻的值就是「将来要还给客户的那个值」。
          // ⛔ 只抛不记——退出时会把客户的网还给一个更早的旧快照(用例
          // 「退出须恢复最后一次完整外部值」盯的正是这一点)。我们不写系统设置,但账要更新到现值。
          this.recordRepairOriginal(ref, current, current, equal)
          throw Object.assign(new Error('系统代理正被这台电脑上的其他程序反复修改，来信已停止自动改回并保留其当前设置'), {
            code: 'TUNNEL_SETTINGS_CONTEST_STOPPED',
            contender: this.contender
          })
        }
        // 「已有可用外网就复用、不抢」(创始人 09-13 晚硬标准)要兑现到争抢这一幕:别的软件把系统代理改成了它自己的,
        // 如果**它那条也能出外网**,客户要的「有网可用」已经满足了——那就该让给它,⛔ 每 30 秒抢回来一次。
        // 只有它那条出不了外网,才改回来(客户点了连接,我们得负责让他有网)。
        // 这里趁设置还是对方的值先读出它是谁;探它通不通要发网络请求,⛔ 在锁里做——记下来,出了锁再探。
        if (this.contender === undefined) {
          try {
            const rival = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() })
            if (rival && ['http', 'socks'].includes(rival.kind)) this.contender = rival
          } catch { /* 读不出对方是谁:照旧改回来 */ }
        }
        // 修回时写的值由适配器定(PAC:只关开关、保留对方现在的地址),⛔ 把对方后来改的地址也一并覆盖
        const value = this.adapter.repairValue?.(ref, current, applied.value) ?? applied.value
        // 只在客户仍要求连接时修复:每次都改回来(硬标准),⛔ 止损。本会话每一项只留一条修回账目(账本 ⛔ 每 30 秒长一条),
        // 但恢复依据必须是对方**最后**写的值:对方这次写的和账上记的不一样 → 先把账目的原值改成它并落盘,再覆盖
        // (先记账后写入)。⛔ 只记第一次的值——退出时会把客户的网交回一个早已停用的旧地址(GPT-6 补核 R6)。
        this.settingsRepairs = (this.settingsRepairs ?? 0) + 1
        this.lastSettingsRepairAt = this.clock.now()
        this.recordRepairOriginal(ref, current, value, equal)
        assertSettingsLockHeld(this.dataDir)
        this.adapter.write(ref, value)
        applied.value = value
        changed = true
        if (!equal(this.adapter.read(ref), value, ref)) throw mismatch()
      }
    } finally {
      if (changed) this.broadcastSettingsBestEffort()
    }
  }

  // 争抢对手那条能不能出外网:能就让给它(转成复用态,不再抢);不能就维持现状(我们已经改回来了)。
  // 探测在锁外做,每 SETTINGS_CONTEST_NOTE_MS 最多探一次,⛔ 每轮复验都给对方的代理打一次。
  async considerYieldingToContender() {
    const rival = this.contender
    if (rival === undefined || this.exited || this.intent?.desired !== 'connected' || this.reusedProxy !== undefined) return
    if (this.contenderProbedAt !== undefined && this.clock.now() - this.contenderProbedAt < SETTINGS_CONTEST_NOTE_MS) return
    this.contenderProbedAt = this.clock.now()
    try { await this.probeProxy(rival) } catch { return } // 它出不了外网:我们继续管着客户的网
    if (this.exited || this.intent?.desired !== 'connected' || this.reusedProxy !== undefined) return
    this.log(`另一款代理软件 ${rival.host}:${String(rival.port)} 自己能出外网:让给它,来信不再抢(它失效时会自动接管回来)`)
    // 停连接会按账本把系统设置还回去——账本里记的原值正是对方最后写的那个(recordRepairOriginal 保证),
    // 所以还完就是对方的设置,客户的网走它那条。
    await this.stopConnection()
    if (this.exited || this.intent?.desired !== 'connected') return
    if (!this.restoreSettings()) return
    this.contender = undefined
    this.settingsRepairs = 0
    this.lastSettingsRepairAt = undefined
    // 已经把系统代理让给对方,我们不再写它:权要交还,⛔ 攥着一把自己不用的锁挡住别的来信。
    this.releaseWriteRight()
    this.reusedProxy = rival
    this.state = 'connected'
    this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
    this.writeReusedState()
    this.scheduleVerify()
  }

  // 争抢修回的记账:本会话每项一条;对方换了新值就把这条账目的原值改成新值(先落盘再覆盖系统设置);
  // 账目已在中途恢复里结算(重连期间还过一次)就另记一条,⛔ 改一条已结算的账。
  recordRepairOriginal(ref, current, value, equal) {
    const key = `${ref.service}/${ref.item}`
    this.repairedItems = this.repairedItems ?? new Map()
    const repaired = this.repairedItems.get(key)
    if (repaired !== undefined && equal(current, repaired.originalValue, ref)) return
    if (repaired !== undefined) {
      const updated = updateSettingEntry(this.dataDir, repaired.id, { originalValue: current, writtenValue: value, time: this.clock.now() })
      if (updated !== undefined) { repaired.originalValue = current; return }
    }
    const entry = appendSettingEntry(this.dataDir, { service: ref.service, item: ref.item, originalValue: current,
      writtenValue: value, sessionToken: this.sessionToken, time: this.clock.now() })
    this.repairedItems.set(key, { id: entry.id, originalValue: current })
  }

  scheduleVerify() {
    this.clearVerify()
    this.verifyTimer = this.clock.setInterval(() => {
      void this.reverify()
    }, this.verifyIntervalMs)
  }

  async reverify(confirming = false) {
    if (this.exited) return
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    if (this.reusedProxy !== undefined) {
      if (!['connected', 'degraded'].includes(this.state) || this.intent?.desired !== 'connected' || this.confirmationTimer !== undefined) return
      if (this.reusedVerifying) return
      this.reusedVerifying = true
      try { await this.reverifyReused(confirming) } finally { this.reusedVerifying = false }
      return
    }
    if (this.exited || !['connected', 'degraded'].includes(this.state) || this.connector === undefined ||
        this.verifyingConnector === this.connector || this.confirmationTimer !== undefined) {
      return
    }
    const connector = this.connector
    this.verifyingConnector = connector
    const stillCurrent = () => !this.exited && ['connected', 'degraded'].includes(this.state) && this.intent?.desired === 'connected' && this.connector === connector
    try {
      this.verifySettings(true)
      const { exitIp } = await this.verifyConnection(connector, confirming)
      if (stillCurrent()) { this.applySettings(); this.verifySettings() }
      if (stillCurrent()) {
        this.lastVerification = { exitIp, lastVerifiedAt: this.clock.now() }
        const contested = this.lastSettingsRepairAt !== undefined && this.clock.now() - this.lastSettingsRepairAt <= SETTINGS_CONTEST_NOTE_MS
        this.writeStateNow('connected', contested
          ? { ...this.lastVerification, code: 'TUNNEL_SETTINGS_CONTESTED', message: `另一款代理软件在反复修改系统代理（已改回 ${String(this.settingsRepairs)} 次）；正在确认它能否自己上外网，能就让给它` }
          : this.lastVerification)
        // 锁外探对手:它自己能出外网就让给它(兑现「已有可用外网就复用、不抢」)
        if (contested) void this.considerYieldingToContender()
      }
    } catch (error) {
      if (!stillCurrent()) return
      if (error?.code && FATAL_CODES.has(error.code)) { this.onConnectionLost(error); return }
      if (!confirming) {
        this.writeStateNow('degraded', { ...this.lastVerification, code: 'TUNNEL_VERIFY_UNCONFIRMED', message: '通道暂未确认，正在复查' })
        this.confirmationTimer = this.clock.setTimeout(() => {
          this.confirmationTimer = undefined
          void this.reverify(true)
        }, VERIFY_CONFIRM_MS)
      } else if (error?.code === CONTROL_CODES.probeUnavailable) {
        this.writeStateNow('degraded', { ...this.lastVerification, code: CONTROL_CODES.probeUnavailable,
          message: '检测服务暂时不可用，通道已保留，将继续检查' })
      } else this.onConnectionLost(error)
    } finally {
      if (this.verifyingConnector === connector) this.verifyingConnector = undefined
    }
  }

  onConnectionLost(error) {
    if (this.exited || this.transitioning) {
      return
    }
    if (!['connected', 'degraded'].includes(this.state) || this.intent?.desired !== 'connected') {
      return // 用户主动断开等场景:守护 ⛔ 拉起(判据 2)
    }
    this.settleActiveStreams()
    const code = error?.code ?? CONTROL_CODES.upstreamUnreachable
    if (FATAL_CODES.has(code)) { void this.handleConnectFailure(error); return }
    this.enterReconnect(code)
  }

  async handleConnectFailure(error) {
    if (error?.code === 'TUNNEL_AUTHORIZATION_EXPIRED' || error?.code === 'TUNNEL_AUTHORIZATION_INVALID') {
      await this.stopForAuthorization(error.code)
      return
    }
    if (this.authorizationStopped || this.exited || this.intent?.desired !== 'connected' || error?.code === 'TUNNEL_CONNECTION_CANCELLED') return
    const code = error?.code ?? CONTROL_CODES.upstreamUnreachable
    // message 仍写 code(界面按码查文案表,是既有架构)。但「对方当前是什么状态」是**动态**的,
    // 查不了静态表 —— 单独落一个白名单状态词,由界面拼进那句话。
    // ⛔ 把它塞进 message:那样文案表就查不到、客户又会看到裸码。
    // ⛔ 只在第一处带上它:下面致命分支会再写一次 state,漏了就等于没落(用例盯着这一点)。
    const failureState = typeof error?.peerState === 'string' && error.peerState !== ''
      ? { code, message: code, peerState: error.peerState }
      : { code, message: code }
    this.writeStateNow('error', failureState)
    await this.stopConnection()
    if (!this.restoreSettings() && !this.settingsBusy) return
    if (FATAL_CODES.has(code)) {
      this.fatalStopped = true
      this.writeStateNow('error', failureState)
      return
    }
    this.enterReconnect(code)
  }

  enterReconnect(code) {
    const authorizationCode = this.authorizationCode()
    if (authorizationCode) { void this.stopForAuthorization(authorizationCode); return }
    this.clearVerify()
    this.state = 'error'
    this.releaseSettingsForRecovery()
    this.writeStateNow('error', { code, message: this.reconnectMessage() })
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.exited || this.authorizationStopped || this.fatalStopped || this.intent?.desired !== 'connected') return
    const slow = this.reconnectAttempts >= RECONNECT_BACKOFF_MS.length
    // 快速退避用尽(约 1 分钟)还没接上:不管中继活不活,先把系统代理还给客户。酒店 Wi-Fi 的登录页、节点长时间
    // 不通、超设备数被节点拒……这些情况下让客户先能正常上网,我们低频继续试,接上再写回(照 ClashX:代理永远不
    // 成为断网源)。
    if (slow) { this.releaseSettingsForRecovery(true); this.writeStateNow('error', { code: CONTROL_CODES.upstreamUnreachable, message: this.reconnectMessage(true) }) }
    const base = slow ? SLOW_RECONNECT_MS : RECONNECT_BACKOFF_MS[this.reconnectAttempts]
    const delay = base + Math.floor(base * 0.25 * this.random())
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.attemptReconnect()
    }, delay)
  }

  async attemptReconnect() {
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    if (this.exited || this.authorizationStopped || this.fatalStopped || this.intent?.desired !== 'connected') {
      return
    }
    if (this.reconnectInFlight) {
      return // 在途恢复未决:合并触发源,⛔ 并发重连
    }
    this.reconnectInFlight = true
    const epoch = ++this.reconnectEpoch
    try {
      await this.attemptReconnectOnce(epoch)
    } finally {
      this.reconnectInFlight = false
    }
  }

  async attemptReconnectOnce(epoch) {
    const authorizationCode = this.authorizationCode()
    if (authorizationCode) { await this.stopForAuthorization(authorizationCode); return }
    const slow = this.reconnectAttempts >= RECONNECT_BACKOFF_MS.length
    if (!slow) this.reconnectAttempts += 1
    this.log(slow ? '低频重连尝试' : `重连尝试 ${this.reconnectAttempts}/5`)
    try {
      await this.stopConnectorOnly()
      // 多入口:这一轮换下一条打头(内核层没能自己切走时的兜底);换了就要连中继一起重建,
      // 否则内核里跑的还是上一份出站顺序。
      if (this.rotateEntry() && this.bridge !== undefined) {
        const bridge = this.bridge
        this.bridge = undefined
        await bridge.close()
      }
      // 只重建连接器:bridge 与系统设置仍归本会话账本,⛔ 重复记账写入(否则原值被覆盖成我们自己的值)。
      await this.establish()
      this.reconnectAttempts = 0
    } catch (error) {
      if (this.exited || epoch !== this.reconnectEpoch) {
        return // 已有更新的恢复接管;过期任务 ⛔ 写状态覆盖新连接
      }
      if (error?.code === 'TUNNEL_AUTHORIZATION_EXPIRED' || error?.code === 'TUNNEL_AUTHORIZATION_INVALID') {
        await this.stopForAuthorization(error.code)
        return
      }
      if (this.authorizationStopped || this.exited || this.intent?.desired !== 'connected' || error?.code === 'TUNNEL_CONNECTION_CANCELLED') return
      const code = error?.code ?? CONTROL_CODES.upstreamUnreachable
      if (FATAL_CODES.has(code)) {
        // 致命停止要显式记档:nofityEvent 以此闸住后续唤醒/网络事件,
        // 只有意图驱动的新 connect()(用户重新连接)才清除。
        this.fatalStopped = true
        this.reconnectAttempts = 0
        await this.stopConnection()
        if (!this.restoreSettings()) return
        this.writeStateNow('error', { code, message: code })
        return
      }
      // 这次没连上:中继要是没起来(内核起不来/端口没监听),先把系统代理还给客户再等下一轮。
      this.releaseSettingsForRecovery()
      this.writeStateNow('error', { code, message: this.reconnectMessage() })
      this.scheduleReconnect()
    }
  }

  reconnectMessage(slow = false) {
    if (this.settingsReleased) return slow ? '连接中断，已先恢复电脑正常上网；正在低频重试' : `连接中断，已先恢复电脑正常上网；自动重连中(${this.reconnectAttempts}/5)`
    if (this.settingsReleaseFailed) return slow ? '连接中断，电脑原设置恢复未完成，正在重试恢复并低频重连' : `连接中断，电脑原设置恢复未完成，正在重试恢复；自动重连中(${this.reconnectAttempts}/5)`
    return slow ? '连接暂不可用，正在低频重试' : `连接中断,自动重连中(${this.reconnectAttempts}/5)`
  }

  // 断了不占代理(创始人 09-13):系统代理指向的是本机中继(18080)。中继不在监听时,每一个走系统代理的
  // 连接都会被拒——不是「外网不通」,是整机断网。所以重连期间只要中继不在,就先按账本把系统代理还给客户
  // (意图仍是 connected,退避照常推进),连上后 establish() 会重新记账写回。
  // 中继活着(只是上游断)不动:国内直连仍由内核放行,重连成功无缝接回,与 ClashX 一致。
  releaseSettingsForRecovery(force = false) {
    if (this.settingsReleased) return false
    const bridgeAlive = this.bridge !== undefined && this.bridge.isAlive?.() !== false
    if (bridgeAlive && !force) return false
    if (this.appliedItems.length === 0 && pendingSettingEntries(this.dataDir).length === 0) return false
    let result
    try {
      // 恢复 + 同步清单在同一把锁里
      result = withSettingsLock(this.dataDir, () => {
        const restored = restoreLedger(this.dataDir, this.adapter)
        this.syncAppliedItemsWithLedger()
        return restored
      }, { owner: `release:${this.runId}` })
    } catch (error) {
      if (error instanceof LedgerError) { this.writeStateNow('error', { code: error.code, message: error.message }); this.exit(65); return false }
      this.log(`重连期间恢复系统代理失败:${error instanceof Error ? error.message : String(error)}`)
      this.settingsReleaseFailed = true
      return false
    }
    if (result.notifyFailed) this.scheduleNotifyRetry()
    // 逐项同步「来信正在使用的设置」清单(已在锁内做):账本里已结算(写回原值/保留他人现值)的项从清单里去掉——
    // 它们已经不是我们的值,下次连上要重新记账写入;写回失败、现值仍是我们的项留在清单里(它们还在生效)。
    // ⛔ 整份清单原样留着:那会让下一次 applySettings 把「已还回原值」当成「设置被人改了」判致命(GPT-6 复核 5253dc7)。
    // 「还给客户」以账本结算为准:还有写失败的条目就不算还成,下一轮重连再试(restoreLedger 只重试失败项),
    // ⛔ 把发起恢复当成恢复成功、更 ⛔ 之后跳过恢复让客户继续断网。
    if (unrestoredEntries(this.dataDir).length > 0) {
      this.settingsReleaseFailed = true
      this.log('本机中继不在监听,但系统代理没能全部还给客户:下一轮重连再试恢复')
      return false
    }
    this.settingsApplied = false
    this.appliedItems = []
    this.settingsReleased = true
    this.settingsReleaseFailed = false
    this.log('本机中继不在监听:已先把系统代理还给客户,继续后台重连')
    return true
  }

  // 按账本最新一条同名账目决定每一项还归不归我们管;清单空了就等于「设置未应用」。
  syncAppliedItemsWithLedger() {
    if (this.appliedItems.length === 0) return
    const entries = loadLedger(this.dataDir)
    const latestOf = (ref) => [...entries].reverse().find((entry) => entry.kind === 'setting' && entry.service === ref.service && entry.item === ref.item)
    this.appliedItems = this.appliedItems.filter(({ ref }) => {
      const entry = latestOf(ref)
      return entry !== undefined && !isSettledSetting(entry)
    })
    this.settingsApplied = this.appliedItems.length > 0
  }

  // 两端共用的睡眠唤醒 / 网络变化处理，合并在途触发。
  // 意图与实际分离 ⛔ 自动拉起:仅当意图为 connected 才响应;授权已停/致命态同样不响应。
  // 唤醒 = 连通性的新证据 ⇒ 开新的恢复小节:未决退避清零、立即重试;已连则立即复验。
  // 快速重试用尽后保留低频恢复；新网络事件可提前触发同节点恢复。
  notifyEvent(event) {
    if (this.exited || this.transitioning) {
      return
    }
    if (event !== 'wake' && event !== 'network-change') {
      return
    }
    if (this.intent?.desired !== 'connected' || this.authorizationStopped || this.fatalStopped) {
      return
    }
    if (['connected', 'degraded'].includes(this.state)) {
      void this.reverify()
      return
    }
    if (this.reconnectInFlight) {
      return // 在途恢复未决:合并后续事件,⛔ 并发重连互相覆盖状态
    }
    if (this.reconnectTimer === undefined && this.reconnectAttempts === 0) {
      return
    }
    // 唤醒是一次性事件(合盖、休眠恢复),始终立即试。
    // 网络变化可能是抖动:刚因为它拉起过就再来一条,说明网还在变——这次不动,
    // 让常规退避按自己的节奏推进,⛔ 每条事件各拉一次、还把退避次数清零。
    const settling = event === 'network-change' && this.lastEventRecoveryAt !== undefined &&
      this.clock.now() - this.lastEventRecoveryAt < NETWORK_SETTLE_MS
    if (settling) {
      this.log('网络仍在变化:本次不拉起,按退避恢复')
      return
    }
    this.recoverAfterEvent(event)
  }

  // 事件驱动的恢复:清掉未决退避、把次数归零、立刻试一次。
  // 用户主动断开始终优先:意图不是 connected 就直接返回(⛔ 把手动断开的连接拉起来)。
  recoverAfterEvent(reason) {
    if (this.exited || this.transitioning) return
    if (this.intent?.desired !== 'connected' || this.authorizationStopped || this.fatalStopped) return
    if (['connected', 'degraded'].includes(this.state)) return
    if (this.reconnectInFlight) return
    if (this.reconnectTimer === undefined && this.reconnectAttempts === 0) return
    this.log(`电源事件(${reason}):立即重试`)
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimer(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectAttempts = 0
    this.lastEventRecoveryAt = this.clock.now()
    void this.attemptReconnect()
  }


  async stopConnectorOnly() {
    this.clearVerify()
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimer(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.connector !== undefined) {
      const connector = this.connector
      this.connector = undefined
      await connector.stop()
    }
  }

  // 结算中断那一刻的在途流。只在「通道自己断了」时调用:用户主动断开不是故障,⛔ 计入。
  // 桥读不到就不记,⛔ 猜一个数。
  settleActiveStreams() {
    let active = 0
    try { active = Number(this.bridge?.traffic?.().activeStreams ?? 0) } catch { return }
    if (!Number.isSafeInteger(active) || active <= 0) return
    this.interruptedStreams += active
    this.log(`通道中断时有 ${active} 条连接正在回数据`)
    this.refreshTraffic()
  }

  async stopConnection() {
    this.reconnectEpoch += 1
    this.reusedProxy = undefined
    this.entryConnectors = undefined
    this.clearVerify()
    this.clearTraffic()
    this.settingsApplied = false
    this.appliedItems = []
    this.settingsReleased = false
    await this.stopConnectorOnly()
    if (this.bridge !== undefined) {
      const bridge = this.bridge
      this.bridge = undefined
      await bridge.close()
    }
  }

  shutdown() {
    if (this.exited || this.shutdownTask) return
    // 信号/父进程断开必须能打断正在连接的任务，不受 transitioning 闸阻挡。
    this.intent = { desired: 'shutdown' }
    this.transitioning = true
    this.shutdownTask = (async () => {
      if (!await this.recordIntent('shutdown')) return
      await this.stopConnection()
      // 退出时恢复失败 ⛔ 一次就走(发布审查 R1):中继已关,代理还指着它就是整机断网。按节奏重试到成功;
      // 约一分钟仍不成,带「恢复未完成」退出(65),主进程/下次启动接着还。
      // 同一数据目录的设置恢复只能有一个当前所有者(GPT-6 复核 2bf4fa9 #1):客户在我们还在慢恢复时重开工具箱,
      // 新守护会先按账本还掉我们的旧账、再连上并写它自己的账;这时我们再动设置/账本/状态,等于把客户刚连上的通路拆掉。
      // 所以每次恢复动作前都先看一眼:意图文件里已经是别的会话要连接、或状态文件已由别的守护写过 → 交权,什么都不碰,直接走。
      // 判交接与恢复在同一把跨进程锁里(restoreSettings checkHandover):判完别人 ⛔ 还能插进来接手并被旧快照覆盖
      let recovered = this.restoreSettings({ checkHandover: true })
      if (this.handedOver) { this.exitAfterHandover(); return }
      // 只有「写/读失败」(restore-failed)与「锁被别人占着」值得等着再试;第三方改过的(kept-modified)是定论,重试也不会变,⛔ 空等一分钟。
      const transientFailure = () => this.settingsBusy || loadLedger(this.dataDir).some((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.restoreFailed)
      for (const delay of SHUTDOWN_RESTORE_RETRY_MS) {
        if (recovered || !transientFailure()) break
        this.log(`退出时原设置恢复未完成,${String(delay / 1000)} 秒后再试`)
        await new Promise((resolve) => this.clock.setTimeout(resolve, delay))
        this.fatalStopped = false
        recovered = this.restoreSettings({ checkHandover: true })
        if (this.handedOver) { this.exitAfterHandover(); return }
      }
      // 快速梯子用尽仍是暂时性写失败:守护留下来慢节奏继续还(主进程早已退出,没有别人会做这件事);有上限,到点交给下次启动。
      for (let round = 1; !recovered && transientFailure() && round <= SHUTDOWN_RESTORE_SLOW_ROUNDS; round += 1) {
        this.log(`退出时原设置恢复仍未完成,${String(SHUTDOWN_RESTORE_SLOW_MS / 1000)} 秒后再试(慢节奏第 ${String(round)} 轮)`)
        await new Promise((resolve) => this.clock.setTimeout(resolve, SHUTDOWN_RESTORE_SLOW_MS))
        this.fatalStopped = false
        recovered = this.restoreSettings({ checkHandover: true })
        if (this.handedOver) { this.exitAfterHandover(); return }
      }
      // 收尾写状态也在锁里判一次归属:新守护可能刚在我们还完账后起来
      let finalHandover = false
      try {
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { finalHandover = true; return }
          if (recovered) this.writeStateNow('stopped-restored')
        }, { owner: `shutdown:${this.runId}`, timeoutMs: 5_000 })
      } catch { finalHandover = true } // 锁被别人占着 = 别人在接手,不写状态
      if (finalHandover) { this.exitAfterHandover(); return }
      this.exit(recovered ? 0 : 65)
    })().catch(() => {
      this.writeStateNow('error', { code: 'TUNNEL_RESTORE_INCOMPLETE', message: '通道已停止，原设置恢复未完成，请重新打开工具箱重试恢复' })
      this.exit(65)
    })
  }

  requestShutdown() { this.shutdown() }

  // 恢复权是否已交给别的守护:与崩溃兜底同一规则(recoveryOwnedByOther)。
  recoveryHandedOver() { return recoveryOwnedByOther(this.dataDir, this.runId) }

  exitAfterHandover() {
    this.log('新的守护已接手同一数据目录:本进程不再改设置、账本与状态,直接退出')
    this.exit(0)
  }

  async failLedger(failure) {
    await this.stopConnection()
    this.writeStateNow('error', failure)
    this.exit(65)
  }

  async recordIntent(intent) {
    try {
      appendIntentEntry(this.dataDir, { intent, time: this.clock.now() })
      this.pendingIntentRecord = undefined
      return true
    } catch (error) {
      if (error instanceof SettingsBusyError) {
        // 锁被另一恢复任务占着:意图账目稍后补记(下一次进锁时),⛔ 因此打断后面的停连接/恢复/退出(GPT-6 复核 c53c636 #2)
        this.pendingIntentRecord = intent
        this.log('系统设置锁被占,意图账目稍后补记')
        return true
      }
      if (!(error instanceof LedgerError)) throw error
      await this.failLedger({ code: error.code, message: error.message })
      return false
    }
  }

  // 补记之前因锁忙没记上的意图账目;只在已持锁的段落里调用(可重入,不会再忙)
  flushPendingIntent() {
    const intent = this.pendingIntentRecord
    if (intent === undefined) return
    try { appendIntentEntry(this.dataDir, { intent, time: this.clock.now() }); this.pendingIntentRecord = undefined } catch (error) {
      if (!(error instanceof SettingsBusyError)) throw error
    }
  }

  // 调用方已停连接；恢复未知时不得继续写「已恢复」或自动重连。
  //
  // 恢复**也是写系统代理**,必须持同一把全局写入权(P1)。⛔ 只给 applySettings 加闸:
  // 启动恢复、重连前恢复、停止恢复都会经由 restoreLedger 写回 WinINET,
  // 两套安装目录 + 两个数据目录时仍会同时动系统代理——那正是这次要堵的路径。
  // 拿不到权:保持现值,进可解释的稳定态,⛔ 硬写。
  restoreSettings(options = {}) {
    const right = this.ensureWriteRight()
    if (!right.ok) {
      const conflict = this.writeRightConflict(right)
      this.log(`系统代理写入权不在本进程:本次不还原,保持现值(${conflict.code})`)
      if (!this.exited) this.writeStateNow('error', { code: conflict.code, message: conflict.message })
      return undefined
    }
    try {
      // 归属判定与恢复同一把锁(退出流程用 checkHandover):判完别人 ⛔ 还能插进来接手
      const result = withSettingsLock(this.dataDir, () => {
        if (options.checkHandover && this.recoveryHandedOver()) return 'handed-over'
        this.flushPendingIntent()
        return restoreLedger(this.dataDir, this.adapter)
      }, { owner: `restore:${this.runId}` })
      this.settingsBusy = false
      // 已明确移交给同目录的新守护:设置归它管,权也不该攥在我们手里。
      if (result === 'handed-over') { this.handedOver = true; this.releaseWriteRight(); return undefined }
      if (result.notifyFailed) this.scheduleNotifyRetry()
      if (unrestoredEntries(this.dataDir).length > 0) {
        this.fatalStopped = true
        this.writeStateNow('error', { code: 'TUNNEL_RESTORE_INCOMPLETE', message: '通道已停止，原设置尚未恢复；请重试恢复。其他软件修改的设置会保留' })
        // ⛔ 在这里交权:还欠着未恢复项,系统代理仍是我们的责任,交出去别人也还不了(账本在我们的数据目录)。
        return undefined
      }
      // 设置已经干净地还给客户了 —— 这把权必须交还(P1)。
      // ⛔ 攥着它:常驻守护还活着时,另一份安装会一直被误挡成「有人正在管理网络」。
      // 用户主动断开、授权到期停止、致命停止都经由这里,统一在这一处交还,⛔ 在每个停止点各写一遍(会漏)。
      // 例外是「为了接管而还原」(keepWriteRight),那次还原之后紧接着就要写新设置。
      if (options.keepWriteRight !== true) this.releaseWriteRight()
      return result
    } catch (error) {
      if (error instanceof SettingsBusyError) {
        // 另一进程正在恢复/应用设置:不是失败,稍后再试(⛔ 因等待把恢复责任丢掉、⛔ 当致命)
        this.settingsBusy = true
        this.log('系统设置正被另一恢复任务占用,稍后再试')
        return undefined
      }
      if (!(error instanceof LedgerError)) throw error
      this.writeStateNow('error', { code: error.code, message: error.message })
      this.exit(65)
      return undefined
    }
  }

  clearVerify() {
    if (this.confirmationTimer !== undefined) {
      this.clock.clearTimer(this.confirmationTimer)
      this.confirmationTimer = undefined
    }
    if (this.verifyTimer !== undefined) {
      this.clock.clearTimer(this.verifyTimer)
      this.verifyTimer = undefined
    }
  }

  scheduleTraffic() {
    this.clearTraffic(false)
    if (!this.bridge?.traffic) return
    void this.refreshTraffic()
    this.trafficTimer = this.clock.setInterval(() => { void this.refreshTraffic() }, 2_000)
  }

  refreshTraffic() {
    const bridge = this.bridge
    if (!bridge?.traffic || this.exited || !['connected', 'degraded'].includes(this.state)) return
    const current = bridge.traffic()
    if (this.bridge !== bridge || !Number.isSafeInteger(current.uploadBytes) || !Number.isSafeInteger(current.downloadBytes) ||
        !Number.isSafeInteger(current.observedAt) || current.uploadBytes < 0 || current.downloadBytes < 0 || current.observedAt < 1) return
    if (current.activeStreams !== undefined && (!Number.isSafeInteger(current.activeStreams) || current.activeStreams < 0)) return
    const previous = this.lastTraffic
    const elapsedSeconds = previous && current.observedAt > previous.observedAt ? (current.observedAt - previous.observedAt) / 1000 : 0
    const uploadBytesPerSecond = elapsedSeconds === 0 ? 0 : Math.floor(Math.max(0, current.uploadBytes - previous.uploadBytes) / elapsedSeconds)
    const downloadBytesPerSecond = elapsedSeconds === 0 ? 0 : Math.floor(Math.max(0, current.downloadBytes - previous.downloadBytes) / elapsedSeconds)
    this.lastTraffic = current
    try {
      writeTraffic(this.dataDir, { source: 'local-proxy-entry', uploadBytes: current.uploadBytes, downloadBytes: current.downloadBytes,
        uploadBytesPerSecond, downloadBytesPerSecond, activeStreams: current.activeStreams ?? 0,
        interruptedStreams: this.interruptedStreams, torndownStreams: this.torndownStreams, updatedAt: current.observedAt })
    } catch {
      // 本地汇总遥测只是可选证据，写入失败不得影响已建立的连接或后续重连。
    }
  }

  clearTraffic(remove = true) {
    if (this.trafficTimer !== undefined) {
      this.clock.clearTimer(this.trafficTimer)
      this.trafficTimer = undefined
    }
    this.lastTraffic = undefined
    if (remove) {
      try { rmSync(trafficPath(this.dataDir), { force: true }) } catch { /* Stale telemetry never blocks connection teardown. */ }
    }
  }

  writeStateNow(state, extra = {}) {
    this.state = state
    // 持权期间写出的每一份 state 都盖上本轮令牌:后启动者据此确认「这份状态确实是当前持权者写的」,
    // ⛔ 把上一任留下的旧 state 当成现况。没持权时不盖 —— 那样的 state 本来就不该被当作持权者状态。
    writeState(this.dataDir, { state, runId: this.runId, sessionToken: this.sessionToken,
      intentToken: this.intent?.sessionToken ?? '', bridgePort: this.activeBridgePort(), note: this.optionalNote, code: '', message: '',
      ...(typeof this.writeRightToken === 'string' ? { writeRightToken: this.writeRightToken } : {}), ...extra })
    if (state === 'connected' && Number.isFinite(extra.lastVerifiedAt)) {
      const verified = JSON.stringify({ verifiedAt: extra.lastVerifiedAt })
      writeFileSync(join(this.dataDir, 'connection-verified.json.tmp'), verified, { mode: 0o600 })
      renameSync(join(this.dataDir, 'connection-verified.json.tmp'), join(this.dataDir, 'connection-verified.json'))
    }
  }

  exit(code) {
    if (this.exited) {
      return
    }
    this.exited = true
    // 兜底交还写入权:正常路径已在还原/让路处交还,这里防的是异常退出把权攥走
    // (真崩溃由内核标记 abandoned,接手者能认出来;能走到这里就该干净地交)。
    this.releaseWriteRight()
    if (this.intentTimer !== undefined) this.clock.clearTimer(this.intentTimer)
    if (this.parentTimer !== undefined) this.clock.clearTimer(this.parentTimer)
    if (this.authorizationTimer !== undefined) this.clock.clearTimer(this.authorizationTimer)
    this.clearVerify()
    this.clearTraffic()
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimer(this.reconnectTimer)
    }
    if (this.notifyRetryTimer !== undefined) this.clock.clearTimer(this.notifyRetryTimer)
    this.onExit(code)
  }
}
