#!/usr/bin/env node
// 通道守护进程入口(sidecar/mac/,随包以 ELECTRON_RUN_AS_NODE 起;开发与测试用系统 node 跑)。
// 用法:
//   start   --data-dir <dir> [--adapter <mjs路径>] [--intent-poll-ms N] [--parent-poll-ms N] [--verify-interval-ms N]
//   restore --data-dir <dir> [--adapter <mjs路径>]   一次性按账本恢复(主进程发现守护死亡后用)
//   status  --data-dir <dir>                          打印 state + 账本未恢复项(JSON)
// 默认适配器 = 真实 macOS networksetup 适配器(带加载闸,只在本片片内指定环境放行);
// 测试一律经 --adapter 注入假适配器。
import process from 'node:process'
import { setTimeout, setInterval, clearTimeout, clearInterval } from 'node:timers'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoopbackProbeConnector, createSshSocksConnector } from './connectors.mjs'
import { createVlessConnector } from './vless-connector.mjs'
import { createDaemon, installCrashBailout, observeRecoveryOwnership, recoveryOwnedByOther, readIntent, startPowerEvents, statePath, writeState,
  SHUTDOWN_RESTORE_RETRY_MS, SHUTDOWN_RESTORE_SLOW_MS, SHUTDOWN_RESTORE_SLOW_ROUNDS } from './daemon-core.mjs'
import { acquireInstanceLock } from './instance-lock.mjs'
import { guardedResidentSelfHeal, withWriteRight, writeRightFailure } from './write-right-owner.mjs'
import { createResidentIntegrityCheck, runResidentSelfHeal } from './resident-integrity.mjs'
import { ENTRY_STATUS, lastIntent, ledgerFailure, loadLedger, withSettingsLock } from './ledger.mjs'
import { createLocalBridge } from './local-bridge.mjs'
import { rebroadcastSettings, recoverLedger, restoreLedger, unrestoredEntries } from './restore.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { formatDaemonLogLine, probeProxyFaces } from './continuity-evidence.mjs'
import { createEmergencyRecoveryAdapter } from './emergency-recovery-adapter.mjs'

function logDaemon(line, runId = '') {
  process.stderr.write(formatDaemonLogLine(line, { now: Date.now(), pid: process.pid, runId }))
}

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ADAPTER = join(here, 'managed-adapter.mjs')

/**
 * N-23:一次性恢复拿写权的有界等待。基线 0 秒抢:常驻守护/另一份安装正持权(连接中、慢恢复中)时
 * 探测即失败 exit 65,账本没机会被碰,客户界面永远「未完成(进程中断)」。改成有界等待——对齐甲-2
 * 梯子的节奏语义:等持权方这一轮做完交出权,再做恢复;等不到仍按 TUNNEL_WRITE_RIGHT_HELD 如实回报。
 */
const RESTORE_WRITE_RIGHT_WAIT_MS = 15_000

/** 启动看门狗与主进程监管器同一预算：只处理「没有进入守护状态」的坏启动。 */
export const STARTUP_WATCHDOG_MS = 120_000
export const STARTUP_WATCHDOG_EXIT_CODE = 75

function absolutePathFor(value, platform) {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
  return isAbsolute(value)
}

/**
 * 在接管系统设置前检查启动上下文。返回安全的短原因，⛔ 不把完整路径/环境变量写进状态。
 * 适配器缺失或 Windows 真实适配器没有放行钥匙时，继续启动只会每分钟重复失败并留下半成品。
 */
export function startupContextIssue({ dataDir, adapterPath, resident = false, taskPath, platform = process.platform, env = process.env } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '' || !absolutePathFor(dataDir, platform)) return '数据目录不是绝对路径'
  if (typeof adapterPath !== 'string' || adapterPath === '' || !absolutePathFor(adapterPath, platform)) return '适配器路径不是绝对路径'
  if (!existsSync(adapterPath)) return '适配器文件不存在'
  if (resident && platform === 'win32' && /managed-adapter\.mjs$/i.test(adapterPath) && env.TOOLBOX_REAL_NETWORK_ADAPTER !== '1') {
    return 'Windows 真实适配器未获运行放行'
  }
  if (resident && platform === 'win32' && taskPath !== undefined && !/^\\[^\\]+\\[^\\]+$/.test(taskPath)) {
    return 'Windows 常驻任务路径无效'
  }
  return undefined
}

/**
 * 常驻任务没有主进程可以观察。120 秒内连 state.json 都没写出来，说明卡在入口、适配器加载或
 * 取席位之前；退出 75 让 Windows 计划任务下一分钟重新拉起。state 一旦带上本轮 runId，
 * 后续慢连接由 daemon-core 的阶段预算负责，⛔ 不因机器慢误杀合法连接。
 */
export function armStartupWatchdog({ dataDir, runId, log = () => undefined, exit = (code) => process.exit(code), timeoutMs = STARTUP_WATCHDOG_MS } = {}) {
  if (typeof runId !== 'string' || runId === '') return () => undefined
  let settled = false
  let poll
  const stop = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (poll !== undefined) clearInterval(poll)
  }
  const stateReady = () => {
    try {
      if (existsSync(statePath(dataDir))) {
        const state = JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
        if (state?.runId === runId) return true
      }
      // 启动恢复可能先进入同步适配器/账本梯子，再来得及发布 stateDetails；
      // recovery-owner 是同一数据目录里由本轮 runId 原子发布的进度证据，不能因慢机
      // 合法恢复超过 120 秒就误杀。旧 owner 不会与本轮随机 runId 相同。
      const ownerPath = join(dataDir, 'recovery-owner.json')
      if (!existsSync(ownerPath)) return false
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
      return owner?.runId === runId
    } catch { return false }
  }
  const check = () => {
    if (settled || !stateReady()) return
    stop()
  }
  const timer = setTimeout(() => {
    if (settled || stateReady()) { stop(); return }
    stop()
    log(`启动看门狗超时，退出 ${String(STARTUP_WATCHDOG_EXIT_CODE)} 让计划任务重拉`)
    exit(STARTUP_WATCHDOG_EXIT_CODE)
  }, timeoutMs)
  poll = setInterval(check, 1_000)
  timer.unref?.()
  poll.unref?.()
  check()
  return stop
}

function loopbackEndpointsOf(proxyServerData) {
  const endpoints = []
  const seen = new Set()
  for (const part of String(proxyServerData ?? '').split(';')) {
    const value = part.trim().replace(/^[a-z][a-z0-9+.-]*\s*=\s*/i, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(value)
    if (match === null) continue
    const host = match[1].replace(/^\[|\]$/g, '').toLowerCase()
    const port = Number(match[2])
    const key = `${host}:${String(port)}`
    if (port > 0 && port <= 65535 && (host === 'localhost' || host.startsWith('127.') || host === '::1') && !seen.has(key)) {
      endpoints.push({ host, port })
      seen.add(key)
    }
  }
  return endpoints
}

function suspectProxyResidue(adapter) {
  try {
    let endpoints
    if (typeof adapter.readProxyEndpoints === 'function') {
      endpoints = adapter.readProxyEndpoints()
    } else {
      const enable = adapter.read({ service: 'WinINET', item: 'ProxyEnable' })
      if (enable?.data !== '1') return undefined
      const server = adapter.read({ service: 'WinINET', item: 'ProxyServer' })
      endpoints = loopbackEndpointsOf(server?.data)
    }
    // state.json 会被本次恢复结果覆盖，不能用旧 bridgePort 白名单决定下一次是否检查。
    // 任意启用的本机代理若无明确的第三方活监听，都只读报归属未明，不凭端口自动修改。
    // 当前端口归属探针只验证 IPv4 127.0.0.1；其他回环地址无法据此证明活路由。
    for (const { host: rawHost, port } of endpoints) {
      const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
      if (host !== 'localhost' && !host.startsWith('127.') && host !== '::1') continue
      if (host !== '127.0.0.1') return { kind: 'ownership-unknown', port }
      // This is a recovery safety check, so a short-lived probe cache is not
      // evidence: a previous listener may have exited or been replaced already.
      const owner = adapter.identifyPortOwner?.(port, { fresh: true })
      if (owner?.kind === 'other' || owner?.kind === 'laixin') continue
      if (owner?.kind === 'unknown' && owner.reason !== 'address-ambiguous') return { kind: 'inspection-failed' }
      return { kind: 'ownership-unknown', port }
    }
    return undefined
  } catch { return { kind: 'inspection-failed' } }
}

/**
 * 常驻任务自禁(2026-09-14 真机复现台定形;Windows 侧生效,mac 不会带 --task-path):
 * shutdown 意图干净收尾(退出码 0)后把登录任务禁用。为什么要有这一步:任务带每分钟重入保活
 * (真机上 RestartOnFailure 不重启,保活只能靠重入),守护**干净**退出后如果任务还开着,重入会把
 * 退了的守护一遍遍拉起来空转——每分钟一只完整守护,一天一千四百多次,等于在客户机器上装了个永动机。
 * 崩溃/被杀走不到这里,任务保持启用,60 秒内被拉回;判「是不是干净收尾」看账本最后意图是不是
 * shutdown(交出席位的新守护记的是 connected,⛔ 误禁)。调用方(主进程叫醒路径)先 /change /enable
 * 再 /run,所以自禁 ⛔ 挡住「点连接必连上」。⛔ 只在 Windows 有计划任务;--task-path 未传就不连线。
 */
async function settleResidentTask(dataDir, taskPath) {
  let wasShutdown = false
  try { wasShutdown = lastIntent(dataDir) === 'shutdown' } catch { /* 账本读不出:不判自禁,保活宁多勿断 */ }
  if (!wasShutdown) return
  await new Promise((resolve) => {
    const child = spawn('schtasks.exe', ['/change', '/tn', taskPath, '/disable'], { windowsHide: true, stdio: 'ignore' })
    // Phase 1 ③(schtasks 僵尸):超时兜底必须连孩子一起收——杀软锁注册表/命令表时 schtasks
    // 会挂住,只 resolve 不 kill 的话守护照常退、挂着的孩子变孤儿,每次干净收尾攒一只,老机器
    // 被拖慢。正常退出先清定时器,⛔ 走到 kill(误杀已退进程是 no-op,但路径上别依赖它)。
    const timer = setTimeout(() => { try { child.kill() } catch { /* 尽力收,失败不挡退出 */ } resolve(undefined) }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolve(undefined) })
    child.once('error', () => { clearTimeout(timer); resolve(undefined) })
  })
}

/**
 * 普通适配器导入失败时的独立恢复入口。它必须与入口 main 共用设置锁、恢复 owner 和账本，
 * 这样“旧 restore / 新守护 / 组件损坏”三者交错时不会互相覆盖。
 */
export async function recoverAfterAdapterLoadFailure({ dataDir, runId, recoveryOwnershipObserved, createAdapter = () => createEmergencyRecoveryAdapter({ platform: process.platform }), log = () => undefined } = {}) {
  let restored = false
  let handedOver = false
  let emergency
  let emergencyError
  try { emergency = await createAdapter() } catch (error) { emergencyError = error }
  withSettingsLock(dataDir, () => {
    // state.json 是可过期的诊断快照，不能单独证明另一守护仍持有恢复责任。
    // 交接只认本次启动后在设置锁内发布的更高 recovery-owner 代次。
    if (recoveryOwnedByOther(dataDir, runId, recoveryOwnershipObserved)) {
      handedOver = true
      return
    }
    try {
      if (emergency === undefined) throw emergencyError ?? new Error('EMERGENCY_ADAPTER_UNAVAILABLE')
      const recovered = withWriteRight(emergency, () => restoreLedger(dataDir, emergency), log)
      // 空账本/损坏账本时 restoreLedger 可能没有任何可写条目；仍必须检查当前
      // 本机代理是否残留在来信桥端口，否则会把死代理误报为“已恢复”。
      const suspect = recovered.ok ? suspectProxyResidue(emergency) : undefined
      restored = recovered.ok && unrestoredEntries(dataDir).length === 0 && suspect === undefined
      if (suspect !== undefined) log(`独立恢复通道发现代理残留:${suspect.kind}`)
    } catch (error) {
      log(`独立恢复通道不可用:${error instanceof Error ? error.message : String(error)}`)
    }
    writeState(dataDir, {
      state: 'error', runId, code: 'TUNNEL_ADAPTER_LOAD_FAILED',
      message: restored ? '网络组件不完整，已先恢复原系统代理；请重新安装工具箱'
        : '网络组件不完整，原系统代理尚未确认恢复；请重新安装工具箱'
    })
  }, { owner: `adapter-load-failure:${runId}`, timeoutMs: 5_000 })
  return { restored, handedOver }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  const dataDir = flags['data-dir']
  if (dataDir === undefined || command === undefined) {
    process.stderr.write('用法: tunnel-daemon.mjs start|restore|status --data-dir <dir> [选项]\n')
    process.exit(64)
  }

  // 常驻模式(--resident 1):由系统的每用户机制看着(macOS LaunchAgent / Windows 登录任务),没有父进程,
  // 界面崩了/被杀了/开机还没打开工具箱,网络该在的时候就在。⛔ 与 --parent-ipc 同时给。
  const resident = flags.resident === '1'
  if (resident && flags['parent-ipc'] === '1') throw new Error('RESIDENT_WITH_PARENT_IPC')
  if (command === 'start' && !resident && flags['parent-ipc'] === '1' && !process.connected) throw new Error('PARENT_IPC_REQUIRED')
  // 常驻任务由系统直接启动，不带主进程分配的 --run-id；它必须自行生成非空本轮身份，
  // 且席位、崩溃兜底、恢复 owner、state 全程共用同一个值。
  const runId = command === 'start' || command === 'restore' ? (flags['run-id'] || randomUUID()) : ''

  const adapterPath = flags.adapter ?? DEFAULT_ADAPTER
  if (command === 'start' || command === 'restore') {
    try { mkdirSync(dataDir, { recursive: true }) } catch {
      logDaemon('启动上下文无效:数据目录不可写', runId)
      process.exitCode = STARTUP_WATCHDOG_EXIT_CODE
      return
    }
    const contextIssue = startupContextIssue({ dataDir, adapterPath, resident, taskPath: flags['task-path'] })
    if (contextIssue !== undefined) {
      logDaemon(`启动上下文无效:${contextIssue}`, runId)
      process.exitCode = STARTUP_WATCHDOG_EXIT_CODE
      return
    }
  }

  // Windows 计划任务没有父进程可监控；先武装看门狗，座位/适配器加载本身卡住时也能自退。
  const stopStartupWatchdog = command === 'start'
    ? armStartupWatchdog({ dataDir, runId, log: (line) => logDaemon(line, runId) })
    : () => undefined

  if (command === 'status') {
    const failure = ledgerFailure(dataDir)
    if (failure) {
      process.stdout.write(`${JSON.stringify({ state: { state: 'error', ...failure }, intent: null, unrestored: [] })}\n`)
      process.exitCode = 65
      return
    }
    const state = existsSync(statePath(dataDir))
      ? JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
      : { state: 'idle' }
    process.stdout.write(
      `${JSON.stringify({
        state,
        intent: lastIntent(dataDir) ?? null,
        unrestored: unrestoredEntries(dataDir).map((entry) => ({
          service: entry.service,
          item: entry.item,
          status: entry.status,
          note: entry.note
        }))
      })}\n`
    )
    return
  }

  // N-23 先查后拿:常驻 start 先查席位,再装适配器/读账本。每分钟计划任务会把守护一遍遍拉起,
  // 席位被占的那一票(恢复楔死期间尤其多)要在做任何重活之前就安静退出——基线先读账本再让位:
  // 损坏账本当场被隔离重命名、白跑一轮恢复,每分钟一次的空转在恢复楔死期间反复发生。
  // 恢复责任仍归席位上的守护(它启动时先按账本还旧账)。
  let releaseInstance = () => undefined
  if (command === 'start' && resident) {
    const seat = acquireInstanceLock(dataDir, { runId })
    if (!seat.acquired) {
      logDaemon(`同一数据目录已有守护在跑(pid ${String(seat.holder?.pid ?? '未知')}),本进程让位`, runId)
      stopStartupWatchdog()
      return
    }
    releaseInstance = seat.release
    process.on('exit', () => releaseInstance())
  }

  // 先安装兜底，再加载适配器。适配器的任一传递依赖缺失时，入口不能直接落到裸 exit(70)
  // 把已应用代理留在系统里；至少要在同一把设置锁内留下受控失败状态，且不覆盖已接管的新守护。
  let adapter
  const recoveryOwnershipObserved = observeRecoveryOwnership(dataDir)
  const crashBailout = command === 'start' || command === 'restore'
    ? installCrashBailout({ dataDir, adapterOf: () => adapter, runId, log: (line) => logDaemon(line, runId) })
    : undefined
  try {
    adapter = await loadAdapter(adapterPath)
  } catch (error) {
    try {
      await recoverAfterAdapterLoadFailure({ dataDir, runId, recoveryOwnershipObserved,
        log: (line) => logDaemon(line, runId) })
    } catch { /* 锁忙时保留旧状态，交给下一次守护恢复 */ }
    logDaemon(`适配器加载失败:${error instanceof Error ? error.message : String(error)}`, runId)
    crashBailout?.dispose()
    stopStartupWatchdog()
    process.exitCode = 70
    return
  }

  // 损坏账本先走恢复流程(收敛包3·件4):成功即清标记继续;失败才致命停止并给可复制诊断。
  const failure = ledgerFailure(dataDir)
  if (failure) {
    let recovery
    // 损坏账本恢复会写回 WinINET:必须持同一把写入权(P1)。拿不到 → 不写,按恢复失败处理。
    const guardedRecovery = withWriteRight(adapter, () => {
      try { return recoverLedger(dataDir, adapter) } catch (error) {
        logDaemon(`恢复流程异常:${error instanceof Error ? error.message : String(error)}`, runId)
        return undefined
      }
    }, (line) => logDaemon(line, runId))
    recovery = guardedRecovery.ok ? guardedRecovery.value : undefined
    if (recovery === undefined || recovery.failed.length > 0) {
      writeState(dataDir, { state: 'error', ...failure })
      logDaemon(recovery?.diagnostics ?? failure.message, runId)
      process.stdout.write(`${JSON.stringify({ state: 'error', ...failure, diagnostics: recovery?.diagnostics ?? failure.message })}\n`)
      process.exitCode = 65
      crashBailout?.dispose()
      stopStartupWatchdog()
      return
    }
    logDaemon(`损坏账本已恢复(写回 ${recovery.recovered.length} 项,保留他人现值 ${recovery.keptModified.length} 项),坏账本已留证`, runId)
  }

  if (command === 'restore') {
    // 一次性恢复同样是写系统代理(P1):主进程的 recoverOnBoot / runRecoveryOnce 都派发这条命令,
    // 两份安装会同时走到。拿不到写入权就什么都不动,按「未完成」如实回报,⛔ 让主进程以为已还干净。
    // 空账本的疑似残留检查与恢复在同一次写入权里,避免与另一份来信交接时误报。
    // N-23:拿权改「有界等待」——基线 0 秒抢在守护/另一份安装正持权的窗口必失败(见 RESTORE_WRITE_RIGHT_WAIT_MS)。
    const logLine = (line) => logDaemon(line, runId)
    const attempt = () => withWriteRight(adapter, () => {
      const inner = restoreLedger(dataDir, adapter)
      if (inner.notifyFailed) rebroadcastSettings(dataDir, adapter)
      // 空账本或账目已结算后，仍要核实 IPv4 入口没有指向疑似死口；
      // PAC / bypass 的外部改动不能单独证明原手工代理已恢复。
      let suspect
      try {
        const ledger = loadLedger(dataDir)
        suspect = ledger.some((entry) => entry.kind === 'setting' && entry.service === 'WinINET') ||
          !ledger.some((entry) => entry.kind === 'setting') || typeof adapter.identifyPortOwner === 'function'
          ? suspectProxyResidue(adapter) : undefined
      } catch { suspect = { kind: 'inspection-failed' } }
      return { inner, suspect }
    }, logLine, { timeoutMs: RESTORE_WRITE_RIGHT_WAIT_MS })
    // 甲-2:一次性恢复接上守护同款的重试梯子(同参数同语义,⛔ 另造一套)。基线是裸调一次
    // restoreLedger,杀软短暂锁注册表这类暂时性写失败一次就 exit 65,等客户手动点「重试恢复原设置」。
    // 暂时性 = 账本里有 restore-failed 设置条目;写权被别人占着不是暂时性(另一份安装接管着),
    // 照旧如实回报不空转;意图文件变成 connected = 有守护正要接手「先恢复再连接」,本进程让位。
    let guarded = attempt()
    const settled = () => guarded.ok && unrestoredEntries(dataDir).length === 0 && guarded.value.suspect === undefined
    const transientLedger = () => guarded.ok &&
      loadLedger(dataDir).some((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.restoreFailed)
    const transient = () => guarded.ok && (guarded.value.suspect?.kind === 'inspection-failed' || transientLedger())
    const shouldContinue = () => readIntent(dataDir)?.desired !== 'connected'
    for (const delay of SHUTDOWN_RESTORE_RETRY_MS) {
      if (settled() || !transient() || !shouldContinue()) break
      logLine(`一次性恢复未完成,${String(delay / 1000)} 秒后再试`)
      await new Promise((resolve) => { setTimeout(resolve, delay) })
      // 甲-2 返工:醒来复查——睡的这一格里意图变成 connected = 有守护已接手「先恢复再连接」,
      // ⛔ 不看一眼就把人家刚写下的设置当旧账还一遍(restoreLedger 认账不认人)。
      if (!shouldContinue()) break
      guarded = attempt()
    }
    // 系统代理读数暂错只跑快速梯子；慢节奏留守只给有账本恢复责任的项，避免无账本卸载卡半小时。
    for (let round = 1; !settled() && transientLedger() && round <= SHUTDOWN_RESTORE_SLOW_ROUNDS && shouldContinue(); round += 1) {
      logLine(`一次性恢复未完成,${String(SHUTDOWN_RESTORE_SLOW_MS / 1000)} 秒后再试(慢节奏第 ${String(round)} 轮)`)
      await new Promise((resolve) => { setTimeout(resolve, SHUTDOWN_RESTORE_SLOW_MS) })
      if (!shouldContinue()) break
      guarded = attempt()
    }
    if (!guarded.ok) {
      writeState(dataDir, { state: 'error', ...writeRightFailure(guarded.reason) })
      process.exitCode = 65
      process.stdout.write(`${JSON.stringify({ restored: 0, keptModified: [], failed: [], writeRight: guarded.reason })}\n`)
      crashBailout?.dispose()
      stopStartupWatchdog()
      return
    }
    const result = guarded.value.inner
    const suspect = guarded.value.suspect
    // 完成与否看账本里还有没有未结算的设置:preserved(保留他人现值)已是终态,⛔ 再按 keptModified 数判失败。
    let incomplete = true
    let handedOver = false
    withSettingsLock(dataDir, () => {
      const latestIntent = readIntent(dataDir)
      // state.json 可能是旧守护崩溃前留下的快照；没有新的 owner 代次时不能让位，
      // 否则本进程会跳过恢复并留下指向死通道的系统代理。
      handedOver = recoveryOwnedByOther(dataDir, runId, recoveryOwnershipObserved)
      if (handedOver) return
      // 最终判定、意图/代次重读和状态写入必须在同一把锁里，旧 restore 才不能盖掉新守护的 connected。
      incomplete = unrestoredEntries(dataDir).length > 0 || suspect !== undefined
      writeState(dataDir, incomplete
        ? { state: 'error', runId, intentToken: latestIntent?.sessionToken, code: suspect === undefined ? 'TUNNEL_RESTORE_INCOMPLETE'
            : suspect.kind === 'inspection-failed' ? 'TUNNEL_PROXY_INSPECTION_FAILED' : 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN',
            message: suspect === undefined ? '原设置尚未恢复，请重试恢复；其他软件修改的设置会保留'
              : suspect.kind === 'inspection-failed' ? '无法读取系统代理或端口归属，未改动系统代理，请联系客服核实'
                : '代理端口可能是来信残留，也可能由其他软件接管；未改动系统代理，请联系客服核实' }
        : { state: 'stopped-restored', runId, intentToken: latestIntent?.sessionToken, code: '', message: '' })
    }, { owner: `restore-final:${runId}`, timeoutMs: RESTORE_WRITE_RIGHT_WAIT_MS })
    process.exitCode = handedOver ? 65 : incomplete ? 65 : 0
    process.stdout.write(
      `${JSON.stringify({
        restored: result.restored.length,
        keptModified: result.keptModified.map((entry) => `${entry.service}/${entry.item}`),
        failed: result.failed.map((entry) => `${entry.service}/${entry.item}:${entry.note}`),
        ...(suspect === undefined ? {} : suspect.kind === 'inspection-failed'
          ? { inspectionFailed: true, note: '无法完成系统代理检查，未改动系统代理' }
          : { ownershipUnknown: true, suspectProxyPort: suspect.port,
              note: '空账本无法证明代理归属，未改动系统代理' })
      })}\n`
    )
    crashBailout?.dispose()
    stopStartupWatchdog()
    return
  }

  if (command !== 'start') {
    process.stderr.write(`未知子命令:${command}\n`)
    stopStartupWatchdog()
    process.exit(64)
  }

  // 顶层兜底已在适配器加载前安装(收敛包3·件1):致命异常先恢复系统代理再退出。

  // 常驻席位已在 main() 开头先查后拿(N-23):非常驻模式**不取这把锁**——那边「旧守护慢恢复 +
  // 新守护接手」是合法并存(五轮复核建立的交接机制),取锁会让客户重开工具箱时连不上。
  const startPpid = process.ppid
  const realClock = makeRealClock()
  const daemon = createDaemon({
    dataDir,
    runId,
    clock: realClock,
    adapter,
    connectorFactory: (spec) =>
      spec.kind === 'vless-reality' ? createVlessConnector(spec) : spec.kind === 'ssh-socks' ? createSshSocksConnector(spec) : createLoopbackProbeConnector(spec),
    bridgeFactory: (options) => createLocalBridge(options),
    // 常驻模式没有父进程可依:守护的去留只听意图文件与信号,⛔ 因为界面关了就把客户的网断掉。
    parentAlive: () => resident ? true : (flags['parent-ipc'] === '1' ? process.connected : process.ppid === startPpid),
    // 常驻模式下把父进程那个节拍改成自检:主程序和守护脚本自己都还在不在。
    // 连续三轮探不到才算数(乘轮询间隔 = 宽限),⛔ 更新原地换 bundle 的一瞬被误判成「被删了」。
    ...(resident ? {
      residentIntegrity: createResidentIntegrityCheck({ paths: [process.execPath, fileURLToPath(import.meta.url)], threshold: 3 }),
      // 常驻自愈会按账本写回系统代理(P1):同样纳进写入权。拿不到权时报 settingsBusy、
      // shouldExit 保持 false —— 语义正是「这轮先不做,留在原地下一轮再试」,⛔ 当成已还干净退出。
      residentSelfHeal: () => {
        const log = (line) => logDaemon(line, runId)
        return guardedResidentSelfHeal(adapter, () => runResidentSelfHeal({ dataDir, adapter, log }), log)
      }
    } : {}),
    onExit: (code) => {
      // 干净收尾(退出码 0)+ 常驻 + 调用方给了任务路径 → 自禁任务再退。⛔ 传 --task-path 才连线
      // (只有 Windows 常驻形态带);非零退出(崩溃、还原未完成 65)不自禁——保活还得靠它拉回。
      const taskPath = resident ? flags['task-path'] : undefined
      if (code === 0 && taskPath !== undefined) {
        settleResidentTask(dataDir, taskPath).finally(() => process.exit(code))
        return
      }
      process.exit(code)
    },
    intentPollMs: numberFlag(flags, 'intent-poll-ms', 500),
    parentPollMs: numberFlag(flags, 'parent-poll-ms', 500),
    verifyIntervalMs: numberFlag(flags, 'verify-interval-ms', 30_000),
    ...(typeof flags['client-version'] === 'string' ? { clientVersion: flags['client-version'] } : {}),
    log: (line) => logDaemon(line, runId),
    continuityEvidence: true,
    readContinuityFaces: () => probeProxyFaces(dataDir, flags.adapter ?? DEFAULT_ADAPTER)
  })
  if (!resident) process.on('disconnect', () => daemon.requestShutdown())
  process.on('message', (message) => {
    if (message?.type === 'network-event') daemon.notifyEvent(message.event)
  })
  const powerSource = startPowerEvents({
    emit: (event) => daemon.notifyEvent(event),
    log: (line) => logDaemon(line, runId)
  })
  const keepalive = setInterval(() => undefined, 60_000)
  // SIGTERM/SIGBREAK 一律走完整还原(关机、注销、launchctl bootout、计划任务被停都从这里来):
  // 「常驻」⛔ 等于「关机也不还」——那会把指向死端口的系统代理留给客户。
  process.on('SIGTERM', () => daemon.requestShutdown())
  process.on('SIGBREAK', () => daemon.requestShutdown())
  process.on('exit', () => { clearInterval(keepalive); powerSource.stop() })
  // 看门狗自行观察 state.json/recovery-owner.json 并在进入本轮状态后收口。
  // 不能把 run() 返回当成 ready：启动恢复梯子是后台任务，慢机上它可能仍在运行。
  await daemon.run()
}

async function loadAdapter(adapterPath) {
  const mod = await import(pathToFileURL(adapterPath).href)
  if (typeof mod.createAdapter !== 'function') {
    throw new Error(`适配器模块缺 createAdapter:${adapterPath}`)
  }
  return mod.createAdapter(process.env)
}

function parseFlags(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--')) {
      break
    }
    flags[args[index].slice(2)] = args[index + 1]
  }
  return flags
}

function numberFlag(flags, name, fallback) {
  const raw = flags[name]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// 真时钟:一次性定时器触发即从 Map 自摘(常驻守护按周跑,⛔ 到期条目永驻);interval 条目
// 保留到显式 clear。pendingTimers 仅供测试观察定时器表规模。
export function makeRealClock() {
  const timers = new Map()
  let sequence = 0
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      sequence += 1
      const id = sequence
      timers.set(id, setTimeout(() => { timers.delete(id); fn() }, ms))
      return id
    },
    setInterval: (fn, ms) => {
      sequence += 1
      timers.set(sequence, setInterval(fn, ms))
      return sequence
    },
    clearTimer: (id) => {
      const handle = timers.get(id)
      if (handle !== undefined) {
        // setTimeout / setInterval 都返回 Timeout,clearTimeout 对两者都有效
        clearTimeout(handle)
        timers.delete(id)
      }
    },
    pendingTimers: () => timers.size
  }
}

// 直接以脚本运行时才启动 main;⛔ 模块被 import(测试拿 makeRealClock)时跑 main 会按用法错误退出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logDaemon(`致命错误:${error instanceof Error ? error.message : String(error)}`)
    process.exit(70)
  })
}
