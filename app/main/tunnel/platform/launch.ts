// 平台启动参数选择器(纯函数,无 Electron 依赖,测试直测):
// 按运行平台把 sidecar 目录拼成对应守护入口 + 适配器 + 环境钥匙。
import type { Platform } from '../../precheck/software-platform'
import { macDaemonLaunch } from './mac'
import { windowsDaemonLaunch } from './win'

export interface DaemonLaunch {
  readonly daemonPath: string
  readonly adapterPath: string
  readonly env: Record<string, string>
}

/** 主进程回落 spawn 的守护启动参数；与常驻参数分开，避免把 parent IPC 语义带进常驻任务。 */
export function daemonStartArgs(launch: DaemonLaunch, dataDir: string, runId: string | undefined, clientVersion: string): string[] {
  return [launch.daemonPath, 'start', '--data-dir', dataDir, '--adapter', launch.adapterPath,
    '--parent-ipc', '1', '--client-version', clientVersion, '--run-id', runId ?? '']
}

const DAEMON_LAUNCHERS = {
  macos: macDaemonLaunch,
  windows: windowsDaemonLaunch
} satisfies Record<Platform, (sidecarDir: string) => DaemonLaunch>

export function daemonLaunchFor(platform: Platform, sidecarDir: string): DaemonLaunch {
  return DAEMON_LAUNCHERS[platform](sidecarDir)
}
