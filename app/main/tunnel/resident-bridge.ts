// 常驻接线(主进程侧,0.5.0):把「守护由系统承载」这件事翻译成守护监管能问的三个问题。
//
// 两条硬边界(与 platform/resident.ts 文件头的三条一脉):
//  · **装不上 ⛔ 不给客户连网**。校准失败就回落到主进程自己 spawn 的老路,最坏不比上一版差。
//  · **armed() 必须同步且便宜**。它挂在 isRunning() 下,状态轮询每次都问;Windows 查计划任务要起
//    一个 schtasks 进程,⛔ 放进这条路径——内存态由校准与拨开关维护,那两处才去碰系统。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { lockHolderAlive } from '../../../sidecar/shared/ledger.mjs'
import { readInstanceLock, readInstanceLockCached } from '../../../sidecar/shared/instance-lock.mjs'
import { firstLineOf } from './failure-log'
import type { Platform } from '../precheck/software-platform'
import type { ResidentBridge } from './supervisor'
import type { DaemonLaunch } from './platform/launch'
import {
  RESIDENT_LABEL, ensureResidentDisabled, installResident, macAgentPath, uninstallResident, wakeResident, type ResidentOutcome, type ResidentSpec
} from './platform/resident'

/** 常驻守护的启动参数。与 spawnDaemon 差两处,都是语义差别 ⛔ 手滑抄过来:
 *  · ⛔ --parent-ipc:那是「跟着主进程走,IPC 断开就停」,和常驻正相反(守护侧给了这两个会直接抛 RESIDENT_WITH_PARENT_IPC)。
 *  · ⛔ --run-id:常驻守护每一轮自己发,主进程没参与,拿不到也不该拿。 */
export function residentSpecFor(options: {
  readonly executable: string
  readonly launch: DaemonLaunch
  readonly dataDir: string
  readonly logDir: string
  /** Windows 侧传入任务全路径:守护干净收尾后据此自禁任务(防每分钟重入空转),见 platform/resident.ts。 */
  readonly taskPath?: string
}): ResidentSpec {
  return {
    executable: options.executable,
    args: [
      options.launch.daemonPath, 'start', '--data-dir', options.dataDir, '--adapter', options.launch.adapterPath, '--resident', '1',
      ...(options.taskPath === undefined ? [] : ['--task-path', options.taskPath])
    ],
    env: { ...options.launch.env },
    logDir: options.logDir
  }
}

export interface ResidentRuntime {
  readonly bridge: ResidentBridge
  /** 按开关校准:该装就装、该卸就卸。启动时跑一次(更新换了 bundle 后路径变了,必须重装),拨开关时再跑。 */
  calibrate(enabled: boolean): Promise<ResidentOutcome>
}

export interface ResidentRuntimeDeps {
  readonly dataDir: string
  readonly platform: Platform
  readonly spec: () => ResidentSpec
  /** 常驻只在安装版有意义:开发态没有稳定的可执行文件路径可写进描述文件。 */
  readonly supported: boolean
  readonly install?: (spec: ResidentSpec, platform: string, options?: { leaveRunningInstance?: boolean }) => Promise<ResidentOutcome>
  readonly uninstall?: (platform: string, options?: { leaveRunningInstance?: boolean }) => Promise<void>
  readonly wake?: (platform: string, staleTaskPaths?: readonly string[]) => Promise<{ readonly woken: boolean; readonly reason?: string }>
  /** 常驻项是否已装(开机第一次校准前的初值);缺省按平台真实探。 */
  readonly probeInstalled?: () => boolean
  /** N-26 轻暂停:确保常驻任务禁用(win schtasks /change /disable;mac 无需动作)。测试注入用;缺省真实执行。 */
  readonly ensureDisabled?: (platform: string) => Promise<boolean>
  /** 每次校准落定(含装上/没装上/卸下/抛错)后打一发:校准完成前被推迟的开机接续靠这个时机补做(甲-1)。 */
  readonly onCalibrated?: () => void
  /** Phase 1 ④:结构化失败日志。开机校准失败被 runtime 的 .catch(()=>undefined) 吞、叫醒 reason
   *  被 boolean 契约丢掉——都从这里留痕(进 <userData>/logs/tunnel-daemon.log,诊断包收录)。 */
  readonly logFailure?: (event: string, detail?: string) => void
}

const PLATFORM_KEY: Record<Platform, NodeJS.Platform> = { macos: 'darwin', windows: 'win32' }

export function makeResidentRuntime(deps: ResidentRuntimeDeps): ResidentRuntime {
  const platformKey = PLATFORM_KEY[deps.platform]
  const install = deps.install ?? installResident
  const uninstall = deps.uninstall ?? uninstallResident
  const wake = deps.wake ?? wakeResident
  const ensureDisabled = deps.ensureDisabled ?? ensureResidentDisabled
  const probe = deps.probeInstalled ?? (() => deps.platform === 'macos' && existsSync(macAgentPath(RESIDENT_LABEL)))
  // 开机第一次校准跑完之前也要答得出:mac 直接看描述文件在不在;Windows 查任务要起进程,
  // 这条路径上 ⛔ 起进程,先按「没装」答,校准跑完就是准的(那之前主进程走 spawn 老路,连得上)。
  let installed = deps.supported ? probe() : false
  // 甲-10 补刀:最近一次校准落定在「当前用户无法接管的存量任务承载」(existingTaskStale)。
  // armed 照答「在」(先叫醒它承载,⛔ 见 supervisor 的回落出口);supervisor 据此知道:
  // 叫醒周期耗尽而席位仍空 = 存量任务拉不起守护,回落到自己 spawn 而不是置放弃位。
  let staleCarryMode = false
  let unmanagedStaleMode = false
  let staleTaskPaths: readonly string[] = []

  // 身份对账而非只查 pid 活性:守护崩溃后 PID 被无关进程复用时,kill(pid,0) 会把路人
  // 当成在席守护——界面放行陈旧 connected、新守护静默让位,系统自愈被击穿。
  // N-25:桥上的 alive 挂在 isRunning() 下、状态轮询每次都问,席位锁读走记忆化
  // (ino+mtime+size 失效,锁文件被换必翻新);校准决策(leaveRunningInstance)是对盘面的
  // 判定,保持现读——⛔ 两处共用一个读法。
  const aliveCached = (): boolean => lockHolderAlive(readInstanceLockCached(deps.dataDir)?.holder)
  const alive = (): boolean => lockHolderAlive(readInstanceLock(deps.dataDir)?.holder)

  const calibrateOnce = async (enabled: boolean): Promise<ResidentOutcome> => {
    try {
      if (!deps.supported) { installed = false; staleCarryMode = false; unmanagedStaleMode = false; staleTaskPaths = []; return { installed: false, reason: '开发态不装常驻' } }
      // 软硬按席位判活定(身份对账,⛔ 只数 pid):守护在跑 → mac 侧绝不 bootout/bootstrap
      // (那是对在跑实例发 SIGTERM,关开关当场断网);守护已死才允许换装/清闲置任务。
      const leaveRunningInstance = alive()
      if (!enabled) {
        await uninstall(platformKey, { leaveRunningInstance })
        installed = false
        staleCarryMode = false
        unmanagedStaleMode = false
        staleTaskPaths = []
        return { installed: false }
      }
      let outcome: ResidentOutcome
      try {
        outcome = await install(deps.spec(), platformKey, { leaveRunningInstance })
      } catch (error) {
        // Phase 1 ④:校准抛错在 runtime 的 .catch(()=>undefined) 里无声消失(开机链),先留现场再照抛。
        deps.logFailure?.('calibrate-failed', firstLineOf(error))
        throw error
      }
      if (!outcome.installed) {
        deps.logFailure?.('calibrate-not-installed', outcome.reason ?? '原因未给')
      }
      // 装不上就如实记下没装(设置页由识别层如实显示),主进程回落到自己 spawn——⛔ 因为常驻装不上就不给客户连网。
      // 例外(甲-10 返工):当前用户无法接管的存量任务还在(existingTaskStale)时,armed 仍答「在」——
      // 运行时**先**走叫醒由它承载,⛔ 一上来就自起:整分钟任务也会再拉一次,两份并存就是
      // TUNNEL_WRITE_RIGHT_HELD、主程序退出后没人接手(2026-09-17 真机 B/C 时间线)。
      // 补刀(甲-10):存量任务若拉不起守护,叫醒周期耗尽后 supervisor 按 staleCarry() 回落到
      // 自起——网络硬标准:点了连接必须连上,⛔ 放弃式处理(验收档第二节)。
      installed = outcome.installed || outcome.existingTaskStale === true
      staleCarryMode = outcome.existingTaskStale === true
      unmanagedStaleMode = outcome.unmanagedStale === true
      staleTaskPaths = staleCarryMode ? (outcome.staleTaskPaths ?? []) : []
      return outcome
    } finally {
      // 校准落定(含抛错)都要通知:被推迟的开机接续等着这个时机补做,⛔ 让它永远等。
      try { deps.onCalibrated?.() } catch { /* 接续补做失败不挡校准本身 */ }
    }
  }

  // 校准串行闸(N-21):所有校准入口——开机自动校准(desktop/runtime 启动 1 秒)、客户拨开关
  // (applyResidentChoice)、运行时注册补跑(resident-owner 的 pendingChoice)——都汇到这一个
  // calibrate,前一次落定(任何结果)后后一次才开跑。直通无锁时开机校准与拨开关可交错执行
  // Register-ScheduledTask -Force / bootstrap,终态不可预测;前一次抛错也放行后一次
  // (链上吞掉),⛔ 把串行闸变成死锁闸。
  let calibrationChain: Promise<unknown> = Promise.resolve()
  return {
    bridge: {
      armed: () => installed,
      alive: aliveCached,
      wake: async () => {
        const outcome = await wake(platformKey, staleTaskPaths)
        // Phase 1 ④:叫醒被拒的原因(reason)被 boolean 契约丢掉——supervisor 只见「没叫动」。
        if (!outcome.woken) deps.logFailure?.('wake-refused', outcome.reason ?? '原因未给')
        return outcome.woken
      },
      staleCarry: () => staleCarryMode,
      unmanagedStale: () => unmanagedStaleMode,
      // N-26:开发态(supported=false)从未装过常驻,无事可禁,照禁用成功答(幂等无操作)。
      ensureDisabled: async () => (deps.supported ? await ensureDisabled(platformKey) : true)
    },
    calibrate: (enabled: boolean): Promise<ResidentOutcome> => {
      const settle = calibrationChain.then(() => calibrateOnce(enabled))
      calibrationChain = settle.then(() => undefined, () => undefined)
      return settle
    }
  }
}

/** 守护日志落点(窗口 B 的一键上报按这个路径收)。 */
export function residentLogDir(userDataPath: string): string {
  return join(userDataPath, 'logs')
}
