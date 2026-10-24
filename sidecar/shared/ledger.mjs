// 受管操作账本(定稿第 2 轮 5):持久文件,写前记原值/写入值/会话令牌。
// 形态:单个 JSON 数组文件,整文件原子重写(临时文件 + rename),写频率低、体积小。
// kill -9 只会留下旧版完整文件,不会出现半截账本。
import { appendFileSync, writeFileSync, readFileSync, renameSync, existsSync, mkdirSync, lstatSync, rmSync, statSync, linkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { uptime } from 'node:os'
import { createRequire } from 'node:module'

export const ENTRY_STATUS = Object.freeze({
  applied: 'applied', // 已生效
  restored: 'restored', // 已恢复
  preserved: 'preserved', // 已保留后来改动,本次恢复责任结束
  keptModified: 'kept-modified', // 未恢复:已被改动
  restoreFailed: 'restore-failed' // 未恢复:失败
})

// 可选设置服务(终端自动接入):它的写入/恢复失败 ⛔ 挡住系统代理网络(发布审查 R2)。
// 恢复照样每次重试,只是不进「未恢复→拒绝连接」的门槛。
export const OPTIONAL_SETTING_SERVICES = Object.freeze(new Set(['TerminalEnvironment']))
export function isOptionalSettingService(service) {
  return OPTIONAL_SETTING_SERVICES.has(service)
}

export function isSettledSetting(entry) {
  return entry.status === ENTRY_STATUS.restored || entry.status === ENTRY_STATUS.preserved
}

export function ledgerPath(dataDir) {
  return join(dataDir, 'ledger.json')
}

// ---- 跨进程互斥(GPT-6 复核 be04e6a):恢复设置、应用设置、账本读改写、状态交接不能跨进程重叠 ----
// 形态:数据目录下 settings.lock,O_EXCL 原子创建,内容记持有者 pid/令牌;等锁用同步自旋(这些路径全是同步代码)。
// 持有者进程已不在 → 遗留锁,抢过来(持有协调权的进程异常退出 ⛔ 让恢复责任永久丢失);持有者还活着就等,超时抛 SettingsBusyError
// (瞬时错误:调用方按「稍后再试」处理,⛔ 当致命)。同一进程内可重入(同一进程里的同步代码本就不会交错)。
export class SettingsBusyError extends Error {
  constructor(holder) {
    super('系统设置正被另一恢复任务占用，稍后自动重试')
    this.code = 'SETTINGS_LOCK_BUSY'
    this.holder = holder
  }
}

export function settingsLockPath(dataDir) {
  return join(dataDir, 'settings.lock')
}

const heldLocks = new Map() // dataDir → { depth, token, ino }
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不能阻塞的环境:直接重试 */ } }

/** 进程还在不在:kill(pid,0) 探一下。EPERM = 在但不归我们管,同样算在。 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// ---- 持有者身份对账(PID 复用防线)----
// kill(pid,0) 只回答「这个号码有没有人」,不回答「是不是当初拿锁的那个人」。持有者崩溃后
// PID 被系统复用给无关进程时(同一次开机内就会发生),只查活性会把路人当成守护:界面显示已连
// 而代理指向死端口,新守护静默让位,系统自愈被击穿。所以锁里记下持有者自己的启动时刻,
// 判活时与该 PID **现在**的启动时刻对账——同一个号码、不是同一个人,当场现形。
// (sweepOrphanXray 的「早于本次开机」判据只挡跨开机复用,挡不住同一次开机内的复用。)

/** 本进程自己的启动时刻(ms):拿锁时写进锁里,给将来的判活者对账用。 */
export function currentProcessStartedAt(now = Date.now) {
  return now() - process.uptime() * 1_000
}

// mac/Linux 的 ps 只给到秒级,两侧读数各差半秒以内;Windows 的 GetProcessTimes 精确到 100ns。
// 容差按最粗的一侧留:2.5 秒。
const STARTED_AT_TOLERANCE_MS = 2_500
// 启动时刻的短 TTL 记忆:alive() 挂在状态轮询上、设置锁等锁循环每 10ms 看一眼,
// ⛔ 每次都起一个 ps/PowerShell 子进程。键含「锁里记的启动时刻」,守护换了人键就换,旧结论不会用到新守护身上。
// 🔴 TTL 必须**明显大于调用它的最慢那个轮询周期**。5_000 是照着设置锁 10ms 循环定的,
// 对那条路径挡得很好 —— 却与主进程状态轮询(runtime.ts 的 refreshTunnelStatus,5 秒一次)
// **完全相等**:每次轮询缓存刚好过期,实测挡掉 **0%**(120 次调用起 120 次 PowerShell)。
// 30 秒下同一节奏挡掉 83%。代价:PID 复用最多晚 30 秒被认出 —— 但首次询问仍是当场读、当场判,
// ⛔ 改成「先答保守值、后台再读」:tests/tunnel/lock-holder-identity.test.ts 守的正是「路人顶用当场判死」。
const startedAtCache = new Map()
const STARTED_AT_CACHE_TTL_MS = 30_000
const STARTED_AT_CACHE_LIMIT = 128

// ---- Windows 启动时刻:koffi 直调 kernel32,一次子进程都不起(甲-1 返工 2026-09-16)----
// 原实现 spawnSync('powershell', …) 查启动时刻:主进程状态轮询每 5 秒走到一次,PowerShell 冷启动
// 几百毫秒起步、忙时拖满 5 秒超时 —— 真机实测窗口出现 1.8s → 15.4s,稳态 20 次点击 8 次 >1s。
// TTL 缓存(上面的 30 秒)挡不住首问,首问必须仍然当场读当场判,所以探测本身必须便宜:
// OpenProcess + GetProcessTimes 是微秒级同步调用,判活语义(含保守方向)一行不变。
// koffi 拿不到(非打包/加载失败)→ 返回 undefined,判活按「读不出身份保守按在」处理,
// ⛔ 回退起子进程 —— 那等于把卡顿请回主进程路径。
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
// FILETIME:1601-01-01 起 100ns 计数;与 Unix 纪元差 11_644_473_600 秒。
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000

/** FILETIME(100ns since 1601,拆 lo/hi 两个 32 位)→ Unix 毫秒;字段不齐返回 undefined。
 *  double 在这个量级(≈2^57)的 100ns 位上损失 ≤16 个计数(≈1.6µs),对判活的 2.5 秒容差无关。 */
export function filetimeToEpochMs(filetime) {
  const low = filetime?.lo
  const high = filetime?.hi
  if (!Number.isInteger(low) || !Number.isInteger(high)) return undefined
  return Math.round((high * 4_294_967_296 + low) / 10_000) - FILETIME_EPOCH_OFFSET_MS
}

// koffi 模块的解析落点与结果都记下(⛔ 每次判活都重试 require):主进程 bundle 在 app.asar 里,
// require(import.meta.url) 找不到 extraResources 下的 koffi,要再从 resources/sidecar/win 试一次。
let koffiProbe = { tried: false, module: undefined }
function requireKoffi() {
  if (koffiProbe.tried) return koffiProbe.module
  koffiProbe.tried = true
  const resolvers = [() => createRequire(import.meta.url)('koffi')]
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    resolvers.push(() => createRequire(join(process.resourcesPath, 'sidecar', 'win', 'resolve-koffi.js'))('koffi'))
  }
  for (const resolve of resolvers) {
    try {
      koffiProbe.module = resolve()
      return koffiProbe.module
    } catch { /* 下一个落点;全落空就按「拿不到原生绑定」处理 */ }
  }
  return undefined
}

let windowsStartedAtBinding // undefined=还没试,null=试过拿不到,对象=可用
function loadWindowsStartedAtBinding() {
  if (windowsStartedAtBinding !== undefined) return windowsStartedAtBinding === null ? undefined : windowsStartedAtBinding
  try {
    const koffi = requireKoffi()
    if (koffi === undefined) throw new Error('koffi 不可用')
    const kernel32 = koffi.load('kernel32.dll')
    // koffi 的类型名是进程级注册:同进程加载两份本文件副本(shared 被主进程 bundle、mac/win 副本并行)时
    // 第二次定义会抛 Duplicate type name —— 同名同形,⛔ 让它炸掉整条绑定,忽略即可。
    try { koffi.struct('LaixinFiletime', { lo: 'uint32', hi: 'uint32' }) } catch { /* 已定义:直接用 */ }
    const open = kernel32.func('void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)')
    const times = kernel32.func('bool __stdcall GetProcessTimes(void *hProcess, _Out_ LaixinFiletime *lpCreationTime, _Out_ LaixinFiletime *lpExitTime, _Out_ LaixinFiletime *lpKernelTime, _Out_ LaixinFiletime *lpUserTime)')
    const close = kernel32.func('bool __stdcall CloseHandle(void *hObject)')
    windowsStartedAtBinding = {
      open: (pid) => open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid),
      creationTime: (handle) => {
        const creation = {}
        const exit = {}
        const kernel = {}
        const user = {}
        if (times(handle, creation, exit, kernel, user) === false) return undefined
        return { lo: creation.lo, hi: creation.hi }
      },
      close: (handle) => { close(handle) }
    }
  } catch {
    windowsStartedAtBinding = null
  }
  return windowsStartedAtBinding === null ? undefined : windowsStartedAtBinding
}

/** 读某 PID 实际的启动时刻(ms)。读不出(进程刚好消失、无权打开、系统不支持)返回 undefined,调用方保守处理。
 *  deps 可注入:{ platform }(默认 process.platform)、{ windowsBinding }(测试注入原生绑定;显式给 null = 模拟拿不到)。 */
export function readProcessStartedAt(pid, now = Date.now, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    if ((deps.platform ?? process.platform) === 'win32') {
      const binding = 'windowsBinding' in deps ? deps.windowsBinding : loadWindowsStartedAtBinding()
      if (binding === undefined || binding === null) return undefined
      const handle = binding.open(pid)
      if (handle === undefined || handle === null) return undefined
      try {
        return filetimeToEpochMs(binding.creationTime(handle))
      } finally {
        try { binding.close(handle) } catch { /* 关不掉交给内核回收 */ }
      }
    }
    // macOS/Linux:etime 是「至今活了多久」([[dd-]hh:]mm:ss),回推启动时刻,秒级精度
    const probe = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
    if (probe.status !== 0) return undefined
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(probe.stdout.trim())
    if (match === null) return undefined
    const seconds = (match[1] !== undefined ? Number(match[1]) * 86_400 : 0) +
      (match[2] !== undefined ? Number(match[2]) * 3_600 : 0) + Number(match[3]) * 60 + Number(match[4])
    return Number.isFinite(seconds) ? now() - seconds * 1_000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 锁持有者是否仍是「当初拿锁的那个人」:pid 活着 **且** 启动时刻与锁内记录一致。
 * 读不出身份(PID 刚消失前的窗口、系统不支持)时保守按「在」——误判会踢掉活守护,⛔ 朝那个方向错。
 * 旧版锁(升级前写的,没有 startedAt)退回 sweepOrphanXray 的跨开机判据:锁的时刻早于本次开机即遗留。
 */
export function lockHolderAlive(record, { now = Date.now, uptimeSeconds = uptime, readStartedAt = readProcessStartedAt } = {}) {
  if (record === undefined || !Number.isInteger(record.pid) || !processAlive(record.pid)) return false
  const recorded = record.startedAt
  if (!Number.isFinite(recorded)) {
    return !(Number.isFinite(record.at) && record.at < now() - uptimeSeconds() * 1_000 - 60_000)
  }
  const cacheKey = `${String(record.pid)}:${String(recorded)}`
  const at = now()
  let actual
  const cached = startedAtCache.get(cacheKey)
  if (cached !== undefined && at - cached.readAt < STARTED_AT_CACHE_TTL_MS) {
    actual = cached.value
  } else {
    actual = readStartedAt(record.pid, now)
    if (startedAtCache.size >= STARTED_AT_CACHE_LIMIT) startedAtCache.clear()
    startedAtCache.set(cacheKey, { value: actual, readAt: at })
  }
  if (actual === undefined) return true
  return Math.abs(actual - recorded) <= STARTED_AT_TOLERANCE_MS
}

/** 读锁文件:{ holder, ino };文件不在返回 undefined;内容读不出(刚创建还没写完)holder 为 undefined 但 ino 有值。 */
export function readSettingsLock(dataDir) {
  const path = settingsLockPath(dataDir)
  let ino
  try { ino = statSync(path).ino } catch { return undefined }
  let holder
  try { holder = JSON.parse(readFileSync(path, 'utf8')) } catch { holder = undefined }
  return { holder, ino }
}

function readLockFile(path) {
  let ino
  try { ino = statSync(path).ino } catch { return undefined }
  let holder
  try { holder = JSON.parse(readFileSync(path, 'utf8')) } catch { holder = undefined }
  return { holder, ino }
}

export class SettingsLockLostError extends SettingsBusyError {
  constructor() {
    super(undefined)
    this.message = '系统设置锁已被接管，本次操作放弃，稍后自动重试'
    this.code = 'SETTINGS_LOCK_LOST'
  }
}

export function withSettingsLock(dataDir, fn, options = {}) {
  const existing = heldLocks.get(dataDir)
  if (existing !== undefined) {
    existing.depth += 1
    try { return fn() } finally { existing.depth -= 1 }
  }
  const held = acquireSettingsLock(dataDir, options)
  heldLocks.set(dataDir, { depth: 1, ...held })
  try { return fn() } finally {
    heldLocks.delete(dataDir)
    releaseSettingsLock(dataDir, held.token)
  }
}

/** 本进程当前是否持有该数据目录的设置锁(供用例与巡检断言)。 */
export function holdsSettingsLock(dataDir) {
  return heldLocks.has(dataDir)
}

/** 持锁方自检(GPT-6 复核 c53c636 #1):每次提交账本、写系统设置前确认锁文件仍是自己的(令牌 + inode)。
 * 被人错判成遗留锁挪走、且原路径已被第三者占住的极端交错下,持锁方在这里发现、放弃本次提交,⛔ 把旧快照写回去。
 * 不在锁内(单机/测试路径)不检查。 */
export function assertSettingsLockHeld(dataDir) {
  const held = heldLocks.get(dataDir)
  if (held === undefined) return
  const current = readSettingsLock(dataDir)
  if (current === undefined || current.holder?.token !== held.token || current.ino !== held.ino) throw new SettingsLockLostError()
}

/** 破遗留锁(GPT-6 复核 c53c636 #1):⛔ 按路径直接删——两个清理者都看到同一把死锁时,后删的那个会把先到者刚拿到的新锁删掉。
 * 做法:先把锁文件原子挪到自己的暂存名(rename 只会有一个成功),再核对挪走的是不是当初观察到的那把(令牌 + inode 都对);
 * 是 → 删掉暂存,返回 true 让调用方去创建;不是(挪走了活着的持有者的锁)→ 用硬链接把同一个 inode 原样还回原路径,返回 false。
 * 原路径在这一瞬已被第三者占住时还不回去,持有者会在 assertSettingsLockHeld 自检时发现并放弃提交。 */
export function takeOverStaleLock(dataDir, observed) {
  const path = settingsLockPath(dataDir)
  const bucket = `${path}.stale-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  try { renameSync(path, bucket) } catch { return false }
  const moved = readLockFile(bucket)
  const sameFile = moved !== undefined && moved.ino === observed?.ino && moved.holder?.token === observed?.holder?.token
  const deadHolder = moved !== undefined && moved.holder !== undefined && !lockHolderAlive(moved.holder)
  if (sameFile || deadHolder) {
    try { rmSync(bucket, { force: true }) } catch { /* 暂存删不掉不影响 */ }
    return true
  }
  try { linkSync(bucket, path) } catch { /* 原路径已有新锁:还不回去,持有者自检会发现 */ }
  try { rmSync(bucket, { force: true }) } catch { /* 暂存删不掉不影响 */ }
  return false
}

// 等锁自旋的步进节奏(收拢轮 M10 小改「自旋分段让出」):这些等锁路径全是同步代码,同步等锁没法把事件循环
// 让出来(那是彻底档「等锁异步化」,不在本条);能做的是把机器让给持锁方——自旋跑在守护唯一主线程上,
// 前段 10ms 快抢,锁一放立刻接住(常态的短争抢,如复验撞上应用设置);持续被占就每秒翻倍拉长步进、100ms 封顶,
// 每秒从 ~100 次锁文件折腾降到 ~10 次,持锁方(恢复/应用设置)少抢 I/O 早干完,整段冻结就短。
export function settingsLockWaitStepMs(waitedMs) {
  if (waitedMs < 1_000) return 10
  return Math.min(100, 10 * 2 ** Math.floor(waitedMs / 1_000))
}

// 等锁默认上限(收拢轮 M10 小改「缩短默认上限」):自旋冻结的是唯一主线程,同线程上跑着本地桥客户流量——
// 等锁多久,客户流量就停多久(这才是卡顿的真实代价;主进程对流量文件 10 秒不更新只是不显示流量行,
// status-service.ts trafficSummary,⛔ 据此判守护不可用——2026-09-17 验收勘误)。20 秒上限等于每次争抢
// 都能把客户流量整段卡死十几秒;5 秒封住单段冻结,留一半余量;等不到抛 SettingsBusyError 照旧是瞬时
// 错误,调用方(恢复/重试梯子)本来就按稍后再试处理。
const SETTINGS_LOCK_DEFAULT_TIMEOUT_MS = 5_000

function acquireSettingsLock(dataDir, { owner = '', timeoutMs = SETTINGS_LOCK_DEFAULT_TIMEOUT_MS, now = Date.now, sleep = sleepSync, waitStepMs = settingsLockWaitStepMs } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const path = settingsLockPath(dataDir)
  const token = `${String(process.pid)}-${randomBytes(4).toString('hex')}`
  const deadline = now() + timeoutMs
  let unreadableSince
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ token, pid: process.pid, owner, at: now(), startedAt: currentProcessStartedAt() }), { flag: 'wx', mode: 0o600 })
      let ino
      try { ino = statSync(path).ino } catch { ino = undefined }
      return { token, ino }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const observed = readSettingsLock(dataDir)
    if (observed === undefined) continue // 刚被释放/挪走:马上再抢
    if (observed.holder === undefined) {
      // 刚创建还没写完内容(极短窗口),等一下;超过 2 秒仍读不出就当遗留锁
      unreadableSince = unreadableSince ?? now()
      if (now() - unreadableSince > 2_000) { takeOverStaleLock(dataDir, observed); unreadableSince = undefined; continue }
    } else {
      unreadableSince = undefined
      if (!lockHolderAlive(observed.holder)) { takeOverStaleLock(dataDir, observed); continue }
      if (now() > deadline) throw new SettingsBusyError(observed.holder)
    }
    sleep(waitStepMs(now() - (deadline - timeoutMs)))
  }
}

function releaseSettingsLock(dataDir, token) {
  const path = settingsLockPath(dataDir)
  const current = readSettingsLock(dataDir)
  if (current?.holder?.token !== token) return // 已被人接管:不动
  // 同样先挪走再核对,⛔ 「看一眼是自己的、再按路径删」中间被换掉
  const bucket = `${path}.release-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  try { renameSync(path, bucket) } catch { return }
  const moved = readLockFile(bucket)
  if (moved?.holder?.token === token) { try { rmSync(bucket, { force: true }) } catch { /* 暂存删不掉不影响 */ } return }
  try { linkSync(bucket, path) } catch { /* 原路径已有新锁 */ }
  try { rmSync(bucket, { force: true }) } catch { /* 暂存删不掉不影响 */ }
}

// 账本条目上限:超出后把最旧的「已终态」条目(intent 或已恢复 setting)归档进 ledger-archive.jsonl,
// 未恢复的 setting 账目一律保留,⛔ 把待恢复记录当旧数据丢掉。
export const LEDGER_ENTRY_LIMIT = 500

const archivePath = (dataDir) => join(dataDir, 'ledger-archive.jsonl')

function isArchivableEntry(entry) {
  if (entry.kind === 'intent') return true
  return entry.kind === 'setting' && isSettledSetting(entry)
}

function compactForStorage(dataDir, entries) {
  if (entries.length <= LEDGER_ENTRY_LIMIT) return entries
  const dropTarget = entries.length - LEDGER_ENTRY_LIMIT
  const keep = []
  const archived = []
  for (const entry of entries) {
    if (archived.length < dropTarget && isArchivableEntry(entry)) archived.push(entry)
    else keep.push(entry)
  }
  if (archived.length === 0) return entries
  try {
    mkdirSync(dirname(archivePath(dataDir)), { recursive: true })
    appendFileSync(archivePath(dataDir), `${archived.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 })
  } catch {
    return entries // 归档写不进去就不收缩:宁可账本大,不可丢恢复记录。
  }
  return keep
}

// 主进程状态轮询的记忆化读:文件 mtime+size 未变时直接复用上次解析结果,
// ⛔ 每次状态 tick 把数 MB 账本整体重新 JSON.parse。写路径(saveLedger)会同步刷新缓存。
const ledgerCache = new Map()
let ledgerDiskReadCount = 0

/** 诊断计数:loadLedgerCached 真正读盘解析账本的次数(供测试与巡检断言)。 */
export function ledgerDiskReads() {
  return ledgerDiskReadCount
}

function ledgerCacheKey(stat) {
  return stat === undefined ? 'missing' : `${stat.mtimeMs}:${stat.size}`
}

export function loadLedgerCached(dataDir) {
  let stat
  try { stat = lstatSync(ledgerPath(dataDir)) } catch { stat = undefined }
  const key = ledgerCacheKey(stat)
  const cached = ledgerCache.get(dataDir)
  if (cached !== undefined && cached.key === key) return cached.entries
  ledgerDiskReadCount += 1
  const entries = loadLedger(dataDir)
  ledgerCache.set(dataDir, { key, entries })
  return entries
}

export function ledgerFailureCached(dataDir) {
  try { loadLedgerCached(dataDir); return undefined } catch (error) {
    if (error instanceof LedgerError) return { code: error.code, message: error.message }
    throw error
  }
}

export function lastIntentCached(dataDir) {
  const entries = loadLedgerCached(dataDir)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === 'intent') {
      return entries[index].intent
    }
  }
  return undefined
}

export function generateSessionToken(now = Date.now) {
  return `sess-${now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export class LedgerError extends Error {
  constructor(code = 'LEDGER_CORRUPT') {
    super('恢复记录损坏或无法读取，原设置尚未恢复，请联系客服协助处理')
    this.code = code
  }
}

const recoveryMarker = (dataDir) => join(dataDir, 'ledger-recovery-required')

// 损坏恢复(收敛包3):标记里记着被隔离的坏账本文件名;恢复流程据此找回能识别的设置。
export function readRecoveryMarker(dataDir) {
  try {
    const name = readFileSync(recoveryMarker(dataDir), 'utf8').trim()
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

// 可恢复载荷 = 恢复流程真正需要的三样:服务名、设置项、原值。判「能不能恢复」只看它,
// ⛔ 看 kind 标签——kind 丢失或被拼坏(审计 R1 形态 C/D)的条目照样是一条待恢复设置。
export function hasRestorablePayload(entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    typeof entry.service === 'string' && entry.service !== '' &&
    typeof entry.item === 'string' && entry.item !== '' && Object.hasOwn(entry, 'originalValue')
}

// 设置类账目的形态判定:带任一设置账目特征字段即算,据此决定「损坏到无法识别」要不要
// 计入失败并留标记。intent 账目不承担恢复义务,不在此列。
const SETTING_ENTRY_FIELDS = Object.freeze(['service', 'item', 'originalValue', 'writtenValue', 'sessionToken'])

export function isSettingLikeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (entry.kind === 'intent') return false
  if (typeof entry.kind === 'string' && entry.kind.startsWith('setting')) return true
  return SETTING_ENTRY_FIELDS.some((field) => Object.hasOwn(entry, field))
}

// 尽力解析被隔离的坏账本(审计 R1 分两档):完整条目原样保留;不完整但带可恢复载荷的
// 作为「存疑条目」一并保留——恢复只需要原值,照样交给恢复流程尝试;其余设置类条目
// 损坏到无法识别,计数上报,⛔ 静默过滤后当作没有待恢复项。完全读不出返回 undefined。
export function loadQuarantinedEntries(dataDir, badName) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, badName), 'utf8'))
    if (!Array.isArray(parsed)) return undefined
    const entries = []
    let droppedSettings = 0
    for (const entry of parsed) {
      if (validEntry(entry) || hasRestorablePayload(entry)) { entries.push(entry); continue }
      if (!isSettingLikeEntry(entry)) continue
      // 已恢复的坏条目没有待恢复义务,丢掉即可;计入失败会让标记永远清不掉。
      if (isSettledSetting(entry)) continue
      droppedSettings += 1
    }
    return { entries, droppedSettings }
  } catch {
    return undefined
  }
}

// 只允许恢复流程在重建账本成功后调用;⛔ 其他路径绕过「先持久标记再隔离」的安全序。
export function clearRecoveryMarker(dataDir) {
  try { rmSync(recoveryMarker(dataDir), { force: true }) } catch { /* 标记删不掉:下次启动重走恢复。 */ }
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !Number.isFinite(entry.time)) return false
  if (entry.kind === 'intent') return ['connected', 'user-disconnected', 'shutdown'].includes(entry.intent)
  return entry.kind === 'setting' && typeof entry.service === 'string' && typeof entry.item === 'string' &&
    typeof entry.sessionToken === 'string' && typeof entry.note === 'string' &&
    Object.values(ENTRY_STATUS).includes(entry.status) && Object.hasOwn(entry, 'originalValue') && Object.hasOwn(entry, 'writtenValue')
}

/** 审计 R1:完整通过结构校验的条目。恢复流程据此区分「完整」与「存疑」两档——
 * 存疑条目缺 note/sessionToken 等字段时不应被丢弃,但缺写入值时无法判定所有权,只能计入失败。 */
export function isIntactLedgerEntry(entry) {
  return validEntry(entry)
}

function quarantineLedger(dataDir) {
  // 先持久标记再隔离：崩溃或重启也不能把丢失的恢复记录当作空账本。
  const badName = `ledger.json.bad-${Date.now()}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(recoveryMarker(dataDir), `${badName}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(ledgerPath(dataDir), join(dataDir, badName))
  } catch {
    // 隔离失败时原坏文件或持久标记仍在；继续拒绝，不覆盖任何恢复记录。
  }
  throw new LedgerError()
}

export function loadLedger(dataDir) {
  if (existsSync(recoveryMarker(dataDir))) throw new LedgerError()
  const path = ledgerPath(dataDir)
  let source
  try {
    if (!lstatSync(path).isFile()) throw new LedgerError('LEDGER_UNREADABLE')
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new LedgerError('LEDGER_UNREADABLE')
  }
  let parsed
  try { parsed = JSON.parse(source) } catch { return quarantineLedger(dataDir) }
  if (!Array.isArray(parsed) || !parsed.every(validEntry)) return quarantineLedger(dataDir)
  return parsed
}

export function ledgerFailure(dataDir) {
  try { loadLedger(dataDir); return undefined } catch (error) {
    if (error instanceof LedgerError) return { code: error.code, message: error.message }
    throw error
  }
}

export function saveLedger(dataDir, entries) {
  // 提交前确认锁仍是自己的(被错判挪走时放弃本次提交,⛔ 把旧快照写回去)
  assertSettingsLockHeld(dataDir)
  // 正常写入也检查已有记录，不能用新数组覆盖损坏的原值。
  loadLedger(dataDir)
  if (!Array.isArray(entries) || !entries.every(validEntry)) throw new LedgerError()
  const stored = compactForStorage(dataDir, entries)
  const path = ledgerPath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(temporary, `${JSON.stringify(stored, null, 1)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  try {
    ledgerCache.set(dataDir, { key: ledgerCacheKey(lstatSync(path)), entries: stored })
  } catch {
    ledgerCache.delete(dataDir)
  }
}

let entrySequence = 0

// 追加一条「系统设置写入」账目:服务名、设置项、原值、我们写入的值、会话令牌、时刻。
export function appendSettingEntry(dataDir, { service, item, originalValue, writtenValue, sessionToken, time }) {
  return withSettingsLock(dataDir, () => {
    const entries = loadLedger(dataDir)
    entrySequence += 1
    const entry = {
      id: `w-${sessionToken}-${entrySequence}`,
      kind: 'setting',
      service,
      item,
      originalValue,
      writtenValue,
      sessionToken,
      time,
      status: ENTRY_STATUS.applied,
      note: ''
    }
    entries.push(entry)
    saveLedger(dataDir, entries)
    return entry
  })
}

// 追加一条用户意图账目(定稿:用户主动断开意图持久化,跨重启仍有效)。
export function appendIntentEntry(dataDir, { intent, time }) {
  withSettingsLock(dataDir, () => {
    const entries = loadLedger(dataDir)
    // id 用单调序列而不是 entries.length:账本收缩后 length 会回退,⛔ 生成重复 id。
    entrySequence += 1
    entries.push({ id: `i-${String(time)}-${entrySequence}`, kind: 'intent', intent, time })
    saveLedger(dataDir, entries)
  })
}

export function lastIntent(dataDir) {
  const entries = loadLedger(dataDir)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === 'intent') {
      return entries[index].intent
    }
  }
  return undefined
}

// 争抢修回专用:同一项被另一款软件反复改成不同的值时,账本仍只留一条,但恢复依据要跟着换成对方最后写的那个值
// (GPT-6 补核 R6:之前只记第一次的值,退出后把客户的网交回一个已经停用的旧地址)。
// 只改仍在生效(applied)的账目;账目已结算或不存在 → 返回 undefined,由调用方另记一条。先落盘再覆盖系统设置。
// 原值与这次实际要写的完整值一起落盘(GPT-6 复核 3d8d51f #3:只更新原值、写入值停在第一次修回的地址,退出时判归属就对不上)。
export function updateSettingEntry(dataDir, entryId, { originalValue, writtenValue, time }) {
  return withSettingsLock(dataDir, () => {
    const entries = loadLedger(dataDir)
    const entry = entries.find((candidate) => candidate.id === entryId)
    if (entry === undefined || entry.kind !== 'setting' || entry.status !== ENTRY_STATUS.applied) return undefined
    entry.originalValue = originalValue
    if (writtenValue !== undefined) entry.writtenValue = writtenValue
    if (Number.isFinite(time)) entry.time = time
    entry.note = '外部软件改成了新值,恢复依据已更新为它最后写的值'
    saveLedger(dataDir, entries)
    return entry
  })
}

export function markEntry(dataDir, entryId, { status, note }) {
  return withSettingsLock(dataDir, () => {
    const entries = loadLedger(dataDir)
    const entry = entries.find((candidate) => candidate.id === entryId)
    if (entry === undefined) {
      throw new Error(`LEDGER_ENTRY_MISSING:${entryId}`)
    }
    entry.status = status
    entry.note = note ?? entry.note
    saveLedger(dataDir, entries)
    return entry
  })
}

// 尚未终态的设置账目 = 崩溃或中断留下的待恢复项。
export function pendingSettingEntries(dataDir) {
  return loadLedger(dataDir).filter(
    (entry) => entry.kind === 'setting' && !isSettledSetting(entry)
  )
}

// N-25:等待循环用的记忆化读——判据与 pendingSettingEntries 完全一致,改由 loadLedgerCached
// 供数(mtime+size 失效)。恢复子进程改写账本后 mtime 变化,复核拿到的一定是新账。
export function pendingSettingEntriesCached(dataDir) {
  return loadLedgerCached(dataDir).filter(
    (entry) => entry.kind === 'setting' && !isSettledSetting(entry)
  )
}
