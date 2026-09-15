// 常驻守护自检与自卸（0.5.0 · Mac 卸载流程）。
//
// macOS 没有卸载器可以挂钩子——客户把 .app 拖进废纸篓，系统里留下的是两样东西：
//   1) 一个还在跑、还占着客户系统代理的常驻守护；
//   2) 一个指向已经不存在的程序的 LaunchAgent。
// 到这一步主进程多半早就退了，**唯一还持有客户系统设置的就是守护进程自己**，所以这件事只能由守护做：
// 发现自己依赖的程序文件不在了 → 按账本把客户的设置原样还回去 → 删掉常驻项 → 退出(0)。
// 退出码 0 配 KeepAlive.SuccessfulExit=false ⇒ 系统不会再把它拉起来；plist 已删 ⇒ 下次登录也不会加载。
// 结果就是派题要的那句：客户把应用拖进废纸篓之后，电脑的网是好的，也不留任何指向已删程序的东西。
//
// 四条硬规矩，⛔ 越过：
//  1. **还原只走账本**（restore.mjs 的 restoreLedger），⛔ 自己写一套写回系统设置的代码——
//     绕过账本会丢客户的原始值（第三方改过的项要保留现值，这些判断全在账本那一层）。
//  2. **还原与自卸整段在跨进程设置锁里**（ledger.mjs 的 withSettingsLock），⛔ 和另一个恢复者互相覆盖。
//  3. **⛔ 对自己 launchctl bootout**：我们就是那个服务，bootout 等于给自己发 SIGTERM，
//     会在还原中途把自己打断、再触发一轮关停还原。删 plist + 退出 0 达到的是同一个效果（见上），
//     由调用方在本函数返回 shouldExit 后退出进程。Windows 侧删计划任务不杀进程，没有这个问题。
//  4. **没还干净就不许走**：还原没完成时 ⛔ 删常驻项、⛔ 退出——plist 一删、进程一退，
//     就再没有任何人能把客户那份指向死端口的代理还回去了（应用已经被删，主进程不会再来）。
//     这时候留在原地按调用方的节奏重试，是唯一还有机会的做法。
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { withSettingsLock } from './ledger.mjs'
import { restoreLedger, unrestoredEntries } from './restore.mjs'

/** 常驻标签／计划任务名。与 app/main/tunnel/platform/resident.ts 的 RESIDENT_LABEL 同值——
 *  那边是 TypeScript、只在 Electron 主进程里，守护是随包跑的 plain .mjs，import 不过来，只能各写一份字面量。
 *  ⚠️ 改常驻标签时两处一起改，否则主进程装的那一套守护自己卸不掉。 */
export const RESIDENT_LABEL = 'cn.laixin.toolbox.tunnel'

/** 每用户 LaunchAgent 描述文件位置（⛔ /Library/LaunchDaemons，那要管理员权限）。 */
export function macAgentPath(home = homedir(), label = RESIDENT_LABEL) {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}

/** 常驻指向的文件还在不在。纯查询，⛔ 有副作用。
 *  路径给空（开发态、参数没传到）一律当「在」：不知道就 ⛔ 拆客户的连接。 */
export function residentBinaryMissing(execPath, exists = existsSync) {
  if (typeof execPath !== 'string' || execPath === '') return false
  return !exists(execPath)
}

/**
 * 连续 N 次探不到才算「被删了」。
 * 为什么要宽限：mac 的更新是原地换 bundle（旧的 rename 走、新的 rename 进来，路径不变），
 * 中间有一瞬路径确实不在。更新时常驻会被更新助手先停掉，正常走不到这里，但 ⛔ 把这一瞬当成
 * 「客户把应用删了」而去拆连接——那是把「正在更新」误判成「已被卸载」。
 * N（threshold）与轮询间隔由调用方定：两者相乘就是宽限时长。
 * 任何一次探到都清零，⛔ 让零星的读失败攒成一次误判。
 */
export function createResidentIntegrityCheck({ paths, threshold = 3, exists = existsSync } = {}) {
  const watched = (Array.isArray(paths) ? paths : [paths]).filter((path) => typeof path === 'string' && path !== '')
  if (watched.length === 0) throw new Error('RESIDENT_INTEGRITY_PATHS_REQUIRED')
  const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 3
  let misses = 0
  return {
    check() {
      const absent = watched.filter((path) => residentBinaryMissing(path, exists))
      if (absent.length === 0) {
        misses = 0
        return { missing: false, misses: 0, absent: [] }
      }
      misses += 1
      return { missing: misses >= limit, misses, absent }
    },
    reset() { misses = 0 },
    get misses() { return misses }
  }
}

const defaultRun = (file, args) => execFileSync(file, args, { timeout: 15_000, stdio: 'ignore' })

/** 删掉常驻项本身。mac = 删描述文件（⛔ bootout 自己，见文件头规矩 3）；Windows = 删登录计划任务（不杀进程）。 */
export function removeResident({
  label = RESIDENT_LABEL,
  home = homedir(),
  platform = process.platform,
  run = defaultRun
} = {}) {
  try {
    if (platform === 'win32') run('schtasks.exe', ['/delete', '/tn', label, '/f'])
    else rmSync(macAgentPath(home, label), { force: true })
    return { removed: true, reason: '' }
  } catch (error) {
    // 没建过就没得删（Windows 上 schtasks 对不存在的任务返回非零）：这也是「现在没有常驻项」，算成功。
    const reason = messageOf(error)
    if (platform === 'win32' && /cannot find|找不到|ERROR: The system cannot find/i.test(reason)) return { removed: true, reason: '' }
    return { removed: false, reason }
  }
}

/**
 * 自愈编排：按账本还原客户的系统设置 → 还干净了才删常驻项 → 告诉调用方可以退出了。
 * 整段在跨进程设置锁里（规矩 2）；restoreLedger 自己也取同一把锁，同进程可重入，⛔ 死锁。
 *
 * 调用方（守护）的用法：
 *   const outcome = runResidentSelfHeal({ dataDir, adapter, log })
 *   if (outcome.shouldExit) process.exit(0)     // 0 = 正常退出 ⇒ 系统 ⛔ 再拉起
 *   else 下一轮再试（还没还干净，留在原地重试是唯一还有机会的做法）
 * 调用前请先停掉连接（中继与内核），否则代理还回去了、内核还占着端口。
 *
 * 返回值里 ⛔ 抛异常：锁被别人占着、写回失败都照实回报，由调用方按自己的节奏重试。
 */
export function runResidentSelfHeal({
  dataDir,
  adapter,
  label = RESIDENT_LABEL,
  home = homedir(),
  platform = process.platform,
  run = defaultRun,
  lockTimeoutMs = 20_000,
  log = () => undefined
} = {}) {
  const outcome = {
    restored: 0, keptModified: 0, failed: [], unrestored: 0,
    residentRemoved: false, shouldExit: false, settingsBusy: false, reason: ''
  }
  try {
    withSettingsLock(dataDir, () => {
      const result = restoreLedger(dataDir, adapter)
      outcome.restored = result.restored.length
      outcome.keptModified = result.keptModified.length
      outcome.failed = result.failed.map((entry) => `${entry.service}/${entry.item}:${entry.note ?? ''}`)
      outcome.unrestored = unrestoredEntries(dataDir).length
      if (outcome.unrestored > 0) {
        // 规矩 4：还没还干净 ⛔ 删常驻项、⛔ 退出。
        outcome.reason = '原设置尚未全部还原，保留常驻继续重试'
        return
      }
      const removal = removeResident({ label, home, platform, run })
      outcome.residentRemoved = removal.removed
      outcome.reason = removal.reason
      // 常驻项删不掉（目录只读之类）也要走：设置已经还回去了，客户的网是好的；
      // 剩下那个 plist 指向已删除的程序，系统拉不起来，是惰性残留 ⛔ 继续占着客户的代理不放。
      outcome.shouldExit = true
    }, { owner: 'resident-self-heal', timeoutMs: lockTimeoutMs })
  } catch (error) {
    outcome.settingsBusy = true
    outcome.reason = messageOf(error)
    log(`常驻自检：还原未能开始（${outcome.reason}），稍后重试`)
    return outcome
  }
  log(outcome.shouldExit
    ? `常驻自检：程序已不在，已还原 ${String(outcome.restored)} 项、保留他人现值 ${String(outcome.keptModified)} 项，常驻项${outcome.residentRemoved ? '已删除' : '未能删除'}，退出`
    : `常驻自检：程序已不在，但还有 ${String(outcome.unrestored)} 项原设置没还回去，保留常驻继续重试`)
  return outcome
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
