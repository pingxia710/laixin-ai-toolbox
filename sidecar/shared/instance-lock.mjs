// 守护单实例锁（守护常驻的前置）：同一个数据目录同一时刻只准跑一个守护。
//
// 为什么不能借用 settings.lock：那把是「临界区锁」——同进程可重入、用完立刻释放、持有者活着时
// 别人等 20 秒就抛忙。单实例要的正相反：整进程生命周期持有、拿不到就让位、持有者活着时绝不抢。
//
// 常驻之后这把锁从「锦上添花」变成「必须」：系统会在崩溃后把守护拉起来，而主进程也可能同时 spawn 一个；
// 两个守护并存时，后起的那个 run() 第一件事就是按账本还原——会把客户此刻正在用的代理还掉。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { currentProcessStartedAt, lockHolderAlive } from './ledger.mjs'

export function instanceLockPath(dataDir) {
  return join(dataDir, 'daemon.lock')
}

/** 读锁文件:{ holder, ino }；文件不在返回 undefined。 */
export function readInstanceLock(dataDir) {
  const path = instanceLockPath(dataDir)
  let ino
  try { ino = statSync(path).ino } catch { return undefined }
  let holder
  try { holder = JSON.parse(readFileSync(path, 'utf8')) } catch { holder = undefined }
  return { holder, ino }
}

// N-25:主进程状态路径的席位锁记忆化读——ino+mtime+size 未变时复用上次结果
// (loadLedgerCached 同一模式;⛔ TTL 时间窗)。锁文件的释放与接手都换 inode 或改 mtime,缓存自失效。
// ⛔ 抢锁/破锁/释放路径仍用 readInstanceLock:它们是对盘面的判定,必须看到最新事实。
const instanceLockReadCache = new Map()
let instanceLockDiskReadCount = 0

/** 诊断计数:readInstanceLockCached 真正读盘的次数(供测试与巡检断言)。 */
export function instanceLockDiskReads() {
  return instanceLockDiskReadCount
}

export function readInstanceLockCached(dataDir) {
  const path = instanceLockPath(dataDir)
  let key
  try {
    const stat = statSync(path)
    key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch { key = 'missing' }
  const cached = instanceLockReadCache.get(dataDir)
  if (cached !== undefined && cached.key === key) return cached.value
  instanceLockDiskReadCount += 1
  const value = readInstanceLock(dataDir)
  instanceLockReadCache.set(dataDir, { key, value })
  return value
}

/**
 * 抢这个数据目录的守护席位。
 * 抢到 → 返回 { acquired: true, release() }；席位有人（进程还活着）→ 返回 { acquired: false, holder }，调用方应安静退出 0。
 * 上一任已经不在（崩溃、被杀、断电）→ 破掉遗留锁接手：破锁用与设置锁同一套「原子挪走 + 核对 + 还回」协议，
 * ⛔ 按路径直接删——两个新实例同时清理时，后删的那个会把先到者刚拿到的席位删掉。
 */
export function acquireInstanceLock(dataDir, { runId = '', maxAttempts = 5 } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const path = instanceLockPath(dataDir)
  const token = `${String(process.pid)}-${randomBytes(4).toString('hex')}`
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // startedAt 是本进程自己的启动时刻:判活者拿它和该 PID 现在的启动时刻对账,
      // 同一次开机内的 PID 复用(持有者死了、号码给了路人)在这里现形 ⛔ 只查 pid 活性。
      writeFileSync(path, JSON.stringify({ token, pid: process.pid, runId, at: Date.now(), startedAt: currentProcessStartedAt() }), { flag: 'wx', mode: 0o600 })
      let ino
      try { ino = statSync(path).ino } catch { ino = undefined }
      return { acquired: true, token, release: () => releaseInstanceLock(dataDir, token, ino) }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const observed = readInstanceLock(dataDir)
    if (observed === undefined) continue // 刚被释放:马上再抢
    // 内容读不出来（刚创建还没写完）也当席位有人：⛔ 拿一个瞬间窗口去踢掉正在起来的同伴
    if (observed.holder === undefined) return { acquired: false, holder: undefined }
    if (lockHolderAlive(observed.holder)) return { acquired: false, holder: observed.holder }
    if (!takeOverStaleInstanceLock(dataDir, observed)) return { acquired: false, holder: observed.holder }
  }
  return { acquired: false, holder: readInstanceLock(dataDir)?.holder }
}

/** 破遗留席位:先原子挪走,核对挪走的确实是观察到的那一把（令牌 + inode），不是就原样还回去。 */
export function takeOverStaleInstanceLock(dataDir, observed) {
  const path = instanceLockPath(dataDir)
  const bucket = `${path}.stale-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  try { renameSync(path, bucket) } catch { return false }
  let moved
  try { moved = { holder: JSON.parse(readFileSync(bucket, 'utf8')), ino: statSync(bucket).ino } } catch { moved = undefined }
  const sameOne = moved !== undefined && moved.ino === observed.ino && moved.holder?.token === observed.holder?.token
  const stillDead = moved !== undefined && moved.holder !== undefined && !lockHolderAlive(moved.holder)
  if (sameOne || stillDead) {
    try { rmSync(bucket, { force: true }) } catch { /* 暂存删不掉不影响 */ }
    return true
  }
  try {
    // 挪走的不是那一把（席位在这一瞬被别人接手了）→ 原样放回去
    if (!existsSync(path)) renameSync(bucket, path)
    else rmSync(bucket, { force: true })
  } catch { /* 放不回去时下一轮会重新观察 */ }
  return false
}

function releaseInstanceLock(dataDir, token, ino) {
  const current = readInstanceLock(dataDir)
  if (current?.holder?.token !== token) return // 已被别人接手:⛔ 删别人的席位
  if (ino !== undefined && current.ino !== ino) return
  try { unlinkSync(instanceLockPath(dataDir)) } catch { /* 删不掉:下一任按 pid 存活破锁 */ }
}
