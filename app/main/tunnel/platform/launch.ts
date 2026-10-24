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

const DAEMON_LAUNCHERS = {
  macos: macDaemonLaunch,
  windows: windowsDaemonLaunch
} satisfies Record<Platform, (sidecarDir: string) => DaemonLaunch>

export function daemonLaunchFor(platform: Platform, sidecarDir: string): DaemonLaunch {
  return DAEMON_LAUNCHERS[platform](sidecarDir)
}
