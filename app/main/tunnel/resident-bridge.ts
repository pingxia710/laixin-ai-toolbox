// 常驻接线(主进程侧,0.5.0):把「守护由系统承载」这件事翻译成守护监管能问的三个问题。
//
// 两条硬边界(与 platform/resident.ts 文件头的三条一脉):
//  · **装不上 ⛔ 不给客户连网**。校准失败就回落到主进程自己 spawn 的老路,最坏不比上一版差。
//  · **armed() 必须同步且便宜**。它挂在 isRunning() 下,状态轮询每次都问;Windows 查计划任务要起
//    一个 schtasks 进程,⛔ 放进这条路径——内存态由校准与拨开关维护,那两处才去碰系统。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { processAlive } from '../../../sidecar/mac/ledger.mjs'
import { readInstanceLock } from '../../../sidecar/shared/instance-lock.mjs'
import type { Platform } from '../precheck/software-platform'
import type { ResidentBridge } from './supervisor'
import type { DaemonLaunch } from './platform/launch'
import {
  RESIDENT_LABEL, installResident, macAgentPath, uninstallResident, wakeResident, type ResidentOutcome, type ResidentSpec
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
  readonly install?: (spec: ResidentSpec, platform: string) => Promise<ResidentOutcome>
  readonly uninstall?: (platform: string) => Promise<void>
  readonly wake?: (platform: string) => Promise<{ readonly woken: boolean }>
  /** 常驻项是否已装(开机第一次校准前的初值);缺省按平台真实探。 */
  readonly probeInstalled?: () => boolean
}

const PLATFORM_KEY: Record<Platform, NodeJS.Platform> = { macos: 'darwin', windows: 'win32' }

export function makeResidentRuntime(deps: ResidentRuntimeDeps): ResidentRuntime {
  const platformKey = PLATFORM_KEY[deps.platform]
  const install = deps.install ?? installResident
  const uninstall = deps.uninstall ?? uninstallResident
  const wake = deps.wake ?? wakeResident
  const probe = deps.probeInstalled ?? (() => deps.platform === 'macos' && existsSync(macAgentPath(RESIDENT_LABEL)))
  // 开机第一次校准跑完之前也要答得出:mac 直接看描述文件在不在;Windows 查任务要起进程,
  // 这条路径上 ⛔ 起进程,先按「没装」答,校准跑完就是准的(那之前主进程走 spawn 老路,连得上)。
  let installed = deps.supported ? probe() : false

  return {
    bridge: {
      armed: () => installed,
      alive: () => processAlive(readInstanceLock(deps.dataDir)?.holder?.pid),
      wake: async () => (await wake(platformKey)).woken
    },
    calibrate: async (enabled: boolean): Promise<ResidentOutcome> => {
      if (!deps.supported) { installed = false; return { installed: false, reason: '开发态不装常驻' } }
      if (!enabled) {
        await uninstall(platformKey)
        installed = false
        return { installed: false }
      }
      const outcome = await install(deps.spec(), platformKey)
      // 装不上就如实记下没装:主进程回落到自己 spawn,⛔ 因为常驻装不上就不给客户连网。
      installed = outcome.installed
      return outcome
    }
  }
}

/** 守护日志落点(窗口 B 的一键上报按这个路径收)。 */
export function residentLogDir(userDataPath: string): string {
  return join(userDataPath, 'logs')
}
