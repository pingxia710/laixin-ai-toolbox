// 系统代理写入权的「持有者名片」(创始人 2026-09-15 硬线二)。
//
// 命名互斥体只回答「能不能写」,不回答「现在是谁在写」。而硬线二要求:拿不到写入权的那个守护
// **⛔ 悄悄退出让界面失明**,它得把持有者的真实状态读出来转呈给界面。所以持有权的一方在拿到权之后
// 立刻留一张名片,写明自己是谁、数据目录在哪——新来的据此去读对方的 state.json,把真实状态转呈上去。
//
// 名片是**辅助信息,不是权威**:权威永远是互斥体。名片可能过期(持有者崩在写名片之前/之后),
// 所以读到的一切都当「线索」用,⛔ 拿它判断对方死活——死活由 WAIT_ABANDONED 说了算。
//
// 位置必须跨数据目录、跨安装目录固定:这次的故障正是两份来信各用各的目录、互相看不见。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 名片所在目录:与任何一次安装、任何一个数据目录都无关。 */
export function writeRightDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0 ? env.LOCALAPPDATA : join(homedir(), 'AppData', 'Local')
    return join(base, 'Laixin')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Laixin')
  return join(homedir(), '.laixin')
}

export function writeRightOwnerPath(platform = process.platform, env = process.env) {
  return join(writeRightDir(platform, env), 'wininet-write-owner.json')
}

/**
 * 留名片。原子写(tmp + rename):新来的随时可能在读,⛔ 让它读到写了一半的内容。
 * 留不下不算失败——名片只是让界面有话可说,⛔ 因为它写不进去就放弃已经拿到的写入权。
 */
export function publishWriteRightOwner(info, path = writeRightOwnerPath()) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...info, at: Date.now() })}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return true
  } catch { return false }
}

/** 读名片。读不到/坏了都返回 undefined —— 调用方按「有人持有但认不出是谁」处理,⛔ 当成没人持有。 */
export function readWriteRightOwner(path = writeRightOwnerPath()) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const pid = Number.isSafeInteger(parsed.pid) ? parsed.pid : undefined
  const dataDir = typeof parsed.dataDir === 'string' && parsed.dataDir.length > 0 ? parsed.dataDir : undefined
  const version = typeof parsed.version === 'string' ? parsed.version : ''
  const runId = typeof parsed.runId === 'string' ? parsed.runId : ''
  const resident = parsed.resident === true
  const at = Number.isSafeInteger(parsed.at) ? parsed.at : undefined
  // 本次持权令牌:每取得一次写入权换一个。它把名片与持有者**这一轮**写出的 state 绑在一起——
  // ⛔ 拿名片里的数据目录直接去读 state.json:那份 state 可能是上一任守护留下的旧货,
  // 会让后启动者把陈年的「已连接」当成当前状态说出去。
  const token = typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : undefined
  return { pid, dataDir, version, runId, resident, at, token }
}

/** 交还写入权时撕掉名片。⛔ 删别人的:只在自己确实是名片上那个 pid 时删。 */
export function clearWriteRightOwner(pid = process.pid, path = writeRightOwnerPath()) {
  const current = readWriteRightOwner(path)
  if (current !== undefined && current.pid !== undefined && current.pid !== pid) return false
  try { rmSync(path, { force: true }); return true } catch { return false }
}

/**
 * 在同一把系统代理写入权下执行一段**恢复写入**(创始人 2026-09-15 P1 第二轮)。
 *
 * 守护的连接路径由 DaemonCore 自己持权,但**一次性恢复**不经过它:
 * restore 子命令、损坏账本恢复、残留代理清理、崩溃兜底、常驻自愈都会直接写 WinINET。
 * 这些路径两份安装都会走到,不纳进同一把权,前面修的东西等于漏了一半。
 *
 * 拿不到权就**整段不执行**(⛔ 让它写一半):系统代理此刻归持权那一方管。
 * options.timeoutMs:等待持权方交出的有界时长(N-23);缺省 0 = 立即返回。
 * 平台不提供这把权(mac 现阶段)时原样执行,⛔ 顺手改掉另一个平台的语义。
 */
export function withWriteRight(adapter, fn, log = () => undefined, options = {}) {
  if (typeof adapter?.acquireWriteRight !== 'function') return { ok: true, value: fn() }
  const requested = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.trunc(options.timeoutMs)) : 0
  let outcome
  try { outcome = adapter.acquireWriteRight({ timeoutMs: requested }) } catch { outcome = undefined }
  if (outcome?.acquired !== true) {
    log(`系统代理写入权不在本进程(${outcome?.reason ?? 'unavailable'},等待 ${String(requested)} ms):本次不改动系统设置`)
    return { ok: false, reason: outcome?.reason ?? 'unavailable' }
  }
  try { return { ok: true, value: fn() } } finally {
    try { outcome.release() } catch { /* 内核已回收 */ }
  }
}

/**
 * 常驻自愈的写入权闸门(P1)。自愈会按账本写回系统代理,同样要持权。
 * 拿不到时返回「这轮先不做」的 outcome:settingsBusy=true 且 shouldExit=false ——
 * 调用方的语义正是「留在原地下一轮再试」。⛔ 返回 shouldExit,那等于谎称已还干净然后退出。
 */
export function guardedResidentSelfHeal(adapter, run, log = () => undefined) {
  const guarded = withWriteRight(adapter, run, log)
  if (guarded.ok) return guarded.value
  return { restored: 0, keptModified: 0, failed: [], unrestored: 0, residentRemoved: false,
    shouldExit: false, settingsBusy: true, reason: 'write-right-held' }
}
