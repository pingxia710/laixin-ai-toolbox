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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoopbackProbeConnector, createSshSocksConnector } from './connectors.mjs'
import { createVlessConnector } from './vless-connector.mjs'
import { createDaemon, installCrashBailout, readIntent, startPowerEvents, statePath, writeState,
  SHUTDOWN_RESTORE_RETRY_MS, SHUTDOWN_RESTORE_SLOW_MS, SHUTDOWN_RESTORE_SLOW_ROUNDS } from './daemon-core.mjs'
import { acquireInstanceLock } from './instance-lock.mjs'
import { guardedResidentSelfHeal, withWriteRight } from './write-right-owner.mjs'
import { createResidentIntegrityCheck, runResidentSelfHeal } from './resident-integrity.mjs'
import { ENTRY_STATUS, lastIntent, ledgerFailure, loadLedger } from './ledger.mjs'
import { createLocalBridge } from './local-bridge.mjs'
import { rebroadcastSettings, recoverLedger, restoreLedger, unrestoredEntries } from './restore.mjs'
import { existsSync, readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ADAPTER = join(here, 'managed-adapter.mjs')

/**
 * N-23:一次性恢复拿写权的有界等待。基线 0 秒抢:常驻守护/另一份安装正持权(连接中、慢恢复中)时
 * 探测即失败 exit 65,账本没机会被碰,客户界面永远「未完成(进程中断)」。改成有界等待——对齐甲-2
 * 梯子的节奏语义:等持权方这一轮做完交出权,再做恢复;等不到仍按 TUNNEL_WRITE_RIGHT_HELD 如实回报。
 */
const RESTORE_WRITE_RIGHT_WAIT_MS = 15_000

/**
 * W4-1(真机 2026-09-14):卸载兜底挂在「restore 退出码 ≠ 0」上,而**账本里一条设置账目都没有**时
 * restore 空跑成功 exit 0——「空成功」把兜底永远骗过,客户卸完顶着一个指向死口的系统代理断网。
 * 修法查结果不查过程:账本没有设置账目时,看代理现在指不指着**我们**(回环 + 我们自己的口)。
 * 我们的口 = 默认候选(与 app/main BRIDGE_PORT_CANDIDATES 同源,随机兜底口除外) ∪ state.json 里
 * 上次实际用的 bridgePort。认口认到「我们的口」为止,⛔ 回环上客户自己的代理(不在我们的口集合里)。
 */
const OUR_DEFAULT_BRIDGE_PORTS = [18080, 18180, 18280, 18380, 18480]

function loopbackPortOf(proxyServerData) {
  for (const part of String(proxyServerData ?? '').split(';')) {
    const match = /^(?:[a-z]+:\/\/)?\[?([^\]/:]+)\]?:(\d{1,5})$/i.exec(part.trim())
    if (match === null) continue
    const host = match[1].toLowerCase()
    if (host === 'localhost' || host.startsWith('127.') || host === '::1') return Number(match[2])
  }
  return undefined
}

function clearOurProxyResidue(dataDir, adapter) {
  try {
    const enable = adapter.read({ service: 'WinINET', item: 'ProxyEnable' })
    if (enable?.data !== '1') return undefined
    const server = adapter.read({ service: 'WinINET', item: 'ProxyServer' })
    const port = loopbackPortOf(server?.data)
    if (port === undefined) return undefined
    const ours = new Set(OUR_DEFAULT_BRIDGE_PORTS)
    try {
      const state = JSON.parse(readFileSync(statePath(dataDir), 'utf8'))
      if (Number.isFinite(state?.bridgePort)) ours.add(Number(state.bridgePort))
    } catch { /* 没有 state:只认默认候选 */ }
    if (!ours.has(port)) return undefined
    adapter.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '0' })
    try { adapter.broadcastSettingsChanged?.() } catch { /* 通知失败不改「已写回」的事实 */ }
    return port
  } catch { return undefined }
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
    const seat = acquireInstanceLock(dataDir, { runId: flags['run-id'] ?? '' })
    if (!seat.acquired) {
      process.stderr.write(`[tunnel-daemon] 同一数据目录已有守护在跑(pid ${String(seat.holder?.pid ?? '未知')}),本进程让位\n`)
      return
    }
    releaseInstance = seat.release
    process.on('exit', () => releaseInstance())
  }

  const adapter = await loadAdapter(flags.adapter ?? DEFAULT_ADAPTER)

  // 损坏账本先走恢复流程(收敛包3·件4):成功即清标记继续;失败才致命停止并给可复制诊断。
  const failure = ledgerFailure(dataDir)
  if (failure) {
    let recovery
    // 损坏账本恢复会写回 WinINET:必须持同一把写入权(P1)。拿不到 → 不写,按恢复失败处理。
    const guardedRecovery = withWriteRight(adapter, () => {
      try { return recoverLedger(dataDir, adapter) } catch (error) {
        process.stderr.write(`[tunnel-daemon] 恢复流程异常:${error instanceof Error ? error.message : String(error)}\n`)
        return undefined
      }
    }, (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`))
    recovery = guardedRecovery.ok ? guardedRecovery.value : undefined
    if (recovery === undefined || recovery.failed.length > 0) {
      writeState(dataDir, { state: 'error', ...failure })
      process.stderr.write(`[tunnel-daemon] ${recovery?.diagnostics ?? failure.message}\n`)
      process.stdout.write(`${JSON.stringify({ state: 'error', ...failure, diagnostics: recovery?.diagnostics ?? failure.message })}\n`)
      process.exitCode = 65
      return
    }
    process.stderr.write(`[tunnel-daemon] 损坏账本已恢复(写回 ${recovery.recovered.length} 项,保留他人现值 ${recovery.keptModified.length} 项),坏账本已留证\n`)
  }

  if (command === 'restore') {
    // 一次性恢复同样是写系统代理(P1):主进程的 recoverOnBoot / runRecoveryOnce 都派发这条命令,
    // 两份安装会同时走到。拿不到写入权就什么都不动,按「未完成」如实回报,⛔ 让主进程以为已还干净。
    // 残留清理必须在**同一次**写入权里(P1 三轮):它在空账本时会写 ProxyEnable=0。
    // ⛔ 放在 withWriteRight 之后 —— 那时权已经交还,另一份来信正持权时这条路径仍能越权改 WinINET。
    // 空账本正是它唯一会开火的场景,而账本一写就轮不到它,所以之前的用例全绕过了这条路。
    // N-23:拿权改「有界等待」——基线 0 秒抢在守护/另一份安装正持权的窗口必失败(见 RESTORE_WRITE_RIGHT_WAIT_MS)。
    const logLine = (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`)
    const attempt = () => withWriteRight(adapter, () => {
      const inner = restoreLedger(dataDir, adapter)
      if (inner.notifyFailed) rebroadcastSettings(dataDir, adapter)
      // 空成功检查(W4-1):账本里一条设置账目都没有 = 什么都没还原过,此时还原「成功」不代表
      // 客户的设置回来了。代理还指着我们的口就关掉,客户回到直连。⛔ 账本健全时跳过——
      // 那种情况下回环代理是客户自己的(正常还原成功),无检查开火会误伤他。
      let residue
      try {
        residue = loadLedger(dataDir).some((entry) => entry.kind === 'setting')
          ? undefined
          : clearOurProxyResidue(dataDir, adapter)
      } catch { residue = undefined }
      return { inner, residue }
    }, logLine, { timeoutMs: RESTORE_WRITE_RIGHT_WAIT_MS })
    // 甲-2:一次性恢复接上守护同款的重试梯子(同参数同语义,⛔ 另造一套)。基线是裸调一次
    // restoreLedger,杀软短暂锁注册表这类暂时性写失败一次就 exit 65,等客户手动点「重试恢复原设置」。
    // 暂时性 = 账本里有 restore-failed 设置条目;写权被别人占着不是暂时性(另一份安装接管着),
    // 照旧如实回报不空转;意图文件变成 connected = 有守护正要接手「先恢复再连接」,本进程让位。
    let guarded = attempt()
    const settled = () => guarded.ok && unrestoredEntries(dataDir).length === 0
    const transient = () => guarded.ok &&
      loadLedger(dataDir).some((entry) => entry.kind === 'setting' && entry.status === ENTRY_STATUS.restoreFailed)
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
    for (let round = 1; !settled() && transient() && round <= SHUTDOWN_RESTORE_SLOW_ROUNDS && shouldContinue(); round += 1) {
      logLine(`一次性恢复未完成,${String(SHUTDOWN_RESTORE_SLOW_MS / 1000)} 秒后再试(慢节奏第 ${String(round)} 轮)`)
      await new Promise((resolve) => { setTimeout(resolve, SHUTDOWN_RESTORE_SLOW_MS) })
      if (!shouldContinue()) break
      guarded = attempt()
    }
    if (!guarded.ok) {
      writeState(dataDir, { state: 'error', code: 'TUNNEL_WRITE_RIGHT_HELD',
        message: '这台电脑的网络设置正由另一个来信后台管理，本次未改动；请先退出那一份再重试恢复' })
      process.exitCode = 65
      process.stdout.write(`${JSON.stringify({ restored: 0, keptModified: [], failed: [], writeRight: guarded.reason })}\n`)
      return
    }
    const result = guarded.value.inner
    const residueCleared = guarded.value.residue
    // 完成与否看账本里还有没有未结算的设置:preserved(保留他人现值)已是终态,⛔ 再按 keptModified 数判失败。
    const incomplete = unrestoredEntries(dataDir).length > 0
    writeState(dataDir, incomplete
      ? { state: 'error', code: 'TUNNEL_RESTORE_INCOMPLETE', message: '原设置尚未恢复，请重试恢复；其他软件修改的设置会保留' }
      : { state: 'stopped-restored', code: '', message: '' })
    process.exitCode = incomplete ? 65 : 0
    process.stdout.write(
      `${JSON.stringify({
        restored: result.restored.length,
        keptModified: result.keptModified.map((entry) => `${entry.service}/${entry.item}`),
        failed: result.failed.map((entry) => `${entry.service}/${entry.item}:${entry.note}`),
        ...(residueCleared === undefined ? {} : { residueClearedProxyPort: residueCleared, note: '卸载前发现系统代理仍指向本机中继的残留端口,已关闭系统代理' })
      })}\n`
    )
    return
  }

  if (command !== 'start') {
    process.stderr.write(`未知子命令:${command}\n`)
    process.exit(64)
  }

  // 顶层兜底(收敛包3·件1):致命异常先恢复系统代理再退出。
  installCrashBailout({ dataDir, adapterOf: () => adapter, runId: flags['run-id'] ?? '', log: (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`) })

  // 常驻席位已在 main() 开头先查后拿(N-23):非常驻模式**不取这把锁**——那边「旧守护慢恢复 +
  // 新守护接手」是合法并存(五轮复核建立的交接机制),取锁会让客户重开工具箱时连不上。
  const startPpid = process.ppid
  const realClock = makeRealClock()
  const daemon = createDaemon({
    dataDir,
    runId: flags['run-id'] ?? '',
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
        const log = (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`)
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
    log: (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`)
  })
  if (!resident) process.on('disconnect', () => daemon.requestShutdown())
  process.on('message', (message) => {
    if (message?.type === 'network-event') daemon.notifyEvent(message.event)
  })
  const powerSource = startPowerEvents({
    emit: (event) => daemon.notifyEvent(event),
    log: (line) => process.stderr.write(`[tunnel-daemon] ${line}\n`)
  })
  const keepalive = setInterval(() => undefined, 60_000)
  // SIGTERM/SIGBREAK 一律走完整还原(关机、注销、launchctl bootout、计划任务被停都从这里来):
  // 「常驻」⛔ 等于「关机也不还」——那会把指向死端口的系统代理留给客户。
  process.on('SIGTERM', () => daemon.requestShutdown())
  process.on('SIGBREAK', () => daemon.requestShutdown())
  process.on('exit', () => { clearInterval(keepalive); powerSource.stop() })
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

function makeRealClock() {
  const timers = new Map()
  let sequence = 0
  const register = (handle) => {
    sequence += 1
    timers.set(sequence, handle)
    return sequence
  }
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => register(setTimeout(fn, ms)),
    setInterval: (fn, ms) => register(setInterval(fn, ms)),
    clearTimer: (id) => {
      const handle = timers.get(id)
      if (handle !== undefined) {
        // setTimeout / setInterval 都返回 Timeout,clearTimeout 对两者都有效
        clearTimeout(handle)
        timers.delete(id)
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[tunnel-daemon] 致命错误:${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(70)
})
