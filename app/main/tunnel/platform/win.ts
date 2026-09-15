import { join } from 'node:path'

// Windows 平台原语(平台相关原语之 Windows 侧;形态照抄 platform/mac.ts):
// 实现本体在 sidecar/win/adapter-wininet.mjs(随包 plain JS,ELECTRON_RUN_AS_NODE 运行);
// 本模块是主进程侧唯一拼装 Windows 真实启动参数的位置,也是
// TOOLBOX_REAL_NETWORK_ADAPTER=1 放行钥匙的唯一来源。平台无关代码 ⛔ 含平台调用。
export interface WindowsDaemonLaunch {
  readonly daemonPath: string
  readonly adapterPath: string
  readonly env: Record<string, string>
}

export function windowsDaemonLaunch(sidecarDir: string): WindowsDaemonLaunch {
  return {
    daemonPath: join(sidecarDir, 'tunnel-daemon.mjs'),
    adapterPath: join(sidecarDir, 'managed-adapter.mjs'),
    env: {
      // 真实注册表写入的放行钥匙(WinINET 适配器加载闸只认它)
      TOOLBOX_REAL_NETWORK_ADAPTER: '1',
      // 终端 hook 与系统代理走同一连接/恢复账本；测试默认不触客户目录。
      TOOLBOX_REAL_TERMINAL_ENVIRONMENT: '1',
      ELECTRON_RUN_AS_NODE: '1'
    }
  }
}

// 平台能力标志(定稿 1):⛔ 借统一语义掩盖平台差异;不支持的写法明确给出受控码。
// 写死:按用户的 WinINET,⛔ WinHTTP ⛔ 服务安装 ⛔ 计划任务(普通用户可完成全部原语)。
export const WINDOWS_PLATFORM_CAPABILITIES = {
  winInetUserProxy: 'supported',
  winHttpMachineProxy: 'unsupported',
  serviceInstall: 'unsupported',
  scheduledTask: 'unsupported'
} as const

export function unsupportedWindowsCapability(
  name: 'winHttpMachineProxy' | 'serviceInstall' | 'scheduledTask'
): {
  readonly code: 'PLATFORM_CAPABILITY_UNSUPPORTED'
  readonly capability: string
} {
  return { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', capability: name }
}
