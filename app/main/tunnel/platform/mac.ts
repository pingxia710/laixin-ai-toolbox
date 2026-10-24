import { join } from 'node:path'

// 平台相关原语(平台无关契约六项之「启动项 / 平台写法」归属):
// macOS 网络服务写法的实现本体在 sidecar/mac/adapter-networksetup.mjs(随包 plain JS,
// ELECTRON_RUN_AS_NODE 运行);本模块是主进程侧唯一拼装真实启动参数的位置,
// 也是 TOOLBOX_REAL_NETWORK_ADAPTER=1 放行钥匙的唯一来源。平台无关代码 ⛔ 含平台调用。
export interface MacDaemonLaunch {
  readonly daemonPath: string
  readonly adapterPath: string
  readonly env: Record<string, string>
}

export function macDaemonLaunch(sidecarDir: string): MacDaemonLaunch {
  return {
    daemonPath: join(sidecarDir, 'tunnel-daemon.mjs'),
    adapterPath: join(sidecarDir, 'managed-adapter.mjs'),
    env: {
      // 真实系统设置写入的放行钥匙(判据 7 的闸只认它)
      TOOLBOX_REAL_NETWORK_ADAPTER: '1',
      // 终端 hook 与系统代理走同一连接/恢复账本；测试默认不触客户目录。
      TOOLBOX_REAL_TERMINAL_ENVIRONMENT: '1',
      ELECTRON_RUN_AS_NODE: '1'
    }
  }
}

// 首版启动项策略(冻结契约六项之一):⛔ 注册任何开机启动项 / 登录项。
export const LOGIN_ITEM_POLICY = 'none' as const
