// 守护核心(定稿第 2 轮 4/5、第 4 轮定稿 12):独立于 Electron 主进程。
// 职责:持账本执行写入与恢复、意图与实际分离(用户主动断开持久化、守护 ⛔ 拉起)、
// 状态机、五次快速退避后低频同节点恢复、短确认与探测目标故障区分、
// 父进程消失 → 按账本恢复再退出。全部 I/O 经注入的适配器 / 连接器 / bridge / 时钟。
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { CONTROL_CODES } from './connectors.mjs'
import { appendIntentEntry, appendSettingEntry, generateSessionToken, isOptionalSettingService, isSettledSetting, lastIntent, loadLedger, markEntry, pendingSettingEntries, updateSettingEntry, withSettingsLock, assertSettingsLockHeld, SettingsBusyError, ENTRY_STATUS, LedgerError, ledgerFailure } from './ledger.mjs'
import { clearWriteRightOwner, publishWriteRightOwner, readWriteRightOwner, withWriteRight, writeRightFailure } from './write-right-owner.mjs'
import { markNotifyOwed, rebroadcastSettings, restoreLedger, unrestoredEntries, deepEqual } from './restore.mjs'
import { AI_SERVICE_PROBE_URLS, probeDirectReachability, probeExistingProxy } from './vless-connector.mjs'
import { CONNECTION_FLAGS, hexToBlob, readConnectionSettings } from './connection-settings.mjs'
import { NetworkAvailabilityController } from './network-availability-controller.mjs'

// 退出时恢复系统代理写失败(注册表被杀软短暂锁住等)⛔ 直接退出留下指向死端口的代理(发布审查 R1):
// 按这个节奏重试；停止入口仍有未还账目时继续留守，直到还原或明确交给新守护。
export const SHUTDOWN_RESTORE_RETRY_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 20_000, 30_000])
// 快速梯子用尽后的慢节奏(GPT-6 复核 2a19530 #1):主进程 5 秒就退出了,守护是 detached 起的、比主进程活得久,
// 它就是那个「明确的恢复者」。写失败只要还是暂时性的(restore-failed),就每 30 秒再试；
// 慢梯子 60 轮后，停止入口若仍欠恢复则继续留守，不能把死代理留给客户。
export const SHUTDOWN_RESTORE_SLOW_MS = 30_000
export const SHUTDOWN_RESTORE_SLOW_ROUNDS = 60
const RECOVERY_OWNER_PUBLISH_FAILED = 'TUNNEL_RECOVERY_OWNER_PUBLISH_FAILED'
const CONTINUITY_HEARTBEAT_MS = 5 * 60_000
// 连续性留证的 per-key 冷却表上限:超过即先清过期再挤最旧,⛔ 无上限攒 Map(常驻守护按周跑)。
const CONTINUITY_COOLDOWN_KEYS = 32

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
// traffic 空闲心跳(Phase 1 ②):内容无变化时也按这个节奏补一笔,保住 UI 速率行的新鲜窗口
// (status-service trafficSummary 45s 门槛,⛔ 两侧只改一侧)。观察节奏(2s)与它无关。
const TRAFFIC_HEARTBEAT_MS = 30_000
// 设置锁被别的进程占着(旧守护慢恢复、别的窗口在应用设置)时,「检查」类拿锁用短上限:
// 复查撞锁是可等待的常态事件,⛔ 拿默认 5 秒去撞——每 2 秒一次 5 秒自旋等于把主线程大半时间
// 又冻回去(甲-5 刚拆掉的形态)。撞锁后按 SETTINGS_BUSY_RETRY_MS 一拍顺延,锁放开即补做。
const SETTINGS_BUSY_LOCK_WAIT_MS = 250
const SETTINGS_BUSY_RETRY_MS = 2_000
// 设置已还原、但原生席位交还还没确认时，保留同一 handle/CAS 身份后台再试。
// 节奏有上限，但不限次数：守护还活着就不能因一次短暂失败永久占着 live-PID 席位。
const WRITE_RIGHT_RELEASE_RETRY_MS = 5_000

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
  'TUNNEL_PROXY_AUTH_REQUIRED',
  'TUNNEL_PROXY_HELPER_FAILED',
  // N-55 的有界夺回到顶或恢复合同不可证实后，停止本地承接并按账本保留外部现值；
  // 这不是“第二次争用就停”，而是已经耗尽本意图允许的有证据动作。
  'TUNNEL_AVAILABILITY_RECLAIM_LIMIT',
  'TUNNEL_AVAILABILITY_OBJECT_IDENTITY_MISSING',
  'TUNNEL_AVAILABILITY_POLICY_LOCKED',
  'TUNNEL_AVAILABILITY_RECOVERY_CONTRACT_MISSING',
  'TUNNEL_AVAILABILITY_PROCESS_OWNERSHIP_UNPROVEN',
  // 另一份来信占着入口端口:换端口重试只会变成两份来信抢同一份系统代理,等客户处理那一份。
  'TUNNEL_PEER_LAIXIN_RUNNING'
])

/** N-55:同一连接意图下可证实的夺回轮数上限。按轮而非按项计；到顶后保留外部现值，
 * 明示证据限制，等待新意图或新路径证据，绝不无限抢写。 */
const SETTINGS_CONTEST_LIMIT = 3

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

function recoveryOwnerPath(dataDir) {
  return join(dataDir, 'recovery-owner.json')
}

function readRecoveryOwner(dataDir) {
  try {
    const owner = JSON.parse(readFileSync(recoveryOwnerPath(dataDir), 'utf8'))
    if (typeof owner?.runId !== 'string' || owner.runId === '') return undefined
    return {
      runId: owner.runId,
      // 旧版无代次令牌只能作为接管基线，重写时间戳无法证明它比本守护更新。
      generation: Number.isSafeInteger(owner.generation) && owner.generation >= 0 ? owner.generation : 0
    }
  } catch { return undefined }
}

function observeRecoveryOwnership(dataDir) {
  const owner = readRecoveryOwner(dataDir)
  return {
    generation: owner?.generation ?? 0
  }
}

// 新守护完成初始恢复时，在 settings lock 内原子发布单调代次。崩溃在 rename 前只留旧代，
// rename 后才算可见接管；旧 state 随后即使被写回，也不能把已发布的代次回退。
function publishRecoveryOwner(dataDir, runId, observedGeneration = 0) {
  if (typeof runId !== 'string' || runId === '') return observedGeneration
  assertSettingsLockHeld(dataDir)
  const current = readRecoveryOwner(dataDir)
  const generation = Math.max(observedGeneration, current?.generation ?? 0) + 1
  const path = recoveryOwnerPath(dataDir)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ runId, generation, claimedAt: Date.now() })}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return generation
}

export function trafficPath(dataDir) {
  return join(dataDir, 'traffic.json')
}

// 意图文件读取的记忆化(仿 ledger.loadLedgerCached):500ms 轮询只在 mtime+size 变化时才真正
// 读盘解析。⛔ 缓存「读失败」与「损坏」结果——损坏改名、下个 tick 重试的语义必须保留(不入缓存,
// 下次调用自然重读)。意图文件由主进程以 tmp+rename 原子写入,签名变化即失效;rename 后的 corrupt
// 分支本守护只改名不写回,缓存键随 stat 变化/缺失自洽。
const intentCache = new Map()
let intentDiskReadCount = 0

/** 诊断计数:readIntentChecked 真正读盘解析意图文件的次数(供测试与巡检断言)。 */
export function intentDiskReads() {
  return intentDiskReadCount
}

export function readIntentChecked(dataDir) {
  const path = intentPath(dataDir)
  let stat
  try { stat = lstatSync(path) } catch { stat = undefined }
  const key = stat === undefined ? 'missing' : `${stat.mtimeMs}:${stat.size}`
  const cached = intentCache.get(dataDir)
  if (cached !== undefined && cached.key === key) return cached.result
  intentDiskReadCount += 1
  if (stat === undefined) {
    const result = { intent: undefined, corrupted: false }
    intentCache.set(dataDir, { key, result })
    return result
  }
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    // 瞬时读失败(杀软/同步盘占用)⛔ 入缓存:下个 tick 必须再试盘。
    intentCache.delete(dataDir)
    return { intent: undefined, corrupted: false }
  }
  try {
    const result = { intent: JSON.parse(source), corrupted: false }
    intentCache.set(dataDir, { key, result })
    return result
  } catch {
    // intent.json 被杀软/同步盘弄脏(收敛包3·件1):改名留证,当「无意图」处理,
    // ⛔ 让 500ms 轮询把守护打死。
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* 改不动就下个 tick 再试 */ }
    // 损坏结果 ⛔ 入缓存:改名失败时下个 tick 还要再试改名,缓存会把重试冻死。
    intentCache.delete(dataDir)
    return { intent: undefined, corrupted: true }
  }
}

export function readIntent(dataDir) {
  return readIntentChecked(dataDir).intent
}

// 同一数据目录的恢复权规则(全部恢复入口共用:退出流程、崩溃兜底):只认本守护启动后、
// 在 settings lock 内发布的更高 generation。启动时已经存在的旧 runId/旧代只是基线，不能让恢复责任凭空消失。
// 旧版本没有 generation 时，令牌时间戳和 state 变化都无法分辨是旧守护晚落盘，
// 还是新的恢复者接手，不能据此卸下恢复责任；只认启动后发布的更高代次。
// ⛔ 把「意图文件里有别的会话要连接」当成已交接(GPT-6 复核 3d8d51f #1):那只是准备连接,新守护可能根本没起来。
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

export function recoveryOwnedByOther(dataDir, runId, observed) {
  if (typeof runId !== 'string' || runId === '') return false
  const owner = readRecoveryOwner(dataDir)
  if (owner !== undefined) {
    if (observed === undefined) return false // 没有启动基线，无法证明哪一代更新。
    if (owner.runId === runId) return false
    return owner.generation > observed.generation
  }
  return false // owner 令牌消失/损坏，或旧版根本未写令牌，都不是已交接证据。
}

// 顶层兜底(收敛包3·件1):未捕获异常/未处理的 Promise 拒绝 → 先按账本恢复系统代理、
// 写错误状态,再退出。⛔ 代理悬空着死让用户断网。
// 恢复权同一规则:别的守护已发布更高 owner 代次 → 本进程的兜底只退出,⛔ 把新会话的设置还掉、账结掉、状态盖掉。
export function installCrashBailout({ dataDir, adapterOf, runId = '', exit = (code) => process.exit(code), log = () => undefined }) {
  let handled = false
  const recoveryObservedAtInstall = observeRecoveryOwnership(dataDir)
  const handler = (origin) => (reason) => {
    if (handled) return
    handled = true
    log(`未捕获${origin === 'uncaughtException' ? '异常' : '的 Promise 拒绝'},先恢复系统代理再退出:${reason instanceof Error ? reason.message : String(reason)}`)
    // 「已恢复」以账本结算为准(发布审查 R5):restoreLedger 不抛不等于都还回去了。写失败先立刻再试一次。
    // 归属判定与恢复在同一把跨进程锁里做(⛔ 判完别人再插进来);锁等不到就不动设置,留给下一个恢复者。
    let restored = false
    let handedOver = false
    let writeRightError
    try {
      const adapter = adapterOf()
      // 兜底恢复也是写系统代理(P1):没拿到全局写入权就一个字节都不碰——
      // 此刻系统代理归持权那一方管,我们崩了不等于可以去盖它的设置。
      const guarded = withWriteRight(adapter, () => {
        withSettingsLock(dataDir, () => {
          if (recoveryOwnedByOther(dataDir, runId, recoveryObservedAtInstall)) { handedOver = true; return }
          let result = restoreLedger(dataDir, adapter)
          if (result.failed.length > 0) result = restoreLedger(dataDir, adapter)
          restored = result.failed.length === 0 && unrestoredEntries(dataDir).length === 0
        }, { owner: `crash:${runId}`, timeoutMs: 5_000 })
      }, log)
      if (!guarded.ok) { writeRightError = writeRightFailure(guarded.reason); restored = false }
    } catch { /* 账本/适配器/锁不可用也要退出,不能卡死在兜底里 */ }
    try {
      // 拿不到全局写权时也可能是同目录的新守护已经接手；最终状态与恢复权在同一把锁内再核对。
      // 锁忙或状态写失败就保留盘上原状态，⛔ 旧崩溃消息覆盖新 connected。
      withSettingsLock(dataDir, () => {
        if (handedOver || recoveryOwnedByOther(dataDir, runId, recoveryObservedAtInstall)) { handedOver = true; return }
        writeState(dataDir, {
          state: 'error',
          code: 'DAEMON_CRASH',
          message: restored
            ? '守护异常退出，已恢复原设置；请重新连接'
            : writeRightError
              ? `守护异常退出；${writeRightError.message}`
              : '守护异常退出，原设置恢复未完成，请重新打开工具箱重试'
        })
      }, { owner: `crash-state:${runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
    } catch { /* 锁忙或状态写不进时，保留原状态并退出 */ }
    if (handedOver) log('同一数据目录已由别的守护接手:不碰设置与状态,直接退出')
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

// 甲-6:守护失败路径留证的形状——错误名/码＋截断首行。⛔ 整段转储(可能带路径长文);
// 守护日志进诊断包时逐行过 redact(report-bundle),首行截断让它在该闸内也保持短。
function errorNameOf(error) {
  return error !== null && typeof error === 'object' && typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
}

function firstLineOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0].slice(0, 160)
}

// N-27:中断时长给人话(日志与恢复事件共用)。⛔ 毫秒裸数:客服与客户读的是「断了多久」。
function outageWords(outageMs) {
  const seconds = Math.round(outageMs / 1000)
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
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
    // 交接只认「本守护启动后新发布」的代次；盘上永久留着的旧 runId 只是基线，不是新交接。
    this.recoveryOwnershipObserved = observeRecoveryOwnership(dataDir)
    this.recoveryOwnerPublishFailed = false
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
    this.continuityEvidence = options.continuityEvidence === true
    this.readContinuityFaces = options.readContinuityFaces
    this.continuityCooldowns = new Map()
    this.continuityProbeActive = false
    this.continuityPending = undefined

    this.intent = undefined
    this.connector = undefined
    this.bridge = undefined
    // bridge 的 config/PID 文件按 dataDir 共用。所有关闭进同一串行队列；失败的代次留在集合里，
    // 下次显式操作必须重试收完才能写新一代，既不安全放行、也不让一次 reject 永久毒化队列。
    this.bridgeTeardownTail = Promise.resolve()
    this.pendingBridgeTeardowns = new Map()
    this.failedBridgeTeardowns = new Set()
    this.pendingConnectorStops = new Set()
    this.connectorStopFailed = false
    this.settingsApplied = false
    this.state = 'idle'
    this.sessionToken = ''
    this.reconnectAttempts = 0
    this.reconnectTimer = undefined
    this.verifyTimer = undefined
    this.trafficTimer = undefined
    this.lastTraffic = undefined
    this.lastTrafficWritten = undefined
    this.confirmationTimer = undefined
    this.settingsBusyTimer = undefined
    this.recoveryOwnerRetryTimer = undefined
    this.lastVerification = undefined
    this.verifyingConnector = undefined
    this.transitioning = false
    this.intentTransitionGeneration = 0
    this.availability = new NetworkAvailabilityController({ now: () => this.clock.now(), maxReclaims: SETTINGS_CONTEST_LIMIT })
    this.availabilityIntentKey = undefined
    this.availabilityOperation = undefined
    this.availabilityReclaimOperation = undefined
    this.exited = false
    this.authorizationStopped = false
    this.authorizationTimer = undefined
    this.disconnectingAuthorizationIntent = undefined
    this.fatalStopped = false
    this.reconnectInFlight = false
    this.reconnectEpoch = 0
    this.lastEventRecoveryAt = undefined
    // N-27 恢复知情:故障片段 = 「已连/待确认 → 丢失」到「重连接上」之间。记住起点才算得出中断时长,
    // 恢复成功后把待展示事件并进 state,桌面读到弹一次系统通知。⛔ UUID/Key/网址/节点信息——只有次数与时长。
    this.reconnectEpisodeStartedAt = undefined
    this.reconnectTries = 0
    this.recoveryNotice = undefined
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
    this.writeRightReleaseTimer = undefined
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
    this.residentStopping = undefined
    this.residentStopIncomplete = false
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

  validateExistingProxy(candidate) {
    this.adapter.validateExistingProxy?.(candidate)
  }

  materializeExistingProxy(candidate) {
    return this.adapter.materializeExistingProxy?.(candidate) ?? candidate
  }

  /** N-55 的代次只跟随客户连接意图；同一意图的复验/夺回不能重新给旧异步结果开绿灯。 */
  availabilityIntentFor(intent = this.intent) {
    const key = [intent?.desired, intent?.sessionToken, intent?.updatedAt].map((value) => String(value ?? '')).join('|')
    if (this.availabilityIntentKey !== key) {
      this.availabilityIntentKey = key
      this.availabilityOperation = undefined
      // 旧意图的夺回不能借新意图继续写入；新轮必须重新取快照、租约与路径证据。
      this.availabilityReclaimOperation = undefined
      return this.availability.beginIntent({ id: key || 'no-intent' })
    }
    return this.availability.activeIntent
  }

  /** state.json 仅写客户可读的阶段与受控码；对象、快照、租约只留在控制器/账本，绝不外泄。 */
  availabilityView() {
    const current = this.availability.state
    const activeIntent = this.availability.activeIntent
    if (activeIntent === undefined || current.intentGeneration !== activeIntent.generation) return undefined
    const operation = this.availability.activeOperation === undefined
      ? undefined : this.availability.operations.get(this.availability.activeOperation)
    // beginIntent() 的 examining 只是内部基线。只有实际执行中的当前动作，才可以覆盖稳定的
    // 停止/错误文案；受限结论则必须保留，让客户看得到已证实的原因。
    const executing = this.availability.isCurrent(operation) &&
      (['reusing', 'taking-over', 'reclaiming', 'recovering'].includes(current.status) ||
        (current.status === 'examining' && this.state === 'connecting'))
    // 失败后的恢复不再宣告“已恢复”覆盖错误，但把原受限码带回状态层，供它保留真正的失败原因。
    const recoveredFailure = current.status === 'recovered' && typeof current.code === 'string' && this.state === 'error'
    // terminal 状态仍可供账本/守护回归观察，但 active:false 使状态层绝不会用它覆盖稳定的客户文案。
    const terminal = current.status === 'connected' || current.status === 'recovered'
    const active = executing || current.status === 'limited' || recoveredFailure
    if (!active && !terminal) return undefined
    return {
      active,
      status: current.status,
      action: current.action,
      ...(typeof current.code === 'string' ? { code: current.code.startsWith('TUNNEL_') ? current.code : `TUNNEL_AVAILABILITY_${current.code}` } : {}),
      intentGeneration: current.intentGeneration
    }
  }

  /** 端口身份等证据由真实适配器形成；控制器只把它收敛成当前意图的受控限制，绝不结束未知 PID。 */
  recordAvailabilityRestriction(restriction, { conflict, path } = {}) {
    try {
      this.beginAvailabilityAction('inspect', { restriction, conflict, path })
    } catch (error) {
      if (error?.code === `TUNNEL_AVAILABILITY_${restriction}`) return
      throw error
    }
  }

  availabilityContext(refs = [], path) {
    const intent = this.availabilityIntentFor()
    const items = refs.map((ref) => `${String(ref.service)}/${String(ref.item)}`).sort().join(',') || 'network-path'
    const route = path === undefined ? this.currentPathIdentity() ?? { id: 'unresolved', kind: 'unresolved' } : undefined
    return {
      intent,
      conflict: { id: `settings:${items}`, kind: 'managed-settings' },
      // 路径身份不含 URL、节点、PAC 内容或进程信息；代次与当前 bridge 变化都会使旧结果失效。
      path: path ?? { id: `path:${String(this.activeBridgePort() ?? 'none')}:${String(this.sessionToken ?? '')}:${route.kind}:${route.id}`, target: 'configured-ai-target' },
      lease: { id: String(this.writeRightToken ?? `${this.runId}:${this.sessionToken}`), owner: this.runId }
    }
  }

  currentPathIdentity() {
    // 平台能证明活动服务/系统代理路径时把它纳入身份；读不到不猜路径名，仍只对有快照和恢复合同的受管项动作。
    let route = { id: 'unresolved', kind: 'unresolved' }
    try {
      const observed = this.adapter.currentPathIdentity?.()
      if (typeof observed?.id === 'string' && observed.id !== '') route = observed
    } catch { /* handled below */ }
    // A reuse result has no setting snapshot to fall back to. Do not turn this
    // sentinel into a fake stable identity: a missing/failed path read means
    // the direct or existing-proxy result cannot be attributed safely.
    return route.id === 'unresolved' ? undefined : route
  }

  existingAvailabilityContext(candidate) {
    const endpoint = candidate?.kind === 'direct'
      ? 'direct'
      : `${String(candidate?.kind ?? '')}:${String(candidate?.source ?? '')}:${String(candidate?.host ?? candidate?.url ?? '')}:${String(candidate?.port ?? '')}`
    const route = this.currentPathIdentity()
    // 复用 HTTP/SOCKS 时，系统代理本身的完整端点就是可二次读取的冲突对象；旧平台适配器
    // 尚未提供默认路由身份也不应把“代理不可达”错误改造成“无合同”。直连则没有这种对象，
    // 仍必须取得真实路径身份才可复用。
    const proxyEndpoint = ['http', 'socks'].includes(candidate?.kind) &&
      typeof candidate?.host === 'string' && candidate.host !== '' && Number.isInteger(candidate?.port) && candidate.port > 0
      ? `existing-proxy:${String(candidate.kind)}:${candidate.host}:${String(candidate.port)}` : ''
    return {
      conflict: { id: `existing:${endpoint}`, kind: String(candidate?.kind ?? 'unknown') },
      // Direct reuse has no host/port to distinguish a VPN/TUN/default-route
      // switch. Bind it to the same platform path identity as managed writes.
      path: { id: route === undefined ? proxyEndpoint : `existing-path:${endpoint}:${route.kind}:${route.id}`, target: 'configured-ai-target' }
    }
  }

  beginAvailabilityAction(action, { refs = [], snapshot, writtenValue, restriction, conflict, path } = {}) {
    const context = this.availabilityContext(refs, path)
    const operation = this.availability.start({ action, ...context, conflict: conflict ?? context.conflict, path: path ?? context.path,
      snapshot, writtenValue, restriction })
    if (operation.blocked) {
      throw Object.assign(new Error('当前网络设置缺少可验证的自动处理合同'), { code: `TUNNEL_AVAILABILITY_${operation.code}` })
    }
    this.availabilityOperation = operation
    // 每个动作一开始就落安全阶段，不能等下一次连接状态写入才让页面知道正在复用/接管/夺回/恢复。
    // 这是旁路状态；它失败不得改变已取得的设置租约或网络动作。
    try { this.writeStateNow(this.state) } catch { /* 状态写入不会取消已受守卫的网络动作 */ }
    return operation
  }

  completeAvailabilityAction(operation, { readbackMatches, targetReachable, conflict, path, allowFailure = false } = {}) {
    if (operation === undefined) return true
    const currentPath = path ?? this.availabilityContext().path
    const result = this.availability.complete(operation, { readbackMatches, targetReachable, conflict: conflict ?? operation.conflict, path: currentPath })
    if (!result.ok && !allowFailure) throw Object.assign(new Error('网络设置的证据在操作期间发生变化'), { code: `TUNNEL_AVAILABILITY_${result.code}` })
    return result.ok
  }

  failAvailabilityAction(operation, code) {
    if (operation === undefined) return false
    return this.availability.fail(operation, code).ok
  }

  finishFailedReclaim(error) {
    const operation = this.availabilityReclaimOperation
    if (operation === undefined) return
    const code = error?.code === 'TUNNEL_SETTINGS_NOT_APPLIED' ? 'READBACK_MISMATCH'
      : error?.code === 'TUNNEL_AVAILABILITY_WRITE_FAILED' ? 'WRITE_FAILED'
      : error?.code === CONTROL_CODES.probeUnavailable ? 'TARGET_UNCONFIRMED'
        : error?.code === 'TUNNEL_AVAILABILITY_EVIDENCE_CHANGED' ? 'EVIDENCE_CHANGED' : 'TARGET_UNREACHABLE'
    this.failAvailabilityAction(operation, code)
    // 下一轮若仍有新外部写入，必须以新对象和新快照另起动作；不复用失败轮的租约。
    this.availabilityReclaimOperation = undefined
  }

  // 系统设置变更通知欠着:守护每 5 秒补发一次,最多 6 次;发成即止。⛔ 因为通知把恢复说成失败。
  scheduleNotifyRetry() {
    if (this.exited || this.notifyRetryTimer !== undefined) return
    this.notifyRetries = 0
    const tick = () => {
      this.notifyRetryTimer = undefined
      if (this.exited) return
      let notified = false
      try {
        notified = withSettingsLock(this.dataDir, () => {
          this.assertRecoveryOwnerLocked()
          return rebroadcastSettings(this.dataDir, this.adapter)
        }, { owner: `notify:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch (error) {
        if (this.exited) return
        if (!(error instanceof SettingsBusyError)) throw error
      }
      if (notified) { this.log('系统设置变更通知已补发'); return }
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
    this.assertRecoveryOwnerLocked()
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
    // 甲-2 返工:启动梯子的意图基线(若本轮有启动恢复)。此刻 this.intent 还没装进来,先留空,
    // 读入启动意图后回填(见下);基线一换(this.intent 被意图轮询换成新对象 = 客户点了连接或断开),
    // 梯子必须停——新意图自己的 connect()/restoreAfterDisconnect 接手恢复与写入,⛔ 醒来再
    // restoreSettings 把新连接写下的 ProxyServer 当旧账删掉。意图没变(引用相同)时照旧还账、照旧接续。
    const startupLadder = { intent: undefined }
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    // 任一进程再次启动时先读账本:有未恢复项先按规则处理,再做别的(判据 3③)。
    const startupRestoreNeeded = pendingSettingEntries(this.dataDir).length > 0
    if (startupRestoreNeeded) {
      // 甲-2:启动恢复接上断开/授权到期/退出同款的恢复重试梯子。基线是裸调一次 restoreSettings,
      // 杀软短暂锁注册表这类暂时性失败一次就置 recoveryBlocked 等客户点「重试恢复原设置」——
      // 而重启后守护被系统拉起、客户根本没开界面的无人值守窗口正是这条,不点永远不好。
      // 梯子**后台跑**,⛔ 堵住意图轮询的安装(上一轮修过的「恢复失败守护失聪」回归就靠轮询在,
      // 内联等梯子会把它再踩出来)。落定前不连接:recoveryBlocked 守住下面的自动接续与 connect(),
      // 连接动作里的 restoreSettings 复查是兜底。
      // 构造时已记下上一任 owner 作为基线；启动恢复可接管旧代，
      // 但等待期间若有更高代次发布，后续写入仍必须让位。
      recoveryBlocked = true
      void this.restoreWithRetryLadder('启动恢复未完成', {
        claimRecovery: true,
        shouldContinue: () => !this.exited && this.shutdownTask === undefined && this.intent === startupLadder.intent
      }).then(async (recovered) => {
        if (this.exited) return
        if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
        if (!recovered) {
          // 恢复没做完就 ⛔ 继续连接(P1):connect() 开头会把 fatalStopped 清掉,于是在**没还干净的设置**上
          // 又写一层——退出时再也还不回客户原来的样子。判据用「恢复是否成功」,⛔ 用 pendingSettingEntries:
          // 还原写失败的条目会转成 restore-failed,不再计入 pending,那条判据拦不住这一幕。
          //
          // ⛔ 在这里 return(第二轮 P1):那样意图轮询还没装,而外层 keepalive 让进程继续活着、
          // 监管器又认为守护在跑 —— 客户点「重新连接」只改了 intent 文件,守护永远不会读它,
          // 界面卡在「连接中」,客户只能退出重开工具箱。改成:本轮不连,但**照常装上轮询**,
          // 客户显式重试时 tickIntent 接得住,connect() 里会再试一次恢复。
          this.log('启动恢复未完成:本次不建立连接,继续监听意图等待客户重试')
          return
        }
        this.log(`启动恢复:已恢复 ${recovered.restored.length} 项`)
        // 梯子落定后按意图落定状态:要连就现在接上(⛔ 等客户再点一次);不连就把待命状态落盘。
        // 这两个出口都归这里;run() 尾段看见 startupRestoreNeeded 一律不动笔(⛔ 抢写盖掉在途连接)。
        // (落定后 ⛔ 回写 recoveryBlocked:它是 run() 的局部量,尾段已过,读了也没人看。)
        if (this.shutdownTask !== undefined) return
        if (this.intent?.desired === 'connected' && this.state !== 'connected' && this.state !== 'degraded') {
          void this.connect().catch(() => this.requestShutdown())
        } else if (this.intent?.desired !== 'connected' && unrestoredEntries(this.dataDir).length === 0) {
          await this.finalizeAfterRestored(startupLadder.intent, () => {
            this.writeStateNow(this.intent?.desired === 'user-disconnected' ? 'stopped-restored' : 'idle')
          })
        }
      }).catch((error) => {
        // owner 失败由梯子消化；其余意外异常必须重新抛成 unhandled rejection，才能真正进入顶层崩溃兜底。
        // ⛔ 只记日志后吞掉：那会既不再重试，也不触发恢复+非零退出。
        if (!this.exited) this.log('启动恢复的重试中断')
        throw error
      })
    }
    const persistedIntent = lastIntent(this.dataDir)
    const { intent: fileIntent, corrupted } = readIntentChecked(this.dataDir)
    this.intent = fileIntent ?? (persistedIntent === undefined ? undefined : { desired: persistedIntent })
    this.availabilityIntentFor(this.intent)
    // 启动梯子的意图基线回填:从此刻起,意图轮询每次换新意图对象都会让梯子在下一次醒来复查时停下。
    startupLadder.intent = this.intent
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
    if (this.intent?.desired === 'connected' && !recoveryBlocked && !startupRestoreNeeded) {
      // startupRestoreNeeded 为真时,接续归上面的梯子落定回调独有(⛔ 两处各点一次火 = 双连接)。
      await this.connect()
    } else if (this.intent?.desired === 'shutdown') {
      this.shutdown()
      return
    } else if (!recoveryBlocked && !startupRestoreNeeded) {
      // 启动梯子在场的轮次,idle 落笔也归梯子的落定回调——⛔ 这里抢着写 idle 盖掉它正在进行的连接。
      if (unrestoredEntries(this.dataDir).length === 0) this.writeStateNow(this.intent?.desired === 'user-disconnected' ? 'stopped-restored' : 'idle')
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
    // 旧断开可能仍在等待连接器退出；新连接会先按账本恢复，再建立自己的通道。
    if (this.transitioning && next.desired === 'connected' && this.intent?.desired !== 'user-disconnected') return
    this.transitioning = true
    const generation = ++this.intentTransitionGeneration
    void this.applyIntent(next).catch((error) => {
      // 甲-6 同款留证:错误名+截断首行。⛔ 整段吞掉——随后 requestShutdown 很快退出,日志是唯一第一现场。
      this.log(`意图切换中断[${errorNameOf(error)}]:${firstLineOf(error)}`)
      if (!this.exited && this.intent === next) this.requestShutdown()
    }).finally(() => {
      if (this.intentTransitionGeneration === generation) this.transitioning = false
    })
  }

  authorizationCode(intent = this.intent) {
    const authorization = intent?.authorization
    // Loopback probes are test-only connectors. Production intents must carry
    // the deadline from the package already verified by the main process.
    if (authorization === undefined && intent?.connector?.kind === 'loopback-probe') return undefined
    if (!authorization || typeof authorization.id !== 'string' || !authorization.id ||
        !Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= 0) return 'TUNNEL_AUTHORIZATION_INVALID'
    if (authorization.expiresAt <= this.clock.now()) return 'TUNNEL_AUTHORIZATION_EXPIRED'
    return undefined
  }

  tickAuthorization() {
    if (this.exited || this.authorizationStopped) return
    // 主动断开为还原代理短暂保留通道，但不能因此延长原授权。
    const intent = this.intent?.desired === 'connected' ? this.intent
      : this.intent?.desired === 'user-disconnected' && this.connector !== undefined ? this.disconnectingAuthorizationIntent : undefined
    if (intent === undefined) return
    const code = this.authorizationCode(intent)
    if (code) void this.stopForAuthorization(code)
  }

  async stopForAuthorization(code) {
    if (this.authorizationStopped || this.exited) return
    const stoppedIntent = this.intent
    this.authorizationStopped = true
    this.state = 'error'
    // 旧桥接/连接器可能卡在退出；先并行还原代理，不能等死端口收尾后才救网络。
    const stopping = this.stopConnection().then(() => true, () => false)
    this.watchStalledBridgeTeardown()
    // 同一重试梯子(退出路径同款):恢复失败 ⛔ 一次就走——整机断网正等着这套设置还回去。
    await this.restoreAfterAuthorization(code, stoppedIntent, stopping).catch(() => {
      if (!this.exited && this.intent === stoppedIntent) {
        this.log('授权停止后的恢复或最终状态重试中断，交给下一次启动继续处理')
        this.exit(65)
      }
    })
  }

  /** 断开/授权到期/退出共用的恢复重试梯子:中继已关而恢复未完成时,代理还指着死端口就是整机断网,
   *  ⛔ 一次失败丢掉恢复责任。只有「写/读失败」(restore-failed)与「锁被别人占着」是暂时性的,按快速梯子
   *  →慢速梯子的节奏重试;第三方改过的(kept-modified)在恢复时已结成 preserved 终态,不会把梯子带进空等;
   *  写权在别的进程手里也不是暂时性(另一份安装接管着),restoreSettings 自会写明真因并就地放弃。
   *  shouldContinue 在每次再试前问调用方(意图已变/已交接/已退出就停);甲-2 返工:**每一格醒来后、
   *  执行恢复前也要再问一次**——睡的那一格里客户可能已经点了连接/断开,⛔ 醒来不看就把新连接写下的
   *  设置当旧账还一遍(它恢复的正是活连接刚记的账,ProxyServer 当场被删,直到下个复验周期才写回)。 */
  async restoreWithRetryLadder(label, { checkHandover = false, keepFatalStopped = false, claimRecovery = false, keepWriteRight = false, stayUntilRestored = false, timeoutMs, shouldContinue = () => true } = {}) {
    if (!shouldContinue()) return false
    let recovered = this.restoreSettings({ checkHandover, claimRecovery, keepWriteRight, timeoutMs })
    const transientFailure = () => this.settingsBusy || (claimRecovery && this.recoveryOwnerPublishFailed) ||
      loadLedger(this.dataDir).some((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.restoreFailed)
    for (const delay of SHUTDOWN_RESTORE_RETRY_MS) {
      if (recovered || !transientFailure() || !shouldContinue()) break
      this.log(`${label},${String(delay / 1000)} 秒后再试`)
      await new Promise((resolve) => this.clock.setTimeout(resolve, delay))
      if (!shouldContinue()) break
      if (!keepFatalStopped) this.fatalStopped = false
      recovered = this.restoreSettings({ checkHandover, claimRecovery, keepWriteRight, timeoutMs })
    }
    // 快速梯子用尽仍是暂时性写失败:留下来慢节奏继续还。
    for (let round = 1; !recovered && transientFailure() && round <= SHUTDOWN_RESTORE_SLOW_ROUNDS && shouldContinue(); round += 1) {
      this.log(`${label},${String(SHUTDOWN_RESTORE_SLOW_MS / 1000)} 秒后再试(慢节奏第 ${String(round)} 轮)`)
      await new Promise((resolve) => this.clock.setTimeout(resolve, SHUTDOWN_RESTORE_SLOW_MS))
      if (!shouldContinue()) break
      if (!keepFatalStopped) this.fatalStopped = false
      recovered = this.restoreSettings({ checkHandover, claimRecovery, keepWriteRight, timeoutMs })
    }
    // 停止入口仍有未还账目时，旧守护就是恢复责任人；梯子耗尽也不能留下死代理退出。
    while (stayUntilRestored && !recovered && shouldContinue() && unrestoredEntries(this.dataDir).some((entry) =>
      entry.status === ENTRY_STATUS.applied || entry.status === ENTRY_STATUS.restoreFailed)) {
      this.log(`${label},继续留守重试`)
      await new Promise((resolve) => this.clock.setTimeout(resolve, SHUTDOWN_RESTORE_SLOW_MS))
      if (!shouldContinue()) break
      if (!keepFatalStopped) this.fatalStopped = false
      recovered = this.restoreSettings({ checkHandover, claimRecovery, keepWriteRight, timeoutMs })
    }
    return recovered
  }

  async restoreAfterDisconnect(intent) {
    const authorizationStopped = this.authorizationStopped
    const recovered = await this.restoreWithRetryLadder('断开时原设置恢复未完成', {
      checkHandover: true,
      stayUntilRestored: true,
      shouldContinue: () => this.intent === intent && !this.exited && !this.handedOver && this.authorizationStopped === authorizationStopped
    })
    if (this.handedOver) { this.exitAfterHandover(); return }
    if (!recovered || this.intent !== intent || this.exited || this.handedOver || this.authorizationStopped !== authorizationStopped) return
    // 主动断开先还设置，再关活通道；恢复暂败时不能留下指向死端口的代理。
    const stopping = this.stopConnection()
    this.watchStalledBridgeTeardown()
    try {
      if (!await this.waitForStop(stopping)) throw new Error('TUNNEL_STOP_INCOMPLETE')
    } catch {
      if (this.handedOver) { this.exitAfterHandover(); return }
      if (this.exited || (this.intent !== intent && this.pendingBridgeTeardowns.size === 0)) return
      this.writeStateNow('error', { code: 'TUNNEL_STOP_INCOMPLETE',
        message: this.intent === intent
          ? '原网络设置已恢复，但后台通道未能停止；正在重启网络守护完成清理'
          : '旧网络通道未能停止，新连接正等待收尾；正在重启网络守护并重新连接' })
      this.exit(65)
      return
    }
    await this.finalizeAfterRestored(intent, () => this.writeStateNow('stopped-restored'))
  }

  async restoreAfterAuthorization(code, stoppedIntent, stopping = Promise.resolve(true)) {
    const recovered = await this.restoreWithRetryLadder('授权停止后原设置恢复未完成', {
      checkHandover: true,
      stayUntilRestored: true,
      shouldContinue: () => !this.exited && !this.handedOver && this.intent === stoppedIntent
    })
    if (this.handedOver) { this.exitAfterHandover(); return }
    // 授权到期场景意图仍是 connected(到期的只是授权,不是客户的意愿),⛔ 用 desired 判断;
    // 认「意图对象没换」:客户换了新意图(续费后重连)时由连接流程写状态,才不用旧授权的 error 覆盖。
    if (!recovered || this.exited || this.handedOver || this.intent !== stoppedIntent) return
    try {
      const stopped = await this.waitForStop(stopping)
      if (!stopped) throw new Error('TUNNEL_STOP_INCOMPLETE')
    } catch {
      if (this.handedOver) { this.exitAfterHandover(); return }
      if (this.exited || (this.intent !== stoppedIntent && this.pendingBridgeTeardowns.size === 0)) return
      this.writeStateNow('error', { code: 'TUNNEL_STOP_INCOMPLETE',
        message: this.intent === stoppedIntent
          ? '网络授权已停止，原网络设置已恢复，但后台通道未能停止；正在重启网络守护完成清理'
          : '旧网络通道未能停止，新连接正等待收尾；正在重启网络守护并重新连接' })
      this.exit(65)
      return
    }
    await this.finalizeAfterRestored(stoppedIntent, () => stoppedIntent?.desired === 'user-disconnected'
      ? this.writeStateNow('stopped-restored') : this.writeStateNow('error', { code, message: code === 'TUNNEL_AUTHORIZATION_EXPIRED'
      ? '网络授权已到期，已断开通道；请查看有效套餐或更新来信配置'
      : '网络授权期限缺失或无效，请重新连接或更新来信配置' }))
  }

  async finalizeAfterRestored(stoppedIntent, writeFinalState) {
    const retryDelays = [0, ...SHUTDOWN_RESTORE_RETRY_MS, ...Array(SHUTDOWN_RESTORE_SLOW_ROUNDS).fill(SHUTDOWN_RESTORE_SLOW_MS)]
    for (const delay of retryDelays) {
      if (delay > 0) await new Promise((resolve) => this.clock.setTimeout(resolve, delay))
      if (this.exited || this.intent !== stoppedIntent) return
      if (this.handedOver) { this.exitAfterHandover(); return }
      let finalHandover = false
      try {
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { finalHandover = true; return }
          if (writeFinalState() === false) throw new SettingsBusyError('最终状态尚未写入')
        }, { owner: `stop-final:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch (error) {
        if (this.recoveryHandedOver()) { this.exitAfterHandover(); return }
        if (!(error instanceof SettingsBusyError)) throw error
        this.log('停止后的最终状态等待系统设置锁释放')
        continue
      }
      if (finalHandover) this.exitAfterHandover()
      return true
    }
    throw new SettingsBusyError('停止后的最终状态持续被系统设置锁阻塞')
  }

  async stopForFatal(code, failureState = { code, message: code }) {
    // 致命错误不再重连，但关闭 bridge 后仍必须把系统代理从死端口还回去。意图先钉住：
    // 梯子等待期间客户发起新连接/断开时，新意图接手恢复，旧梯子不得醒来再删新设置。
    const stoppedIntent = this.intent
    this.fatalStopped = true
    this.reconnectAttempts = 0
    const stopping = this.stopConnection().then(() => true, () => {
      this.log('致命停止时后台通道关闭失败，继续还原原网络设置')
      return false
    })
    this.watchStalledBridgeTeardown()
    if (this.exited || this.handedOver || this.intent !== stoppedIntent) return
    // 恢复梯子继续在后台跑，让新意图能接手；但最终状态写盘等异常必须重新抛成 unhandled rejection，
    // 交给入口的崩溃兜底恢复并以 70 退出，⛔ 只记日志后吞掉、伪装成恢复完成。
    void this.restoreAfterFatal(failureState, stoppedIntent, stopping).catch((error) => {
      if (!this.exited) this.log('致命停止后的恢复重试中断')
      throw error
    })
  }

  async restoreAfterFatal(failureState, stoppedIntent, stopping = Promise.resolve(true)) {
    const recovered = await this.restoreWithRetryLadder('致命停止后原设置恢复未完成', {
      checkHandover: true,
      keepFatalStopped: true,
      stayUntilRestored: true,
      shouldContinue: () => !this.exited && !this.handedOver && this.shutdownTask === undefined && this.intent === stoppedIntent
    })
    if (this.handedOver) { this.exitAfterHandover(); return }
    if (!recovered || this.exited || this.shutdownTask !== undefined || this.intent !== stoppedIntent) return
    const stopped = await this.waitForStop(stopping)
    if (this.handedOver || this.recoveryHandedOver()) { this.exitAfterHandover(); return }
    if (this.exited || this.shutdownTask !== undefined || this.intent !== stoppedIntent) return
    if (!stopped) {
      if (await this.finalizeAfterRestored(stoppedIntent, () => this.writeStateNow('error', { code: 'TUNNEL_STOP_INCOMPLETE',
        message: '原网络设置已恢复，但后台通道未能停止；正在重启网络守护完成清理' }))) this.exit(65)
      return
    }
    // restoreSettings 成功后已经交还写入权；新守护可能就在「交权 → 最终状态」之间接管。
    // 与 shutdown 收尾相同，最终落状态也必须在 settings lock 内再次核对 runId，⛔ 用旧 fatal 覆盖新 connected。
    const retryDelays = [0, ...SHUTDOWN_RESTORE_RETRY_MS, ...Array(SHUTDOWN_RESTORE_SLOW_ROUNDS).fill(SHUTDOWN_RESTORE_SLOW_MS)]
    for (const delay of retryDelays) {
      if (delay > 0) await new Promise((resolve) => this.clock.setTimeout(resolve, delay))
      if (this.exited || this.shutdownTask !== undefined || this.intent !== stoppedIntent) return
      if (this.handedOver) { this.exitAfterHandover(); return }
      let finalHandover = false
      try {
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { finalHandover = true; return }
          // restoreSettings 在重试成功时不能打开致命闸；wake/network-change 仍只留痕，不重启连接。
          this.fatalStopped = true
          this.writeStateNow('error', failureState)
        }, { owner: `fatal:${this.runId}`, timeoutMs: 5_000 })
      } catch (error) {
        // 锁忙只说明「现在有人拿锁」，不是交接证据。保持 fatal stopped 并补写最终状态；
        // 普通 I/O 异常继续交给崩溃兜底，⛔ exit 0 或悄悄留下旧状态。
        if (this.recoveryHandedOver()) { this.exitAfterHandover(); return }
        if (!(error instanceof SettingsBusyError)) throw error
        this.fatalStopped = true
        this.log('致命停止最终状态等待系统设置锁释放')
        continue
      }
      if (finalHandover) this.exitAfterHandover()
      return
    }
    throw new SettingsBusyError('致命停止最终状态持续被系统设置锁阻塞')
  }

  async waitForStop(stopping) {
    // 最终状态要核对所有已摘走的旧 connector；当前停止返回成功不代表前一代已退。
    // 正常 connect 仍只等本次 stopConnection，新意图不会被旧 connector 永久挂起。
    const confirmed = Promise.all([Promise.resolve(stopping).then((result) => result !== false, () => false),
      ...this.pendingConnectorStops]).then((outcomes) => outcomes.every(Boolean) && !this.connectorStopFailed)
    let deadline
    try {
      return await Promise.race([confirmed, new Promise((resolve) => {
        deadline = this.clock.setTimeout(() => resolve(false), 30_000)
      })])
    } finally {
      if (deadline !== undefined) this.clock.clearTimer(deadline)
    }
  }

  async assertCurrent(connector) {
    const code = this.authorizationCode()
    if (this.recoveryHandedOver()) {
      this.handedOver = true
      if (this.connector === connector) {
        this.connector = undefined
        this.entryConnectors = undefined
      }
      await this.waitForStop(this.stopAndTrackConnector(connector))
      this.exitAfterHandover()
      throw Object.assign(new Error('连接已取消'), { code: 'TUNNEL_CONNECTION_CANCELLED' })
    }
    if (code || this.exited || this.authorizationStopped || this.intent?.desired !== 'connected' || this.connector !== connector) {
      await this.stopAndTrackConnector(connector)
      throw Object.assign(new Error(code ?? '连接已取消'), { code: code ?? 'TUNNEL_CONNECTION_CANCELLED' })
    }
  }

  async applyIntent(next) {
    if (next.desired === 'user-disconnected' && this.intent?.desired === 'connected') this.disconnectingAuthorizationIntent = this.intent
    this.intent = next
    this.availabilityIntentFor(next)
    if (!await this.recordIntent(next.desired) || this.intent !== next) return
    if (next.desired === 'connected') {
      await this.connect()
      return
    }
    if (next.desired === 'user-disconnected') {
      // 先停止连接期复验和重试，但保留活通道，直到原设置恢复读回一致。
      this.reconnectEpoch += 1
      this.clearVerify()
      if (this.reconnectTimer !== undefined) {
        this.clock.clearTimer(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      this.recoveryNotice = undefined
      this.writeStateNow('user-disconnected')
      // 不占 transitioning 闸；客户重新连接时由新意图接手，旧恢复任务不会再停止新通道。
      void this.restoreAfterDisconnect(next).catch(() => {
        if (!this.exited && this.intent === next) {
          this.log('断开后的恢复或最终状态重试中断，交给下一次启动继续处理')
          this.exit(65)
        }
      })
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

  // 程序被删了:停连接与还原同时开始,有界确认停止后再卸常驻。还没还干净就**留在原地下一轮再试**,⛔ 退出——
  // 程序已经不在,退出后 launchd 也拉不起来它,再没有第二个人能把客户的代理还回去。
  async runResidentSelfHeal() {
    if (this.residentSelfHeal === undefined || this.selfHealing || this.exited || this.shutdownTask) return
    this.selfHealing = true
    try {
      const stoppedIntent = this.intent
      this.fatalStopped = true
      // 锁忙时本轮会返回；下一轮必须继续等同一次停止，不能因 bridge/connector 已摘走就误认停止成功。
      const stopping = this.residentStopping ??= this.stopConnection().then(() => true, () => false)
      const damagedLedger = ledgerFailure(this.dataDir) !== undefined
      let firstRecoveryAttempt = true
      const recovered = damagedLedger ? false : await this.restoreWithRetryLadder('常驻自救时原设置恢复未完成', {
        checkHandover: true,
        keepFatalStopped: true,
        stayUntilRestored: true,
        timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS,
        shouldContinue: () => {
          if (this.exited || this.handedOver || this.shutdownTask || this.intent !== stoppedIntent) return false
          if (firstRecoveryAttempt) { firstRecoveryAttempt = false; return true }
          // 锁由其他任务持有时让本轮自救返回，由常驻巡检下一拍重试。
          return !this.settingsBusy
        }
      })
      if (this.handedOver) { this.exitAfterHandover(); return }
      // 损坏账本由原有自救 callback 做隔离诊断；本进程必须留守，不能让 restoreSettings 提前 exit(65)。
      if ((!recovered && !damagedLedger) || this.exited || this.shutdownTask || this.intent !== stoppedIntent) return
      const stopped = await this.waitForStop(stopping)
      if (!stopped) this.residentStopIncomplete = true
      if (this.handedOver || this.recoveryHandedOver()) { this.exitAfterHandover(); return }
      if (this.exited || this.shutdownTask || this.intent !== stoppedIntent) return
      let handedOver = false
      let shouldExit = false
      try {
        // 自愈恢复、交接判定和最终状态共用一把锁；新守护已接管时旧进程整段不再动它的账与状态。
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { handedOver = true; return }
          const outcome = this.residentSelfHeal()
          if (outcome?.shouldExit) {
            this.writeStateNow(this.residentStopIncomplete ? 'error' : 'stopped-restored', this.residentStopIncomplete
              ? { code: 'TUNNEL_STOP_INCOMPLETE', message: '原网络设置已恢复，但后台通道未能确认停止；工具箱已移除' }
              : {})
            shouldExit = true
          } else {
            this.writeStateNow('error', { code: 'TUNNEL_RESIDENT_SELF_HEAL', message: '工具箱已被移除，正在把电脑的网络设置还原；完成前请不要关机' })
          }
        }, { owner: `resident-final:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch (error) {
        if (this.recoveryHandedOver()) { this.exitAfterHandover(); return }
        if (!(error instanceof SettingsBusyError)) throw error
        this.log('常驻自愈等待系统设置锁释放')
        return // 保持常驻进程，下次完整重试恢复与落状态。
      }
      if (handedOver) { this.exitAfterHandover(); return }
      if (shouldExit) this.exit(0) // 程序已移除，0 ⇒ 不再拉起；停止未确认时状态仍是错误
    } finally {
      this.selfHealing = false
    }
  }

  /** 连接路径撞设置锁的等待位:记「连接中」+锁忙码(界面经 connectionMessage 出人话),短轮询等锁放开后
   * 原路重走 connect(恢复→连接→写设置)。⛔ 写失败态、⛔ 停连接、⛔ 出现「连接中断,自动重连中」——
   * 锁忙说明不了通道好坏,而且此时客户多半还没连上过。 */
  waitOutSettingsLock(code) {
    if (this.exited || this.shutdownTask || this.intent?.desired !== 'connected') return
    this.log(`设置锁被别的进程占着(${String(code)}):连接顺延,${String(SETTINGS_BUSY_RETRY_MS / 1000)} 秒后再试`)
    this.writeStateNow('connecting', { code })
    if (this.settingsBusyTimer !== undefined) return
    this.settingsBusyTimer = this.clock.setTimeout(() => {
      this.settingsBusyTimer = undefined
      void this.connect()
    }, SETTINGS_BUSY_RETRY_MS)
  }

  retryRecoveryOwnerPublish() {
    if (this.recoveryOwnerRetryTimer !== undefined || this.exited || this.shutdownTask || this.intent?.desired !== 'connected') return
    const intent = this.intent
    this.log(`恢复责任记录尚未保存,${String(SETTINGS_BUSY_RETRY_MS / 1000)} 秒后重试连接`)
    this.recoveryOwnerRetryTimer = this.clock.setTimeout(() => {
      this.recoveryOwnerRetryTimer = undefined
      if (this.exited || this.shutdownTask || this.intent !== intent) return
      void this.connect().catch(() => this.requestShutdown())
    }, SETTINGS_BUSY_RETRY_MS)
  }

  async connect() {
    if (this.shutdownTask || this.exited || this.intent?.desired !== 'connected') return
    const failure = ledgerFailure(this.dataDir)
    if (failure) { await this.failLedger(failure); return }
    const intent = this.intent
    // 即使状态落盘暂被新守护/锁拦住，当前动作也必须以 connecting 为内部事实，不能让随后取证把 idle 写回。
    this.state = 'connecting'
    this.writeStateNow('connecting')
    const stopping = this.stopConnection()
    const epoch = this.reconnectEpoch
    if (!await this.stopAndRestoreForReconnect(stopping, intent, epoch)) return
    if (this.exited || this.intent !== intent || this.reconnectEpoch !== epoch) return
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    if (this.shutdownTask || this.exited || this.intent?.desired !== 'connected') return
    // 检查性拿锁用短上限:锁忙=另一项设置任务在进行,与通道无关。客户往往还没连上过,
    // ⛔ 走 handleConnectFailure——那会写失败态、停连接、显示「连接中断,自动重连中」。
    if (!this.restoreSettings({ timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS, claimRecovery: true, checkHandover: true })) {
      if (this.handedOver) { this.exitAfterHandover(); return }
      if (this.settingsBusy) this.waitOutSettingsLock('TUNNEL_SETTINGS_BUSY')
      else if (this.recoveryOwnerPublishFailed) this.retryRecoveryOwnerPublish()
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
    // 全新连接另起新账:上一段故障片段(若守护期间遗留)与待展示事件一并作废。
    this.reconnectEpisodeStartedAt = undefined
    this.reconnectTries = 0
    this.recoveryNotice = undefined
    if (this.intent?.connector === undefined) {
      this.writeStateNow('error', { code: '配置缺失', message: '意图缺连接器,无法连接' })
      return
    }
    const code = this.authorizationCode()
    if (code) { await this.stopForAuthorization(code); return }
    this.writeStateNow('connecting')
    const request = this.intent
    try {
      // examining 不是 beginIntent 的被动副作用：只有这一轮连接真正开始读取路径和对象时才发布。
      this.beginAvailabilityAction('inspect')
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
  async tryReuseExistingProxy(allowDirectProbe = true) {
    let existing
    try { existing = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() }) } catch { return false }
    // 电脑上没有设代理,不等于客户没有外网(他可能装着 VPN 走全局、人在墙外、公司有专线)。
    // 但「本来就能上网」⛔ 等于「能用 AI」——公司网络常放行 Google 却拦着 AI 服务,拿通用探测点当判据
    // 会让这种客户永远等不到我们接管(本机实测:能上外网的机器上,122 条用例集体走进复用分支)。
    // 这条要做,判据必须是「能不能到客户真正要用的那些服务」;探测原语已备
    // (vless-connector.probeDirectReachability),接线等判据定了再说。
    // 直连探测绕过 PAC，不能证明受 PAC 控制的 AI 软件会走同一条可用路径。
    if (existing?.kind === 'pac') return false
    if (!existing || !['http', 'socks'].includes(existing.kind)) {
      // 没设代理 ⛔ 等于没有外网:客户可能装着 VPN 走全局、人在墙外、公司有专线。这条路能到 AI 服务
      // 就用它、一个字节不改客户的设置(GPT-6 4.3①)。PAC 仍按不可判定处理——求值要跑 JS,风险大于收益。
      return allowDirectProbe ? await this.tryReuseDirectPath() : false
    }
    const availability = this.existingAvailabilityContext(existing)
    const operation = this.beginAvailabilityAction('reuse', availability)
    try { await this.probeProxy(existing) } catch (error) {
      this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false, ...availability, allowFailure: true })
      this.log(`电脑上已有代理 ${existing.host}:${String(existing.port)} 出不了外网(${error instanceof Error ? error.message : String(error)}),改建来信连接`)
      return false
    }
    // 网络探测成功只证明刚才访问的 endpoint 可用；落 connected 前还要重新读取当前系统路径。
    // Windows 没有 macOS 的 WeakMap 快照，也必须靠这次重读确认没有在探测期间换到另一个对象。
    const observed = this.currentExistingProxy(existing)
    const current = observed.candidate
    const currentEvidence = current === undefined ? undefined : this.existingAvailabilityContext(current)
    if (!observed.fresh || currentEvidence === undefined ||
        currentEvidence.conflict.id !== availability.conflict.id || currentEvidence.path.id !== availability.path.id) {
      this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false,
        conflict: currentEvidence?.conflict ?? { id: 'path:changed', kind: 'changed' }, path: currentEvidence?.path ?? availability.path,
        allowFailure: true })
      throw Object.assign(new Error('现有代理在目标探测期间发生变化，已拒绝使用旧路径建链'), { code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
    }
    let reusable
    try {
      this.validateExistingProxy(current)
      reusable = this.materializeExistingProxy(current)
    } catch {
      this.failAvailabilityAction(operation, 'EVIDENCE_CHANGED')
      throw Object.assign(new Error('现有代理在目标探测期间发生变化，已拒绝使用旧路径建链'), { code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
    }
    if (this.exited || this.intent?.desired !== 'connected') return false
    this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: true, ...this.existingAvailabilityContext(reusable) })
    this.reusedProxy = reusable
    this.state = 'connected'
    this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
    this.writeReusedState()
    this.scheduleVerify()
    this.log(`电脑上已有代理 ${reusable.host}:${String(reusable.port)} 能出外网:复用它,不改系统设置`)
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
    // 没有路径读取能力时不能宣布“直连复用”；但受管接管仍会逐项取快照、建租约、读回并复验，
    // 所以应继续裁决到那条有恢复合同的路径。已提供读取能力却读失败则由下面的控制器结论限制。
    if (typeof this.adapter.currentPathIdentity !== 'function') return false
    const availability = this.existingAvailabilityContext({ kind: 'direct' })
    const operation = this.beginAvailabilityAction('reuse', availability)
    try { await this.probeDirect() } catch {
      this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false, ...availability, allowFailure: true })
      return false
    }
    // 探测没有经过系统 PAC/代理；异步探测期间若路径改变，不用旧绿灯落入本地 connector。
    // 返回的是可归类的证据变化，下一次当前意图会重新取证裁决。
    const rejectChangedEvidence = (current = availability) => {
      this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false,
        conflict: current.conflict, path: current.path, allowFailure: true })
      throw Object.assign(new Error('直连路径在目标探测期间发生变化，已拒绝使用旧路径建链'), { code: 'TUNNEL_ACTIVE_PROXY_CHANGED' })
    }
    let current
    if (this.adapter.existingProxy !== undefined) {
      try {
        current = this.adapter.existingProxy({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() })
      } catch { return rejectChangedEvidence() }
      if (current?.kind === 'http' || current?.kind === 'socks') return await this.tryReuseExistingProxy(false)
      if (current !== undefined) return rejectChangedEvidence(this.existingAvailabilityContext(current))
    }
    const currentAvailability = this.existingAvailabilityContext({ kind: 'direct' })
    if (currentAvailability.path.id !== availability.path.id) return rejectChangedEvidence(currentAvailability)
    if (this.exited || this.intent?.desired !== 'connected') return false
    this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: true, ...currentAvailability })
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
    try { current = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() }) } catch {
      return { candidate: fallback, fresh: false }
    }
    if (this.adapter.existingProxy === undefined) return { candidate: fallback, fresh: true }
    return { candidate: current && ['http', 'socks'].includes(current.kind) ? current : undefined, fresh: true }
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
    return this.writeStateNow('connected', { ...this.lastVerification, code: 'TUNNEL_REUSED_EXISTING', reusedProxy: existing, message })
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
    const observed = this.currentExistingProxy(existing)
    const current = observed.candidate
    // networksetup 暂时读不到当前路径时，materialized fallback 仍是上轮已验证、可继续探测的 endpoint，
    // 但它不带适配器 WeakMap 里的本轮快照，绝不能送进 validateExistingProxy 冒充 fresh 读数。
    // 无论旧 endpoint 这次探通与否，都只能说明“旧路此刻可/不可达”，说明不了系统已经换路；保留复用态并重试读取。
    if (!observed.fresh) {
      try { await this.probeProxy(current) } catch { /* 读数未知时探测失败也不能据此覆盖系统设置 */ }
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      this.writeStateNow('degraded', { ...this.lastVerification, code: 'TUNNEL_VERIFY_UNCONFIRMED',
        message: '本机代理设置暂时读不到，已保留现有通道并将在下一轮复查' })
      if (!confirming) {
        this.confirmationTimer = this.clock.setTimeout(() => {
          this.confirmationTimer = undefined
          void this.reverify(true)
        }, VERIFY_CONFIRM_MS)
      }
      return
    }
    try {
      if (current === undefined) throw new Error('电脑上的代理设置已被关闭或改成无法判定的形态')
      await this.probeProxy(current)
      this.validateExistingProxy(current)
      const reusable = this.materializeExistingProxy(current)
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      if (reusable.host !== existing.host || reusable.port !== existing.port || reusable.kind !== existing.kind) {
        this.log(`电脑上的代理已换成 ${reusable.host}:${String(reusable.port)} 且能出外网:继续复用它`)
      }
      this.reusedProxy = reusable
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

  /** The old direct result is no longer usable once proxy/path evidence changes.
   * Restart the same intent's complete arbitration rather than treating a
   * probe that straddled the change as permission to build a local connector. */
  async rejudgeReusedDirect(existing) {
    if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
    this.reusedProxy = undefined
    this.clearVerify()
    this.writeStateNow('connecting')
    const request = this.intent
    try { await this.connect() } catch (error) {
      if (this.intent !== request) return
      await this.handleConnectFailure(error)
    }
  }

  /** 直连复用的复验:目标探测后也必须重新取得代理与路径证据。探不通 → 确认轮 → 仍不通就改建来信连接。 */
  async reverifyReusedDirect(existing, confirming) {
    let availability
    let operation
    try {
      availability = this.existingAvailabilityContext({ kind: 'direct' })
      operation = this.beginAvailabilityAction('reuse', availability)
    } catch {
      await this.rejudgeReusedDirect(existing)
      return
    }
    try {
      await this.probeDirect()
      if (this.reusedProxy !== existing || this.exited || this.intent?.desired !== 'connected') return
      let current
      try {
        current = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() })
      } catch {
        this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false, ...availability, allowFailure: true })
        await this.rejudgeReusedDirect(existing)
        return
      }
      const currentAvailability = current === undefined
        ? this.existingAvailabilityContext({ kind: 'direct' }) : this.existingAvailabilityContext(current)
      if (current !== undefined || currentAvailability.path.id !== availability.path.id) {
        this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: false, ...currentAvailability, allowFailure: true })
        await this.rejudgeReusedDirect(existing)
        return
      }
      if (!this.completeAvailabilityAction(operation, { readbackMatches: true, targetReachable: true, ...currentAvailability, allowFailure: true })) return
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
    const request = this.intent
    const epoch = this.reconnectEpoch
    // 初连由 connect() 开启取证；退避重连、复用路径失效后的改建会直接进 establish，必须另开当前取证，
    // 不能拿上一轮已完成的 operation 做最终闸。
    if (!this.availability.isCurrent(this.availabilityOperation)) {
      this.state = 'connecting'
      this.beginAvailabilityAction('inspect')
    }
    const initialHandover = this.connectionOwnerFence(request, epoch)
    if (initialHandover !== undefined) await initialHandover
    const spec = this.intent?.connector
    if (spec === undefined) {
      throw Object.assign(new Error('意图缺连接器'), { code: CONTROL_CODES.upstreamUnreachable })
    }
    try {
      this.adapter.preflight?.({ host: '127.0.0.1', port: this.activeBridgePort() })
    } catch (error) {
      if (error?.code === CONTROL_CODES.managedPolicy) {
        try { this.beginAvailabilityAction('takeover', { restriction: 'POLICY_LOCKED' }) } catch (availabilityError) { throw availabilityError }
      }
      throw error
    }
    // 多入口:轮转后的第一条当主连接器(复验、本地口都走它),全部入口一起交给内核。
    const specs = this.entrySpecs()
    this.connector = this.connectorFactory(specs[0] ?? spec)
    this.entryConnectors = specs.length > 1 ? specs.map((entry, index) => (index === 0 ? this.connector : this.connectorFactory(entry))) : undefined
    const connector = this.connector
    connector.onLost((error) => { if (this.connector === connector) this.onConnectionLost(error) })
    const startHandover = this.connectionOwnerFence(request, epoch, connector)
    if (startHandover !== undefined) await startHandover
    try { await connector.start() } catch (error) {
      // SSH 可能已 spawn 后才因 ready 超时报错；新守护接管时不能先退出留下旧进程。
      if (this.recoveryHandedOver()) {
        const failedStartHandover = this.connectionOwnerFence(request, epoch, connector)
        if (failedStartHandover !== undefined) await failedStartHandover
      }
      throw error
    }
    await this.assertCurrent(connector)
    await this.ensureBridge(request, epoch, connector)
    await this.assertCurrent(connector)
    const { exitIp } = await this.verifyConnection(connector)
    await this.assertCurrent(connector)
    this.applySettings()
    this.reclaimFailedRestores()
    try { this.verifySettings() } catch (error) {
      this.failAvailabilityAction(this.availabilityOperation, 'READBACK_MISMATCH')
      throw error
    }
    // 写入后再次实测目标，而不是拿写入前的探测冒充成功；控制器同时核对本意图、路径与写后读回。
    let postWriteVerification
    try {
      postWriteVerification = await this.verifyConnection(connector)
      await this.assertCurrent(connector)
    } catch (error) {
      // 已有本轮接管写入且意图仍有效时，目标复验失败是受控限制，不得停在“正在接管”。
      if (!this.exited && this.intent === request && this.connector === connector) {
        this.failAvailabilityAction(this.availabilityOperation, 'TARGET_UNREACHABLE')
      }
      throw error
    }
    try {
      // 目标探测是异步的；它完成后必须重新读取本次接管的网络设置和活动路径，不能拿探测前的读回替它。
      this.verifyAvailabilityReadback(this.availabilityOperation)
    } catch (error) {
      if (!this.exited && this.intent === request && this.connector === connector) {
        this.failAvailabilityAction(this.availabilityOperation, 'READBACK_MISMATCH')
      }
      throw error
    }
    this.completeAvailabilityAction(this.availabilityOperation, { readbackMatches: true, targetReachable: true })
    this.settingsReleased = false
    this.settingsReleaseFailed = false
    this.repairedItems = undefined
    this.state = 'connected'
    this.lastVerification = { exitIp: postWriteVerification.exitIp || exitIp, lastVerifiedAt: this.clock.now() }
    this.writeStateNow('connected', this.lastVerification)
    this.scheduleTraffic()
    this.scheduleVerify()
  }

  queueBridgeTeardown(bridge) {
    if (bridge === undefined) return this.waitForBridgeTeardowns()
    const pending = this.pendingBridgeTeardowns.get(bridge)
    if (pending !== undefined) return pending
    const previous = this.bridgeTeardownTail
    const teardown = (async () => {
      await previous
      try {
        await bridge.close()
        this.failedBridgeTeardowns.delete(bridge)
      } catch (error) {
        this.failedBridgeTeardowns.add(bridge)
        throw error
      }
    })()
    this.pendingBridgeTeardowns.set(bridge, teardown)
    // tail 只表示队列何时停下，自身不永久 reject；真失败保留在 failed 里，由下次入口重试。
    this.bridgeTeardownTail = teardown.then(() => undefined, () => undefined)
    teardown.then(
      () => this.pendingBridgeTeardowns.delete(bridge),
      () => this.pendingBridgeTeardowns.delete(bridge)
    )
    return teardown
  }

  async waitForBridgeTeardowns() {
    while (true) {
      const tail = this.bridgeTeardownTail
      await tail
      if (tail !== this.bridgeTeardownTail) continue
      const failed = [...this.failedBridgeTeardowns]
      if (failed.length === 0) return
      // 上一轮 close 抛错时不能猜它已经收干净；这一轮真重试，仍失败就继续拦住新代。
      for (const stale of failed) await this.queueBridgeTeardown(stale)
    }
  }

  connectionOwnerFence(intent, epoch, connector) {
    const cancelled = () => Object.assign(new Error('连接已取消'), { code: 'TUNNEL_CONNECTION_CANCELLED' })
    if (this.exited || this.intent !== intent || this.reconnectEpoch !== epoch ||
        (connector !== undefined && this.connector !== connector)) throw cancelled()
    if (!this.recoveryHandedOver()) return undefined
    this.handedOver = true
    if (connector !== undefined && this.connector === connector) {
      this.connector = undefined
      this.entryConnectors = undefined
      return this.waitForStop(this.stopAndTrackConnector(connector)).then(() => {
        this.exitAfterHandover()
        throw cancelled()
      })
    }
    this.exitAfterHandover()
    throw cancelled()
  }

  async ensureBridge(intent = this.intent, epoch = this.reconnectEpoch, connector = this.connector) {
    // 真正创建新 bridge（会覆盖共用 config/PID）前，所有旧代必须彻底收尾。
    // 循环复查涵盖等待期间追加的 teardown。
    await this.waitForBridgeTeardowns()
    const firstHandover = this.connectionOwnerFence(intent, epoch, connector)
    if (firstHandover !== undefined) await firstHandover
    if (this.bridge !== undefined && this.bridge.isAlive?.() !== false) return
    if (this.bridge !== undefined) {
      const stale = this.bridge
      this.bridge = undefined
      // 桥可能刚停止监听；close 卡住时先还原死代理，退出前也收掉本次已启动的连接器。
      if (!await this.stopAndRestoreForReconnect(this.queueBridgeTeardown(stale), intent, epoch, {
        onStopIncomplete: () => {
          if (this.connector !== connector) return Promise.resolve()
          this.connector = undefined
          this.entryConnectors = undefined
          return this.stopAndTrackConnector(connector)
        }
      })) {
        throw Object.assign(new Error('旧桥接收尾未完成'), { code: 'TUNNEL_CONNECTION_CANCELLED' })
      }
    }
    await this.waitForBridgeTeardowns()
    const secondHandover = this.connectionOwnerFence(intent, epoch, connector)
    if (secondHandover !== undefined) await secondHandover
    // 入口端口按候选表依次试(18080 是开发者机器上常见的被占端口:Tomcat/Jenkins/别的代理):
    // 第一个能监听的就用,系统代理跟着指向它;全被占才报「端口占用」。已有中继活着时不换端口。
    const candidates = Array.isArray(this.intent.bridgePortCandidates) && this.intent.bridgePortCandidates.length > 0
      ? [this.bridgePort ?? this.intent.bridgePortCandidates[0], ...this.intent.bridgePortCandidates.filter((port) => port !== (this.bridgePort ?? this.intent.bridgePortCandidates[0]))]
      : [this.bridgePort ?? this.intent.bridgePort]
    let lastError
    // If every candidate is occupied, retain the last *identified* owner rather
    // than inspecting only the final candidate. A later unidentified port must
    // not erase evidence that an external process already owns this path.
    let lastObservedPortOwner
    for (const listenPort of candidates) {
      const nextHandover = this.connectionOwnerFence(intent, epoch, connector)
      if (nextHandover !== undefined) await nextHandover
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
          this.recordAvailabilityRestriction('PEER_LAIXIN_RUNNING', {
            conflict: { id: `port:${String(listenPort)}:laixin`, kind: 'laixin-instance' },
            path: { id: `local-bridge:${String(listenPort)}`, target: 'configured-ai-target' }
          })
          // 后启动的这一份要**如实展示前一份的状态**(硬线二),⛔ 只说「有人占着」就完事。
          // 读不到就没有,降级为不带状态的那句话。
          const word = this.peerStateWord(readWriteRightOwner())
          throw Object.assign(new Error('这台电脑上已经有一份来信在运行；请先退出或卸载那一份，再重新连接'), {
            code: 'TUNNEL_PEER_LAIXIN_RUNNING',
            peer: { pid: owner.pid, name: owner.name },
            ...(word === undefined ? {} : { peerState: word })
          })
        }
        if (owner?.kind === 'other' || owner?.kind === 'unknown') {
          lastObservedPortOwner = { listenPort, owner }
        }
        this.log(`入口端口 ${String(listenPort)} 被占,换下一个候选`)
        this.bridge = undefined
        continue
      }
      const actualPort = typeof bridge.port === 'function' ? bridge.port() : listenPort
      if (listenPort === 0) this.log(`固定候选口全被占:改用系统分配的空闲口 ${String(actualPort)}`)
      if (this.bridge !== bridge || this.authorizationStopped || this.exited || this.intent?.desired !== 'connected') {
        if (this.bridge === bridge) this.bridge = undefined
        await this.queueBridgeTeardown(bridge)
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
    const observed = lastObservedPortOwner ?? (typeof candidates[candidates.length - 1] === 'number'
      ? { listenPort: candidates[candidates.length - 1], owner: this.adapter.identifyPortOwner?.(candidates[candidates.length - 1]) }
      : undefined)
    const owner = observed?.owner
    if (owner?.kind === 'other' || owner?.kind === 'unknown') {
      const listenPort = observed.listenPort
      this.recordAvailabilityRestriction('PROCESS_OWNERSHIP_UNPROVEN', {
        conflict: { id: `port:${String(listenPort)}:${owner.kind}`, kind: owner.kind === 'other' ? 'external-process' : 'unknown-process' },
        path: { id: `local-bridge:${String(listenPort)}`, target: 'configured-ai-target' }
      })
    }
    throw lastError ?? Object.assign(new Error('入口端口全部被占'), { code: CONTROL_CODES.portBusy })
  }

  // allowFallback:回显失败后要不要再打通用探测点。首次连接和每轮复验都立即核对；
  // 通用探测经通道成功时不先闪「待确认」，两种探测都失败才进入短确认。
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
    if (this.writeRight !== undefined) {
      // 新的连接/恢复意图已经要继续使用这个席位：撤掉旧的后台交还计时，避免写入中途把权放掉。
      this.cancelWriteRightReleaseRetry()
      return { ok: true }
    }
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
      const recovered = this.restoreSettings({ keepWriteRight: true, checkHandover: true })
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
    if (right === undefined) { this.cancelWriteRightReleaseRetry(); return true }
    let released = false
    try { released = right.release() !== false } catch { /* 保留引用，后续收尾再试 */ }
    if (!released) {
      this.log('系统代理写入权暂未确认交还，保留本进程持权并在后台重试')
      this.scheduleWriteRightReleaseRetry(right)
      return false
    }
    this.cancelWriteRightReleaseRetry()
    this.writeRight = undefined
    this.writeRightToken = undefined
    clearWriteRightOwner(process.pid)
    return true
  }

  cancelWriteRightReleaseRetry() {
    if (this.writeRightReleaseTimer === undefined) return
    this.clock.clearTimer(this.writeRightReleaseTimer)
    this.writeRightReleaseTimer = undefined
  }

  scheduleWriteRightReleaseRetry(right) {
    if (this.exited || this.writeRight !== right || this.writeRightReleaseTimer !== undefined) return
    this.writeRightReleaseTimer = this.clock.setTimeout(() => {
      this.writeRightReleaseTimer = undefined
      if (this.exited || this.writeRight !== right) return
      this.releaseWriteRight()
    }, WRITE_RIGHT_RELEASE_RETRY_MS)
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
    if (reason !== 'held') {
      const failure = writeRightFailure(reason)
      return Object.assign(new Error(failure.message), { code: failure.code, holder })
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

  applySettings(options = {}) {
    const right = this.ensureWriteRight()
    if (!right.ok) throw this.writeRightConflict(right)
    withSettingsLock(this.dataDir, () => this.applySettingsLocked(), { owner: `apply:${this.runId}`, ...options })
  }

  applySettingsLocked() {
    this.assertRecoveryOwnerLocked()
    this.flushPendingIntent()
    if (this.settingsApplied) this.verifySettingsLocked()
    // N-55:先完整读取每个可写项，形成同一动作的快照/对象/租约；再逐项先记账、写入、读回。
    // 一项读数无法证明时，不用其它项的旧证据替它写入。
    const items = this.adapter.managedItems({ host: '127.0.0.1', port: this.activeBridgePort() })
    const planned = []
    for (const managed of items) {
      if (this.appliedItems.some(({ ref }) => ref.service === managed.ref.service && ref.item === managed.ref.item)) continue
      const optional = isOptionalSettingService(managed.ref.service)
      try {
        planned.push({ managed, optional, originalValue: this.adapter.read(managed.ref) })
      } catch (error) {
        if (!optional) throw error
        this.noteOptionalSkipped(managed.ref, error)
      }
    }
    let operation
    if (planned.length > 0) {
      const refs = planned.map(({ managed }) => managed.ref)
      const time = this.clock.now()
      operation = this.beginAvailabilityAction('takeover', {
        refs,
        snapshot: { id: `snapshot:${String(this.sessionToken)}:${String(time)}`, value: planned.map(({ managed, originalValue }) => ({ ref: managed.ref, value: originalValue })) },
        writtenValue: planned.map(({ managed }) => ({ ref: managed.ref, value: managed.value }))
      })
    }
    let changed = false
    const equal = this.adapter.valuesEqual ?? deepEqual
    for (const { managed, optional, originalValue } of planned) {
      // 快照之后到写入前，外部进程仍可能改值；旧证据一旦失效就取消本动作，让下一轮重新取证。
      // 这里比的是“快照是否被外部改过”，不是“该项是否仍满足来信接管值”。
      // 可选终端项的 valuesEqual 只定义 managed descriptor，不能拿它判两个原始快照相等。
      if (!deepEqual(this.adapter.read(managed.ref), originalValue)) {
        this.availability.cancel(operation, 'before-write')
        throw Object.assign(new Error('系统设置在接管前已被外部改写'), { code: 'TUNNEL_AVAILABILITY_EVIDENCE_CHANGED' })
      }
      if (!this.availability.isCurrent(operation)) {
        throw Object.assign(new Error('接管动作已被新的连接意图取代'), { code: 'TUNNEL_AVAILABILITY_STALE_OPERATION' })
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
        if (!optional) {
          this.failAvailabilityAction(operation, 'WRITE_FAILED')
          throw error
        }
        // 没写进去就把这条账目结掉(现值就是原值),⛔ 留成「未恢复」
        try { markEntry(this.dataDir, entry.id, { status: ENTRY_STATUS.restored, note: '可选项未写入(无权限或被占用),保留原状' }) } catch { /* 账目结不掉也不挡网络 */ }
        this.noteOptionalSkipped(managed.ref, error)
        continue
      }
      if (!equal(this.adapter.read(managed.ref), managed.value, managed.ref)) {
        this.failAvailabilityAction(operation, 'READBACK_MISMATCH')
        throw Object.assign(new Error('本机接入设置写后读回不一致'), { code: 'TUNNEL_SETTINGS_NOT_APPLIED' })
      }
      if (!this.availability.markWritten(operation)) {
        throw Object.assign(new Error('接管写入未持有当前租约'), { code: 'TUNNEL_AVAILABILITY_STALE_OPERATION' })
      }
      this.appliedItems.push(managed)
      changed = true
    }
    if (changed) this.broadcastSettingsBestEffort()
    this.settingsApplied = true
  }

  noteOptionalSkipped(ref, error) {
    this.optionalNote = this.adapter.optionalNote?.() || '终端自动接入这次没启用（终端配置不可用），浏览器与系统代理不受影响'
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

  verifySettings(repair = false, options = {}) {
    withSettingsLock(this.dataDir, () => this.verifySettingsLocked(repair), { owner: `verify:${this.runId}`, ...options })
  }

  // N-55 最终闸只复读本次接管的网络设置。终端 hook 是既有可选接入项，不属于系统代理/PAC/TUN 路径；
  // 把它混入写后目标复验会把文件侧瞬态读数误报为网络路径失效。
  verifyAvailabilityReadback(operation) {
    if (operation?.action !== 'takeover') return
    const equal = this.adapter.valuesEqual ?? deepEqual
    for (const applied of this.appliedItems) {
      if (isOptionalSettingService(applied.ref.service)) continue
      if (!equal(this.adapter.read(applied.ref), applied.value, applied.ref)) {
        throw Object.assign(new Error('目标复验后本机网络设置读回不一致'), { code: 'TUNNEL_SETTINGS_NOT_APPLIED' })
      }
    }
  }

  verifySettingsLocked(repair = false) {
    this.assertRecoveryOwnerLocked()
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
        // 「已有可用外网就复用、不抢」(创始人 09-13 晚硬标准)要兑现到争抢这一幕:别的软件把系统代理改成了它自己的,
        // 如果**它那条也能出外网**,客户要的「有网可用」已经满足了——那就该让给它,⛔ 每 30 秒抢回来一次。
        // 只有它那条出不了外网,才改回来(客户点了连接,我们得负责让他有网)。
        // 这里趁设置还是对方的值先读出它是谁;探它通不通要发网络请求,⛔ 在锁里做——记下来,出了锁再探。
        if (this.contender === undefined) {
          try {
            const rival = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() })
            // 争抢候选马上会被我们修回，因此只捕获当下 endpoint，锁外探测不能再要求 OS 仍指向它。
            if (rival && ['http', 'socks'].includes(rival.kind)) this.contender = this.materializeExistingProxy(rival)
          } catch { /* 读不出对方是谁:照旧改回来 */ }
        }
        // 修回时写的值由适配器定(PAC:只关开关、保留对方现在的地址),⛔ 把对方后来改的地址也一并覆盖
        const value = this.adapter.repairValue?.(ref, current, applied.value) ?? applied.value
        // N-55:重复争用不是第二次就机械停；本轮复验以同一租约组织为一个有界夺回动作。
        // 达到控制器上限时不会写入，保留外部当前值并给出可验证的限制码。
        if (this.availabilityReclaimOperation !== undefined && !this.availability.isCurrent(this.availabilityReclaimOperation)) {
          this.availabilityReclaimOperation = undefined
        }
        if (this.availabilityReclaimOperation === undefined) {
          try {
            this.availabilityReclaimOperation = this.beginAvailabilityAction('reclaim', {
              refs: [ref],
              snapshot: { id: `reclaim-snapshot:${String(this.sessionToken)}:${String(this.clock.now())}`, value: [{ ref, value: current }] },
              writtenValue: [{ ref, value }]
            })
          } catch (error) {
            // 到达上限也把最后一次第三方值落为恢复基线；旧快照绝不能在退出时盖回它。
            this.recordRepairOriginal(ref, current, current, equal)
            throw error
          }
        } else if (Array.isArray(this.availabilityReclaimOperation.snapshot?.value)) {
          this.availabilityReclaimOperation.snapshot.value.push({ ref, value: current })
        }
        if (!this.availability.isCurrent(this.availabilityReclaimOperation)) {
          throw Object.assign(new Error('夺回动作已被新的连接意图取代'), { code: 'TUNNEL_AVAILABILITY_STALE_OPERATION' })
        }
        // 只在客户仍要求连接时修复:每次都改回来(硬标准),⛔ 止损。本会话每一项只留一条修回账目(账本 ⛔ 每 30 秒长一条),
        // 但恢复依据必须是对方**最后**写的值:对方这次写的和账上记的不一样 → 先把账目的原值改成它并落盘,再覆盖
        // (先记账后写入)。⛔ 只记第一次的值——退出时会把客户的网交回一个早已停用的旧地址(GPT-6 补核 R6)。
        this.settingsRepairs = (this.settingsRepairs ?? 0) + 1
        this.lastSettingsRepairAt = this.clock.now()
        this.recordRepairOriginal(ref, current, value, equal)
        assertSettingsLockHeld(this.dataDir)
        try { this.adapter.write(ref, value) } catch (error) {
          this.failAvailabilityAction(this.availabilityReclaimOperation, 'WRITE_FAILED')
          if (['TUNNEL_PROXY_AUTH_REQUIRED', 'TUNNEL_PROXY_HELPER_FAILED'].includes(error?.code)) throw error
          throw Object.assign(new Error('本机网络设置夺回写入失败'), { code: 'TUNNEL_AVAILABILITY_WRITE_FAILED', cause: error })
        }
        applied.value = value
        changed = true
        if (!equal(this.adapter.read(ref), value, ref)) throw mismatch()
        if (!this.availability.markWritten(this.availabilityReclaimOperation)) {
          throw Object.assign(new Error('夺回写入未持有当前租约'), { code: 'TUNNEL_AVAILABILITY_STALE_OPERATION' })
        }
      }
    } finally {
      if (changed) this.broadcastSettingsBestEffort()
    }
  }

  // 争抢对手那条能不能出外网:能就让给它(转成复用态,不再抢);不能就维持现状(我们已经改回来了)。
  // 探测在锁外做,每 SETTINGS_CONTEST_NOTE_MS 最多探一次,⛔ 每轮复验都给对方的代理打一次。
  contenderRestoreSafety(rival) {
    try {
      return withSettingsLock(this.dataDir, () => {
        this.assertRecoveryOwnerLocked()
        const equal = this.adapter.valuesEqual ?? deepEqual
        const satisfied = this.adapter.settingSatisfied
          ? (current, value, ref) => this.adapter.settingSatisfied(current, value, ref) : equal
        // 探测期间又被 C 改过：B 的旧证据作废，交回控制器重新取证；绝不能拿 B 的旧快照还账。
        for (const { ref, value } of this.appliedItems) {
          if (!satisfied(this.adapter.read(ref), value, ref)) return 'changed'
        }
        // 只让给恢复原设置后仍独立生效的代理；不能把来信临时打开的开关/PAC/WPAD
        // 当成 B 自己管理的设置，恢复后留下「地址是 B、实际却没走 B」的假连接。
        for (const entry of loadLedger(this.dataDir)) {
          if (entry.kind !== 'setting' || isSettledSetting(entry)) continue
          if (entry.service === 'WinINET') {
            if (entry.item === 'ProxyEnable' && entry.originalValue?.data !== '1') return 'dependent'
            if (entry.item === 'AutoConfigURL' && entry.originalValue?.data) return 'dependent'
            if (entry.item === 'DefaultConnectionSettings') return 'dependent'
          }
          if (entry.item === 'auto-proxy' && rival.source === `${entry.service}/secure-web-proxy` && entry.originalValue?.enabled) return 'dependent'
        }
        if (rival.source === 'WinINET/ProxyServer') {
          if (!this.winManualProxyAllowed()) return 'dependent'
        }
        return 'safe'
      }, { owner: `contender-preflight:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
    } catch { return 'unknown' }
  }

  winManualProxyAllowed() {
    const blob = this.adapter.read({ service: 'WinINET', item: 'DefaultConnectionSettings' })
    if (blob === null) return true
    if (blob?.type !== 'REG_BINARY') return false
    const parsed = readConnectionSettings(hexToBlob(blob.data))
    return parsed !== undefined && (parsed.flags & (CONNECTION_FLAGS.autoDetect | CONNECTION_FLAGS.autoProxyUrl)) === 0
  }

  contenderPathMatches(rival) {
    try {
      const current = this.adapter.existingProxy?.({ host: '127.0.0.1', port: this.activeBridgePort(), knownPorts: this.knownBridgePorts() })
      if (!current || current.kind !== rival.kind || current.host !== rival.host || current.port !== rival.port) return false
      if (rival.source === 'WinINET/ProxyServer') {
        if (!this.winManualProxyAllowed()) return false
      }
      this.validateExistingProxy(current)
      return true
    } catch { return false }
  }

  resumeLocalAfterFailedYield(intent, rival) {
    if (this.exited || this.intent !== intent || this.contender !== rival || this.recoveryHandedOver()) return
    try {
      const right = this.ensureWriteRight()
      if (!right.ok) throw this.writeRightConflict(right)
      withSettingsLock(this.dataDir, () => {
        this.assertRecoveryOwnerLocked()
        this.syncAppliedItemsWithLedger()
        this.applySettingsLocked()
        this.verifySettingsLocked(false)
      }, { owner: `contender-resume:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      this.log('让路复核未通过:来信本地通道继续承接')
      this.writeStateNow('connected', { ...this.lastVerification, code: 'TUNNEL_SETTINGS_CONTESTED',
        message: '另一款代理在交接时未能确认可用，来信已继续承接网络；请检查另一款代理是否仍在运行' })
    } catch (error) {
      this.log(`让路失败后重新接回本地通道未完成:${error instanceof Error ? error.message : String(error)}`)
      void this.handleConnectFailure(error)
    }
  }

  async handleChangedContenderPath(intent, rival) {
    if (this.exited || this.intent !== intent || this.contender !== rival) return
    let current
    try {
      // 这里刻意不把来信入口从读数中过滤掉：若系统仍指向我们的 bridge，就不能先关通道。
      current = this.adapter.existingProxy?.({ host: '', port: 0, knownPorts: [] })
    } catch {
      const noted = await this.finalizeAfterRestored(intent, () => this.writeStateNow('degraded', {
        ...this.lastVerification, code: 'TUNNEL_VERIFY_UNCONFIRMED', message: '系统代理在交接时暂时读不到，来信保留本地通道并重新检查' }))
      if (noted && this.intent === intent) void this.reverify(true)
      return
    }
    const ours = current?.host === '127.0.0.1' && this.knownBridgePorts().includes(current.port)
    if (ours) { this.resumeLocalAfterFailedYield(intent, rival); return }
    // B 已变成 C/PAC/直连：旧对象身份失效，但不是“第二次争抢就停止”的理由。
    // 本地 bridge 仍活着，保留它并用当前连接意图重新走复验/夺回；不会盲写 C。
    this.contender = undefined
    this.writeStateNow('degraded', { ...this.lastVerification, code: 'TUNNEL_AVAILABILITY_EVIDENCE_CHANGED',
      message: '系统代理在交接时再次变化，来信正在按当前路径重新取证' })
    void this.reverify(true)
  }

  async considerYieldingToContender() {
    const rival = this.contender
    if (rival === undefined || this.exited || this.intent?.desired !== 'connected' || this.reusedProxy !== undefined) return
    const intent = this.intent
    if (this.contenderProbedAt !== undefined && this.clock.now() - this.contenderProbedAt < SETTINGS_CONTEST_NOTE_MS) return
    this.contenderProbedAt = this.clock.now()
    try { await this.probeProxy(rival) } catch { return } // 它出不了外网:我们继续管着客户的网
    if (this.exited || this.intent !== intent || this.intent?.desired !== 'connected' ||
        this.contender !== rival || this.reusedProxy !== undefined) return
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    const safety = this.contenderRestoreSafety(rival)
    if (this.handedOver) { this.exitAfterHandover(); return }
    if (safety === 'changed') { void this.reverify(true); return }
    if (safety !== 'safe') {
      if (safety === 'dependent') this.writeStateNow('connected', { ...this.lastVerification, code: 'TUNNEL_SETTINGS_CONTESTED',
        message: '另一款代理可联网，但依赖来信临时修改的系统设置，不能安全让路；当前由来信保持通道，请关闭其中一款代理以免争抢' })
      return
    }
    this.log(`另一款代理软件 ${rival.host}:${String(rival.port)} 自己能出外网:让给它,来信不再抢(它失效时会自动接管回来)`)
    // 先按账本把系统设置还给对方，再关本地连接。恢复暂时写失败时系统可能仍指向我们的 bridge；
    // 那一刻先关 connector/bridge 会把客户留在 127.0.0.1 的死端口。复用断开/退出同款的有界梯子，
    // 梯子落定前本地通道保持承接；恢复成功、系统已走 rival 后才关闭。
    const recovered = await this.restoreWithRetryLadder('让路给另一款代理时原设置恢复未完成', {
      checkHandover: true,
      keepWriteRight: true,
      shouldContinue: () => !this.handedOver && !this.exited && this.intent === intent && this.intent?.desired === 'connected' &&
        this.contender === rival && this.reusedProxy === undefined
    })
    if (this.handedOver) { this.exitAfterHandover(); return }
    if (!recovered || this.exited || this.intent !== intent || this.intent?.desired !== 'connected' || this.contender !== rival) return
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    if (!this.contenderPathMatches(rival)) { await this.handleChangedContenderPath(intent, rival); return }
    try { await this.probeProxy(rival) } catch {
      if (this.contenderPathMatches(rival)) this.resumeLocalAfterFailedYield(intent, rival)
      else await this.handleChangedContenderPath(intent, rival)
      return
    }
    if (this.exited || this.intent !== intent || this.intent?.desired !== 'connected' || this.contender !== rival) return
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    if (!this.contenderPathMatches(rival)) { await this.handleChangedContenderPath(intent, rival); return }
    await this.stopConnection()
    if (this.exited || this.intent !== intent || this.intent?.desired !== 'connected' || this.contender !== rival) return
    if (!this.restoreSettings({ checkHandover: true, keepWriteRight: true })) {
      if (this.handedOver) this.exitAfterHandover()
      return
    }
    let finalized = false
    let reArbitrate = false
    await this.finalizeAfterRestored(intent, () => {
      if (!this.contenderPathMatches(rival)) {
        // 本地通道已经停下且系统路径变了：不宣布旧 B 成功，也不把旧快照写回 C。
        // 释放本次租约后以同一当前意图重新读取/探测 C，能复用就复用，不能才走受控接管。
        this.contender = undefined
        reArbitrate = true
        finalized = this.writeStateNow('connecting', { code: 'TUNNEL_AVAILABILITY_EVIDENCE_CHANGED',
          message: '系统代理在交接时再次变化，来信正在按当前路径重新取证' })
        return finalized
      }
      this.contender = undefined
      this.settingsRepairs = 0
      this.lastSettingsRepairAt = undefined
      this.reusedProxy = rival
      this.lastVerification = { exitIp: '', lastVerifiedAt: this.clock.now() }
      finalized = this.writeReusedState() === true
      if (finalized) this.scheduleVerify()
      else this.reusedProxy = undefined
      return finalized
    })
    // 成功复用或重新取证状态都已落盘，才交还系统级写权；新意图接手时由新流程自行收尾。
    if (finalized && this.intent === intent && !this.handedOver) this.releaseWriteRight()
    if (reArbitrate && finalized && this.intent === intent && !this.handedOver) void this.connect()
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
        this.verifyingConnector === this.connector || this.confirmationTimer !== undefined ||
        this.settingsBusyTimer !== undefined) {
      return
    }
    const connector = this.connector
    const intent = this.intent
    const availabilityIntent = this.availabilityIntentFor(intent)
    this.verifyingConnector = connector
    const stillCurrent = () => !this.exited && ['connected', 'degraded'].includes(this.state) && this.intent === intent &&
      this.intent?.desired === 'connected' && this.connector === connector && this.availability.activeIntent?.generation === availabilityIntent.generation
    try {
      // 复查的拿锁用短上限(撞锁就顺延,见 catch):复查不是要紧着拿锁的路径,⛔ 用默认上限把主线程冻住。
      this.verifySettings(true, { timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      const { exitIp } = await this.verifyConnection(connector)
      // applySettings 内部在 settingsApplied 时已复验一轮(其内 mismatch 会 throw,与再显式 verify 等价);
      // 稳态下其后零写入,⛔ 再跑第三次逐项读回(Windows 每读 = spawn reg.exe,30s 一拍全是纯重复)。
      if (stillCurrent()) { this.applySettings({ timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS }) }
      if (stillCurrent()) {
        this.completeAvailabilityAction(this.availabilityReclaimOperation, { readbackMatches: true, targetReachable: true })
        this.availabilityReclaimOperation = undefined
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
      if (error instanceof SettingsBusyError) {
        // 锁被占(含确认轮)只说明「设置这会儿动不了」,说明不了通道好坏:⛔ 降级、⛔ 拆连接、⛔「连接中断」。
        // 这一轮设置检查顺延,锁放开后补做——占锁期间系统代理被人改了,补做的 verifySettings(repair)
        // 照样发现并按原有争抢规则处理;补做没做成前一直排下一拍,⛔ 吞掉锁忙就不再检查。
        this.deferReverifyForSettingsLock(confirming)
        return
      }
      this.finishFailedReclaim(error)
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

  /** 复查撞设置锁的顺延位:一拍之后重跑同一轮复查(确认轮保持确认轮),锁放开即补做;⛔ 吞掉不再查。 */
  deferReverifyForSettingsLock(confirming) {
    if (this.settingsBusyTimer !== undefined) return
    this.settingsBusyTimer = this.clock.setTimeout(() => {
      this.settingsBusyTimer = undefined
      void this.reverify(confirming)
    }, SETTINGS_BUSY_RETRY_MS)
  }

  onConnectionLost(error) {
    if (this.exited || this.transitioning) {
      return
    }
    if (!['connected', 'degraded'].includes(this.state) || this.intent?.desired !== 'connected') {
      return // 用户主动断开等场景:守护 ⛔ 拉起(判据 2)
    }
    if (this.reconnectEpisodeStartedAt === undefined) {
      // 新故障片段的唯一入口(此前必须真的连上过):起点即恢复事件的 id,桌面按它去重。
      // 旧片段还没被消费的恢复事件一并压掉——新故障期间弹「已恢复」会误导。
      this.reconnectEpisodeStartedAt = this.clock.now()
      this.reconnectTries = 0
      this.recoveryNotice = undefined
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
    // 设置锁忙(establish 中途撞上等):另一项设置任务在进行,与通道无关。⛔ 按连接失败处理——
    // 那会写失败态、停连接、进「连接中断,自动重连中」,而此时客户多半还没连上过。记「连接中」+锁忙码
    // (界面经 connectionMessage 出人话),短轮询后原路重走 connect。
    if (code === 'SETTINGS_LOCK_BUSY' || code === 'TUNNEL_SETTINGS_BUSY') {
      this.waitOutSettingsLock(code)
      return
    }
    // 甲-6:失败路径在最后一环留证——错误名/码＋截断首行进守护日志(诊断包收集时逐行 redact)。
    // 此前这里一行不写:连接器保留的细节(ssh 退出码、stderrTail、spawn 原文)全在这丢;
    // ssh 被拒/杀软删组件/程序 bug 三种病在客服和数据里长一个样。
    this.log(`连接失败[${errorNameOf(error)}] code=${String(code)}:${firstLineOf(error)}`)
    // message 仍写 code(界面按码查文案表,是既有架构)。但「对方当前是什么状态」是**动态**的,
    // 查不了静态表 —— 单独落一个白名单状态词,由界面拼进那句话。
    // ⛔ 把它塞进 message:那样文案表就查不到、客户又会看到裸码。
    // ⛔ 只在第一处带上它:下面致命分支会再写一次 state,漏了就等于没落(用例盯着这一点)。
    const failureState = typeof error?.peerState === 'string' && error.peerState !== ''
      ? { code, message: code, peerState: error.peerState }
      : { code, message: code }
    this.writeStateNow('error', failureState)
    if (FATAL_CODES.has(code)) {
      await this.stopForFatal(code, failureState)
      return
    }
    const intent = this.intent
    const stopping = this.stopConnection()
    const epoch = this.reconnectEpoch
    if (!await this.stopAndRestoreForReconnect(stopping, intent, epoch)) return
    if (this.exited || this.intent !== intent || this.reconnectEpoch !== epoch) return
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    if (!this.restoreSettings({ checkHandover: true }) && !this.settingsBusy) {
      if (this.handedOver) this.exitAfterHandover()
      return
    }
    await this.finalizeAfterRestored(intent, () => this.enterReconnect(code))
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
    const intent = this.intent
    const slow = this.reconnectAttempts >= RECONNECT_BACKOFF_MS.length
    if (!slow) this.reconnectAttempts += 1
    this.reconnectTries += 1
    this.log(slow ? '低频重连尝试' : `重连尝试 ${this.reconnectAttempts}/5`)
    try {
      // 单入口且中继仍在监听时保留原设置；若停止连接器期间中继已死，立即按账本还原。
      if (!await this.stopAndRestoreForReconnect(this.stopConnectorOnly(), intent, epoch,
        { preserveLiveBridge: this.bridge })) return
      const connectorHandover = this.connectionOwnerFence(intent, epoch)
      if (connectorHandover !== undefined) await connectorHandover
      // 多入口换序或旧桥失效都要收旧桥；关闭挂起时不能让系统代理指向死端口。
      const rotate = this.rotateEntry()
      if (this.bridge !== undefined && (rotate || this.bridge.isAlive?.() === false)) {
        const bridge = this.bridge
        this.bridge = undefined
        if (!await this.stopAndRestoreForReconnect(this.queueBridgeTeardown(bridge), intent, epoch)) return
      }
      const bridgeHandover = this.connectionOwnerFence(intent, epoch)
      if (bridgeHandover !== undefined) await bridgeHandover
      // stopConnector / bridge teardown 都可能卡住。期间新意图会通过 stopConnection 推进 epoch；
      // 旧重连在任何 establish/共享 Xray 文件写入前必须复查归属，⛔ 迟到地再建第三代。
      if (this.exited || this.authorizationStopped || this.fatalStopped ||
          this.intent?.desired !== 'connected' || epoch !== this.reconnectEpoch) return
      // 只重建连接器:bridge 与系统设置仍归本会话账本,⛔ 重复记账写入(否则原值被覆盖成我们自己的值)。
      await this.establish()
      if (this.exited || epoch !== this.reconnectEpoch) {
        // 已有更新的恢复接管或连接已停(退出/断开不认这笔成功):沿用原静默归零,⛔ 补写恢复下文。
        this.reconnectAttempts = 0
        return
      }
      this.recordRecoverySuccess(slow)
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
        // 致命停止要显式记档并继续承担系统代理恢复；只有新意图驱动的 connect() 才清除致命闸。
        await this.stopForFatal(code)
        return
      }
      // 这次没连上:中继要是没起来(内核起不来/端口没监听),先把系统代理还给客户再等下一轮。
      this.releaseSettingsForRecovery()
      this.writeStateNow('error', { code, message: this.reconnectMessage() })
      this.scheduleReconnect()
    }
  }

  // N-27:恢复成功必须留下下文——此前 establish 后 attempts 静默归零,日志停在「重连尝试 4/5」没有下文,
  // 客户与客服都不知道「何时恢复的」。日志给次数与中断时长;真实故障片段(此前真的连上过)再挂一条待展示
  // 事件随 state 下发,桌面读到弹一次系统通知。初连失败后的自动重试接上没有「中断」可言:只记日志,⛔ 弹通知。
  recordRecoverySuccess(slow) {
    const startedAt = this.reconnectEpisodeStartedAt
    const tries = this.reconnectTries
    this.reconnectEpisodeStartedAt = undefined
    this.reconnectTries = 0
    if (startedAt === undefined) {
      this.log(`重连成功：自动重连第 ${String(tries)} 次尝试后接上${slow ? '（低频阶段）' : ''}`)
      return
    }
    const outageMs = Math.max(0, this.clock.now() - startedAt)
    this.log(`重连成功：第 ${String(tries)} 次重连后通道恢复，本次中断 ${outageWords(outageMs)}${slow ? '（低频阶段接上）' : ''}`)
    this.recoveryNotice = { id: startedAt, attempts: tries, outageMs }
    // 立刻重写一份带事件的 state:通知不等下一拍复验(≤30s),恢复完 5 秒内桌面就该看到。
    this.writeStateNow('connected', { ...(this.lastVerification ?? {}) })
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
        this.assertRecoveryOwnerLocked()
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
      await this.stopAndTrackConnector(connector)
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

  stopAndTrackConnector(connector) {
    let stopping
    try { stopping = Promise.resolve(connector.stop()) } catch (error) { stopping = Promise.reject(error) }
    const outcome = stopping.then(() => true, () => {
      this.connectorStopFailed = true
      return false
    })
    this.pendingConnectorStops.add(outcome)
    void outcome.then(() => this.pendingConnectorStops.delete(outcome))
    return stopping
  }

  async stopConnection() {
    this.reconnectEpoch += 1
    // 在第一个 await 前同时摘走旧 connector 与旧 bridge。停止动作可能卡在子进程退出；
    // 这期间新意图能建立新连接，旧停止回来时只能关闭自己的快照，⛔ 再读 this.bridge 误杀新通道。
    const connector = this.connector
    const bridge = this.bridge
    this.connector = undefined
    this.bridge = undefined
    const bridgeTeardown = this.queueBridgeTeardown(bridge)
    this.reusedProxy = undefined
    this.entryConnectors = undefined
    this.clearVerify()
    this.clearTraffic()
    this.settingsApplied = false
    this.appliedItems = []
    this.settingsReleased = false
    // N-27:连接彻底停了(用户断开/关停/致命/授权停),故障片段与待展示恢复事件一并作废
    // ——恢复知情只属于「断了又自己接上」的片段,⛔ 随后的非 connected 状态还带着「已恢复」。
    this.reconnectEpisodeStartedAt = undefined
    this.reconnectTries = 0
    this.recoveryNotice = undefined
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimer(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const connectorStopping = connector === undefined ? Promise.resolve() : this.stopAndTrackConnector(connector)
    await Promise.all([connectorStopping, bridgeTeardown])
  }

  // 保持连接意图的三条入口也可能卡在旧通道停止。先按账本还原死代理，再等停止确认；
  // 到期仍未停就重启守护，绝不在旧桥未收完时创建新桥或宣称 connected。
  async stopAndRestoreForReconnect(stopping, intent, epoch, { preserveLiveBridge, onStopIncomplete } = {}) {
    let finished
    const completion = stopping.then(
      () => { finished = true; return true },
      () => { finished = false; return false }
    )
    let deadline
    const timedCompletion = Promise.race([completion, new Promise((resolve) => {
      deadline = this.clock.setTimeout(() => resolve(false), 30_000)
    })])
    let bridgeCheckTimer
    try {
      if (preserveLiveBridge !== undefined && preserveLiveBridge.isAlive?.() !== false) {
        const bridgeStopped = new Promise((resolve) => {
          const check = () => {
            if (preserveLiveBridge.isAlive?.() === false) resolve(true)
            else bridgeCheckTimer = this.clock.setTimeout(check, 250)
          }
          check()
        })
        await Promise.race([timedCompletion, bridgeStopped])
        if (finished === true && preserveLiveBridge.isAlive?.() !== false) return true
      }
      // 没有旧设置账目时无需进入持续恢复梯子；首次连接仍走原有的短锁等待。
      const restoreNeeded = unrestoredEntries(this.dataDir).length > 0
      const [timedStopped, restored] = await Promise.all([timedCompletion,
        restoreNeeded ? this.restoreWithRetryLadder('重连前原设置恢复未完成', {
          checkHandover: true,
          stayUntilRestored: true,
          timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS,
          shouldContinue: () => !this.exited && !this.handedOver && this.intent === intent &&
            this.reconnectEpoch === epoch && this.intent?.desired === 'connected'
        }) : Promise.resolve(true)])
      if (this.handedOver) {
        if (onStopIncomplete !== undefined) await this.waitForStop(onStopIncomplete())
        this.exitAfterHandover()
        return false
      }
      if (!restored || this.exited || this.intent !== intent || this.reconnectEpoch !== epoch) return false
      if (restoreNeeded) {
        this.syncAppliedItemsWithLedger()
        this.settingsReleased = true
        this.settingsReleaseFailed = false
      }
      if ((finished ?? timedStopped) !== true) {
        // 先发出本代连接器停止指令；即使旧桥和新连接器都挂住，先把错误态交给界面。
        const connectorCleanup = onStopIncomplete === undefined ? undefined :
          this.waitForStop(onStopIncomplete()).catch(() => false)
        const noted = await this.finalizeAfterRestored(intent, () => this.writeStateNow('error', { code: 'TUNNEL_STOP_INCOMPLETE',
          message: '原网络设置已恢复，但旧通道未能停止；正在重启网络守护并恢复连接' }))
        if (noted && !this.exited && this.intent === intent && this.reconnectEpoch === epoch) {
          if (connectorCleanup !== undefined) await connectorCleanup
          if (this.handedOver || this.recoveryHandedOver()) { this.exitAfterHandover(); return false }
          if (!this.exited && this.intent === intent && this.reconnectEpoch === epoch) this.exit(65)
        }
        return false
      }
      return true
    } finally {
      if (deadline !== undefined) this.clock.clearTimer(deadline)
      if (bridgeCheckTimer !== undefined) this.clock.clearTimer(bridgeCheckTimer)
    }
  }

  // 恢复梯子会在意图更新时让位，新连接却仍须等旧 bridge.close；旧桥永久不退时独立兜底。
  watchStalledBridgeTeardown() {
    const tail = this.bridgeTeardownTail
    let deadline
    const recoverAndRestart = () => {
      if (this.exited || this.handedOver || this.pendingBridgeTeardowns.size === 0) return
      let restored = false
      try {
        restored = this.restoreSettings({ checkHandover: true })
      } catch (error) {
        this.log(`旧桥接停止超时后的网络恢复失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (this.handedOver) { this.exitAfterHandover(); return }
      if (!restored) {
        // 仍指向死端口时不能退出：继续持有账本责任，直到设置还原或桥接自行收尾。
        deadline = this.clock.setTimeout(recoverAndRestart, 5_000)
        return
      }
      this.writeStateNow('error', { code: 'TUNNEL_STOP_INCOMPLETE',
        message: '旧网络通道未能停止；正在重启网络守护并恢复连接' })
      this.exit(65)
    }
    deadline = this.clock.setTimeout(recoverAndRestart, 30_000)
    void tail.then(() => this.clock.clearTimer(deadline))
  }

  shutdown() {
    if (this.exited || this.shutdownTask) return
    // 信号/父进程断开必须能打断正在连接的任务，不受 transitioning 闸阻挡。
    this.intent = { desired: 'shutdown' }
    this.availabilityIntentFor(this.intent)
    this.transitioning = true
    this.intentTransitionGeneration += 1
    this.shutdownTask = (async () => {
      if (!await this.recordIntent('shutdown')) return
      const currentStopping = this.stopConnection().then(() => true, () => {
        this.log('关停时后台通道关闭失败，继续还原原网络设置')
        return false
      })
      // bridge 有串行收尾队列；所有 connector 的未决/失败结果在最终判定 helper 中统一核对。
      // 退出时恢复失败 ⛔ 一次就走(发布审查 R1):中继已关,代理还指着它就是整机断网。按节奏持续重试。
      // 同一数据目录的设置恢复只能有一个当前所有者(GPT-6 复核 2bf4fa9 #1):客户在我们还在慢恢复时重开工具箱,
      // 新守护会先按账本还掉我们的旧账、再连上并写它自己的账;这时我们再动设置/账本/状态,等于把客户刚连上的通路拆掉。
      // 所以每次恢复动作前都先看一眼:本守护启动后是否已有新守护在锁内发布更高代次 → 交权,什么都不碰,直接走。
      // 判交接与恢复在同一把跨进程锁里(restoreSettings checkHandover):判完别人 ⛔ 还能插进来接手并被旧快照覆盖
      let recovered = await this.restoreWithRetryLadder('退出时原设置恢复未完成', {
        checkHandover: true,
        stayUntilRestored: true,
        shouldContinue: () => !this.handedOver && !this.exited
      })
      if (this.handedOver) { this.exitAfterHandover(); return }
      if (this.exited) return
      const stopped = recovered && await this.waitForStop(currentStopping)
      if (this.handedOver || this.recoveryHandedOver()) { this.exitAfterHandover(); return }
      if (this.exited) return
      // 锁忙只说明仍有人在处理设置，不等于新守护接管。持续补做最终状态；只有确实看到新代次才 exit 0。
      const retryDelays = [0, ...SHUTDOWN_RESTORE_RETRY_MS, ...Array(SHUTDOWN_RESTORE_SLOW_ROUNDS).fill(SHUTDOWN_RESTORE_SLOW_MS)]
      for (const delay of retryDelays) {
        if (delay > 0) await new Promise((resolve) => this.clock.setTimeout(resolve, delay))
        if (this.exited) return
        let finalHandover = false
        try {
          withSettingsLock(this.dataDir, () => {
            if (this.recoveryHandedOver()) { finalHandover = true; return }
            if (recovered) this.writeStateNow(stopped ? 'stopped-restored' : 'error', !stopped
              ? { code: 'TUNNEL_STOP_INCOMPLETE', message: '原网络设置已恢复，但后台通道未能停止；正在重启网络守护完成清理' }
              : {})
          }, { owner: `shutdown:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
        } catch (error) {
          if (this.recoveryHandedOver()) { this.exitAfterHandover(); return }
          if (!(error instanceof SettingsBusyError)) throw error
          this.log('退出最终状态等待系统设置锁释放')
          continue
        }
        if (finalHandover) { this.exitAfterHandover(); return }
        this.exit(recovered && stopped ? 0 : 65)
        return
      }
      throw new SettingsBusyError('退出最终状态持续被系统设置锁阻塞')
    })().catch(() => {
      // 失败收尾也不能越过新守护写状态；锁仍忙时不再覆盖任何状态，按未完成退出交下次启动。
      let finalHandover = false
      try {
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { finalHandover = true; return }
          this.writeStateNow('error', { code: 'TUNNEL_RESTORE_INCOMPLETE', message: '通道已停止，原设置恢复未完成，请重新打开工具箱重试恢复' })
        }, { owner: `shutdown-error:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch { /* 保留盘上状态；账本恢复责任仍在 */ }
      if (finalHandover || this.recoveryHandedOver()) { this.exitAfterHandover(); return }
      this.exit(65)
    })
  }

  requestShutdown() { this.shutdown() }

  // 恢复权是否已交给别的守护:与崩溃兜底同一规则(recoveryOwnedByOther)。
  recoveryHandedOver() { return recoveryOwnedByOther(this.dataDir, this.runId, this.recoveryOwnershipObserved) }

  // 新一代只能在 settings lock 内发布 owner；同锁核对后才准落状态、账本或系统设置。
  // 抛取消哨兵而非只 exit：测试注入的 onExit 会返回，旧异步调用链不能继续写下一项。
  assertRecoveryOwnerLocked() {
    assertSettingsLockHeld(this.dataDir)
    if (!this.recoveryHandedOver()) return
    this.handedOver = true
    this.exitAfterHandover()
    throw Object.assign(new Error('恢复责任已交接'), { code: 'TUNNEL_CONNECTION_CANCELLED' })
  }

  exitAfterHandover() {
    this.log('新的守护已接手同一数据目录:本进程不再改设置、账本与状态,直接退出')
    this.exit(0, { preserveTraffic: true })
  }

  async failLedger(failure) {
    await this.stopConnection()
    this.writeStateNow('error', failure)
    this.exit(65)
  }

  async recordIntent(intent) {
    try {
      withSettingsLock(this.dataDir, () => {
        this.assertRecoveryOwnerLocked()
        appendIntentEntry(this.dataDir, { intent, time: this.clock.now() })
      }, { owner: `intent:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      this.pendingIntentRecord = undefined
      return true
    } catch (error) {
      if (this.exited) return false
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
    this.assertRecoveryOwnerLocked()
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
      let handedOver = false
      try {
        withSettingsLock(this.dataDir, () => {
          if (this.recoveryHandedOver()) { handedOver = true; return }
          this.recoveryOwnerPublishFailed = false
          const conflict = this.writeRightConflict(right)
          this.log(`系统代理写入权不在本进程:本次不还原,保持现值(${conflict.code})`)
          if (!this.exited) this.writeStateNow('error', { code: conflict.code, message: conflict.message })
        }, { owner: `restore-conflict:${this.runId}`, timeoutMs: options.timeoutMs ?? SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch (error) {
        if (!(error instanceof SettingsBusyError)) throw error
        this.settingsBusy = true
        this.log('写入权冲突时系统设置锁仍被占用,稍后重试恢复')
        return undefined
      }
      this.settingsBusy = false
      if (handedOver) this.handedOver = true
      return undefined
    }
    const recoveryEntries = pendingSettingEntries(this.dataDir)
    const recoveryOperation = recoveryEntries.length === 0 ? undefined : this.beginAvailabilityAction('restore', {
      refs: recoveryEntries.map((entry) => ({ service: entry.service, item: entry.item })),
      snapshot: { id: `restore-snapshot:${String(this.sessionToken)}:${String(this.clock.now())}`,
        value: recoveryEntries.map((entry) => ({ id: entry.id, originalValue: entry.originalValue, writtenValue: entry.writtenValue })) },
      writtenValue: { lease: this.writeRightToken ?? this.runId }
    })
    try {
      // 归属判定与恢复同一把锁；所有入口都按构造时的 owner 基线检查后来发布的更高代次。
      // options 可带 timeoutMs(连接入口的检查性拿锁用短上限);keepWriteRight 不是锁参数,锁层忽略。
      const result = withSettingsLock(this.dataDir, () => {
        if (this.recoveryHandedOver()) return 'handed-over'
        this.flushPendingIntent()
        const restored = restoreLedger(this.dataDir, this.adapter)
        if (options.claimRecovery === true) {
          let generation
          try {
            generation = publishRecoveryOwner(this.dataDir, this.runId, this.recoveryOwnershipObserved.generation)
          } catch {
            return 'recovery-owner-publish-failed'
          }
          this.recoveryOwnerPublishFailed = false
          this.recoveryOwnershipObserved = {
            generation
          }
        }
        return restored
      }, { owner: `restore:${this.runId}`, ...options })
      this.settingsBusy = false
      if (result === 'recovery-owner-publish-failed') {
        // 本轮账本恢复已经执行，但没有原子发布 owner 就不能声称接管完成。仍持权写清失败状态，随后
        // finally 交还全局写权，让下一格能重新取得；即使梯子最终用尽，也不把别的守护永久挡在门外。
        this.recoveryOwnerPublishFailed = true
        const settingsIncomplete = unrestoredEntries(this.dataDir).length > 0
        if (settingsIncomplete) this.fatalStopped = true
        try {
          if (!this.exited) this.writeStateNow('error', {
            code: RECOVERY_OWNER_PUBLISH_FAILED,
            message: settingsIncomplete
              ? '原设置恢复尚未完成，且恢复责任记录保存失败，正在重试；本次不继续连接'
              : '原设置已恢复，但恢复责任记录保存失败，正在重试；本次不继续连接'
          })
        } finally {
          // 状态写本身若也遇到 I/O 故障，异常要继续上抛，但绝不能因此把系统级写权留在本进程。
          this.releaseWriteRight()
        }
        return undefined
      }
      // 已明确移交给同目录的新守护:设置归它管,权也不该攥在我们手里。
      if (result === 'handed-over') { this.handedOver = true; this.releaseWriteRight(); return undefined }
      if (result.notifyFailed) this.scheduleNotifyRetry()
      if (unrestoredEntries(this.dataDir).length > 0) {
        if (recoveryOperation !== undefined) this.availability.finishRecovery(recoveryOperation, { readbackMatches: false })
        this.fatalStopped = true
        this.writeStateNow('error', { code: 'TUNNEL_RESTORE_INCOMPLETE', message: '原网络设置尚未恢复，尚不能确认已断开。其他软件修改的设置会保留' })
        // ⛔ 在这里交权:还欠着未恢复项,系统代理仍是我们的责任,交出去别人也还不了(账本在我们的数据目录)。
        return undefined
      }
      // 设置已经干净地还给客户了 —— 这把权必须交还(P1)。
      // ⛔ 攥着它:常驻守护还活着时,另一份安装会一直被误挡成「有人正在管理网络」。
      // 用户主动断开、授权到期停止、致命停止都经由这里,统一在这一处交还,⛔ 在每个停止点各写一遍(会漏)。
      // 例外是「为了接管而还原」(keepWriteRight),那次还原之后紧接着就要写新设置。
      if (recoveryOperation !== undefined) {
        const restoredCount = Array.isArray(result?.restored) ? result.restored.length : 0
        if (restoredCount > 0) this.availability.markWritten(recoveryOperation)
        const preservedExternal = Array.isArray(result?.keptModified) && result.keptModified.length > 0
        this.availability.finishRecovery(recoveryOperation, { readbackMatches: true, preservedExternal })
      }
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
    if (this.settingsBusyTimer !== undefined) {
      this.clock.clearTimer(this.settingsBusyTimer)
      this.settingsBusyTimer = undefined
    }
    if (this.recoveryOwnerRetryTimer !== undefined) {
      this.clock.clearTimer(this.recoveryOwnerRetryTimer)
      this.recoveryOwnerRetryTimer = undefined
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
    if (this.recoveryHandedOver()) { this.handedOver = true; this.exitAfterHandover(); return }
    const current = bridge.traffic()
    if (this.bridge !== bridge || !Number.isSafeInteger(current.uploadBytes) || !Number.isSafeInteger(current.downloadBytes) ||
        !Number.isSafeInteger(current.observedAt) || current.uploadBytes < 0 || current.downloadBytes < 0 || current.observedAt < 1) return
    if (current.activeStreams !== undefined && (!Number.isSafeInteger(current.activeStreams) || current.activeStreams < 0)) return
    const previous = this.lastTraffic
    const elapsedSeconds = previous && current.observedAt > previous.observedAt ? (current.observedAt - previous.observedAt) / 1000 : 0
    const uploadBytesPerSecond = elapsedSeconds === 0 ? 0 : Math.floor(Math.max(0, current.uploadBytes - previous.uploadBytes) / elapsedSeconds)
    const downloadBytesPerSecond = elapsedSeconds === 0 ? 0 : Math.floor(Math.max(0, current.downloadBytes - previous.downloadBytes) / elapsedSeconds)
    this.lastTraffic = current
    // Phase 1 ②(M5 长跑证实 4.3 万次/日):观察保持 2s 一档(速率精度、断线结算不受影响),
    // 落盘条件化——内容有变化才写,外加空闲心跳保 UI。活动流量每次观察累计值都在变,节奏与
    // 基线相同;空闲挂机从 43,200 次/日 降到 ≈2,880 次/日,杀软/同步盘不再被零流量写盘狂醒。
    // 心跳 30s 必须短于主进程状态行的新鲜窗口(status-service trafficSummary 45s,两侧同改),
    // ⛔ 丢已积累的速率统计:停写超过窗口会把速率图的历史断档清零。
    const payload = { source: 'local-proxy-entry', uploadBytes: current.uploadBytes, downloadBytes: current.downloadBytes,
      uploadBytesPerSecond, downloadBytesPerSecond, activeStreams: current.activeStreams ?? 0,
      interruptedStreams: this.interruptedStreams, torndownStreams: this.torndownStreams }
    const last = this.lastTrafficWritten
    const unchanged = last !== undefined && last.uploadBytes === payload.uploadBytes && last.downloadBytes === payload.downloadBytes &&
      last.uploadBytesPerSecond === payload.uploadBytesPerSecond && last.downloadBytesPerSecond === payload.downloadBytesPerSecond &&
      last.activeStreams === payload.activeStreams && last.interruptedStreams === payload.interruptedStreams &&
      last.torndownStreams === payload.torndownStreams
    const heartbeatDue = last === undefined || this.clock.now() - last.writtenAtClock >= TRAFFIC_HEARTBEAT_MS
    if (unchanged && !heartbeatDue) return
    try {
      // bridge.traffic() 期间也可能交接；最终共享文件写入与 owner 核验必须同锁。
      withSettingsLock(this.dataDir, () => {
        this.assertRecoveryOwnerLocked()
        writeTraffic(this.dataDir, { ...payload, updatedAt: current.observedAt })
      }, { owner: `traffic:${this.runId}`, timeoutMs: 0 })
      this.lastTrafficWritten = { ...payload, writtenAtClock: this.clock.now() }
    } catch {
      // 锁忙或本地遥测写入失败不影响连接；下一次流量节拍会重试。
    }
  }

  clearTraffic(remove = true) {
    if (this.trafficTimer !== undefined) {
      this.clock.clearTimer(this.trafficTimer)
      this.trafficTimer = undefined
    }
    this.lastTraffic = undefined
    this.lastTrafficWritten = undefined
    if (remove) {
      try {
        withSettingsLock(this.dataDir, () => {
          if (!this.recoveryHandedOver()) rmSync(trafficPath(this.dataDir), { force: true })
        }, { owner: `traffic-clear:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      } catch { /* Stale telemetry never blocks connection teardown. */ }
    }
  }

  writeStateNow(state, extra = {}) {
    try {
      withSettingsLock(this.dataDir, () => {
        this.assertRecoveryOwnerLocked()
        this.state = state
        // 持权期间写出的每一份 state 都盖上本轮令牌:后启动者据此确认「这份状态确实是当前持权者写的」。
        writeState(this.dataDir, { state, runId: this.runId, sessionToken: this.sessionToken,
          intentToken: this.intent?.sessionToken ?? '', bridgePort: this.activeBridgePort(), note: this.optionalNote, code: '', message: '',
          ...(typeof this.writeRightToken === 'string' ? { writeRightToken: this.writeRightToken } : {}), ...extra,
          availability: this.availabilityView(),
          // 恢复事件随后续状态存续到桌面消费、下一段故障或停止为止。
          ...(this.recoveryNotice !== undefined ? { recovery: this.recoveryNotice } : {}) })
        if (state === 'connected' && Number.isFinite(extra.lastVerifiedAt)) {
          const verified = JSON.stringify({ verifiedAt: extra.lastVerifiedAt })
          writeFileSync(join(this.dataDir, 'connection-verified.json.tmp'), verified, { mode: 0o600 })
          renameSync(join(this.dataDir, 'connection-verified.json.tmp'), join(this.dataDir, 'connection-verified.json'))
        }
      }, { owner: `state:${this.runId}`, timeoutMs: SETTINGS_BUSY_LOCK_WAIT_MS })
      this.logContinuity(state, extra)
      return true
    } catch (error) {
      if (!(error instanceof SettingsBusyError) || error.code === 'SETTINGS_LOCK_LOST') throw error
      // 锁忙不是新 owner 证据；本拍不抢写盘上状态，原有恢复/重试入口继续承担责任。
      return false
    }
  }

  logContinuity(state, extra) {
    if (!this.continuityEvidence) return
    try {
      const now = this.clock.now()
      const code = extra.code
      const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : ''
      const key = `${state}:${safeCode}`
      // per-key 冷却:重连风暴里 connecting↔error(code) 交替,只比「上一个 key」会让每次都过闸、
      // 每次都拉起取证子进程。同 key 心跳窗口内跳过;不同 key 首次必过。
      const cooledAt = this.continuityCooldowns.get(key)
      if (cooledAt !== undefined && now - cooledAt < CONTINUITY_HEARTBEAT_MS) return
      this.continuityCooldowns.delete(key)
      this.continuityCooldowns.set(key, now)
      if (this.continuityCooldowns.size > CONTINUITY_COOLDOWN_KEYS) {
        for (const [staleKey, staleAt] of this.continuityCooldowns) {
          if (this.continuityCooldowns.size <= CONTINUITY_COOLDOWN_KEYS) break
          if (now - staleAt >= CONTINUITY_HEARTBEAT_MS) this.continuityCooldowns.delete(staleKey)
        }
        for (const [oldestKey] of this.continuityCooldowns) {
          if (this.continuityCooldowns.size <= CONTINUITY_COOLDOWN_KEYS) break
          this.continuityCooldowns.delete(oldestKey)
        }
      }
      const desired = this.intent?.desired
      const bridge = this.bridge === undefined ? 'absent' : this.bridge.isAlive?.() === false ? 'stopped' : 'present'
      const evidence = { event: 'continuity', phase: 'transition', state, code: safeCode,
        desired: ['connected', 'user-disconnected', 'shutdown'].includes(desired) ? desired : 'unknown',
        bridge, reused: this.reusedProxy !== undefined, at: now,
        ...(state === 'connected' && Number.isFinite(extra.lastVerifiedAt) ? { verifiedAt: extra.lastVerifiedAt } : {}) }
      this.log(JSON.stringify(evidence))
      this.continuityPending = evidence
      this.drainContinuityProbe()
    } catch {
      // Diagnostics must never change the network state machine.
    }
  }

  drainContinuityProbe() {
    if (this.continuityProbeActive || this.continuityPending === undefined) return
    const evidence = this.continuityPending
    this.continuityPending = undefined
    this.continuityProbeActive = true
    Promise.resolve().then(() => this.readContinuityFaces?.()).then((faces) => {
      try { this.log(JSON.stringify({ ...evidence, phase: 'sample', sampledAt: this.clock.now(),
        ...(faces === undefined ? { evidence: 'unavailable' } : { faces }) })) } catch { /* best effort */ }
    }).catch(() => {
      try { this.log(JSON.stringify({ ...evidence, phase: 'sample', evidence: 'unavailable' })) } catch { /* best effort */ }
    }).finally(() => {
      this.continuityProbeActive = false
      this.drainContinuityProbe()
    })
  }

  exit(code, { preserveTraffic = false } = {}) {
    if (this.exited) {
      return
    }
    this.exited = true
    this.cancelWriteRightReleaseRetry()
    // 兜底交还写入权:正常路径已在还原/让路处交还,这里防的是异常退出把权攥走
    // (真崩溃由内核标记 abandoned,接手者能认出来;能走到这里就该干净地交)。
    this.releaseWriteRight()
    if (this.intentTimer !== undefined) this.clock.clearTimer(this.intentTimer)
    if (this.parentTimer !== undefined) this.clock.clearTimer(this.parentTimer)
    if (this.authorizationTimer !== undefined) this.clock.clearTimer(this.authorizationTimer)
    this.clearVerify()
    this.clearTraffic(!preserveTraffic)
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimer(this.reconnectTimer)
    }
    if (this.notifyRetryTimer !== undefined) this.clock.clearTimer(this.notifyRetryTimer)
    this.onExit(code)
  }
}
