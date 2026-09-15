// 通道动作注册(六个零参数动作 + 退出钩子登记)。
// registerActions 由桥的 action-loader 以 registry 单参调用;deps 参数仅供测试注入。
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, dialog, powerMonitor } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { recordFault } from '../diagnostics/context'
import { FAILURE_REPORT_DEFAULT_ENABLED } from '../desktop/preferences'
import { daemonLaunchFor } from '../tunnel/platform/launch'
import { resolveTunnelDataDir } from '../tunnel/paths'
import { initializeTunnelRuntime } from '../tunnel/runtime-owner'
import { makeResidentRuntime, residentLogDir, residentSpecFor } from '../tunnel/resident-bridge'
import { RESIDENT_TASK } from '../tunnel/platform/resident'
import { setResidentRuntime } from '../tunnel/resident-owner'
import { platformForRuntime, resolveSidecarDir } from '../tunnel/sidecar-path'
import { loadTrustContext } from '../tunnel/trust'
import { TunnelService } from '../tunnel/tunnel-service'
import type { SpawnedDaemon } from '../tunnel/supervisor'
import type { Platform } from '../precheck/software-platform'

export interface TunnelActionDeps {
  readonly service?: TunnelService
  readonly platform?: Platform
  readonly picker?: () => Promise<string | undefined>
  readonly dataDir?: string
  readonly sidecarDir?: string
  readonly spawnDaemon?: (dataDir: string, runId?: string) => SpawnedDaemon
  readonly spawnRestore?: (dataDir: string) => SpawnedDaemon | void
}

const actionResultSchema = schema.object({
  outcome: schema.string({ maxLength: 20 }),
  code: schema.string({ maxLength: 60 }),
  message: schema.string({ maxLength: 300 })
})

const importResultSchema = schema.object({
  outcome: schema.string({ maxLength: 20 }),
  code: schema.string({ maxLength: 60 }),
  message: schema.string({ maxLength: 300 }),
  authorizationId: schema.string({ maxLength: 100 }),
  nodeLabel: schema.string({ maxLength: 300 }),
  expiresAt: schema.string({ maxLength: 60 }),
  source: schema.string({ maxLength: 80 }),
  pendingAvailable: schema.boolean()
})

export const statusResultSchema = schema.object({
  state: schema.string({ maxLength: 30 }),
  message: schema.string({ maxLength: 300 }),
  source: schema.string({ maxLength: 80 }),
  authorization: schema.string({ maxLength: 80 }),
  backend: schema.string({ maxLength: 40 }),
  nodeLabel: schema.string({ maxLength: 300 }),
  exitIp: schema.string({ maxLength: 60 }),
  pathSource: schema.string({ maxLength: 10 }),
  lastVerifiedAt: schema.string({ maxLength: 40 }),
  configVersion: schema.string({ maxLength: 20 }),
  expiresAt: schema.string({ maxLength: 60 }),
  pendingAvailable: schema.boolean(),
  currentConfig: schema.string(),
  pendingConfig: schema.string(),
  canApplyPending: schema.boolean(),
  unrestored: schema.string({ maxLength: 600 }),
  componentMissing: schema.string({ maxLength: 400 }),
  sshBinary: schema.string({ maxLength: 8 }),
  traffic: schema.string({ maxLength: 160 })
})

const routeExplainParamsSchema = schema.object({
  host: schema.string({ maxLength: 253 })
})

const routeExplainResultSchema = schema.object({
  outcome: schema.string({ maxLength: 20 }),
  reasonCode: schema.string({ maxLength: 80 }),
  title: schema.string({ maxLength: 80 }),
  detail: schema.string({ maxLength: 240 }),
  // 具体命中的那一条规则(后缀或 geoip:private 之类);判不出时为空串(D4)
  matchedRule: schema.string({ maxLength: 253 })
})

export function registerActions(registry: BridgeRegistry, deps: TunnelActionDeps = {}): void {
  const service =
    deps.service ??
    initializeTunnelRuntime(() => new TunnelService(productionDeps(deps)))
  registry.registerAction({
    name: 'tunnel.importConfig',
    paramsSchema: schema.undefined(),
    resultSchema: importResultSchema,
    handler: () => service.importConfig()
  })
  registry.registerAction({
    name: 'tunnel.syncAccountConfig',
    paramsSchema: schema.undefined(),
    resultSchema: actionResultSchema,
    handler: () => service.syncAccountConfig()
  })
  registry.registerAction({
    name: 'tunnel.applyPending',
    paramsSchema: schema.undefined(),
    resultSchema: actionResultSchema,
    handler: () => service.applyPending()
  })
  registry.registerAction({
    name: 'tunnel.start',
    paramsSchema: schema.undefined(),
    resultSchema: actionResultSchema,
    handler: () => service.start()
  })
  registry.registerAction({
    name: 'tunnel.stop',
    paramsSchema: schema.undefined(),
    resultSchema: actionResultSchema,
    handler: () => service.stop()
  })
  registry.registerAction({ name: 'tunnel.repair', paramsSchema: schema.undefined(), resultSchema: actionResultSchema,
    handler: () => service.repair() })
  registry.registerAction({ name: 'tunnel.repairStatus', paramsSchema: schema.undefined(), resultSchema: schema.object({
    running: schema.boolean(), phase: schema.string({ maxLength: 20 }), outcome: schema.string({ maxLength: 20 }),
    code: schema.string({ maxLength: 60 }), message: schema.string({ maxLength: 300 }),
    startedAt: schema.string({ maxLength: 40 }), finishedAt: schema.string({ maxLength: 40 })
  }), handler: () => service.repairStatus() })
  registry.registerAction({
    name: 'tunnel.status',
    paramsSchema: schema.undefined(),
    resultSchema: statusResultSchema,
    handler: () => service.status()
  })
  registry.registerAction({
    name: 'tunnel.explainRoute',
    paramsSchema: routeExplainParamsSchema,
    resultSchema: routeExplainResultSchema,
    handler: (params) => service.explainRoute((params as { host: string }).host)
  })
  // 明确退出时停止:退出恢复意图经受限桥退出钩子登记(⛔ 改 main/index)
  registry.registerShutdownHook('tunnel', () => service.requestShutdown())
}

function productionDeps(deps: TunnelActionDeps) {
  const platform = deps.platform ?? platformForRuntime(process.platform)
  const dataDir = deps.dataDir ?? resolveTunnelDataDir(process.env, app.getPath('userData'))
  const repoRoot = join(__dirname, '..', '..')
  const sidecarDir =
    deps.sidecarDir ??
    resolveSidecarDir({
      platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot
    })
  const launch = daemonLaunchFor(platform, sidecarDir)
  // 常驻运行时:装/卸/叫醒/探席位。⛔ 在这里按开关装——客户的选择存在桌面片的偏好里,
  // 由它调 calibrateResident;这边只负责把「怎么装」这件事装配好。
  const resident = makeResidentRuntime({
    dataDir,
    platform,
    supported: app.isPackaged,
    spec: () => residentSpecFor({
      executable: process.execPath,
      launch,
      dataDir,
      logDir: residentLogDir(app.getPath('userData')),
      // Windows:守护干净收尾后据这条路径自禁任务(防每分钟重入空转);mac 无此物。
      ...(platform === 'windows' ? { taskPath: RESIDENT_TASK } : {})
    })
  })
  setResidentRuntime(resident)
  return {
    dataDir,
    platform,
    sidecarDir,
    resident: resident.bridge,
    // FB-1:失败终态回传(设置页可关,默认开)。开关读的是桌面片偏好文件——⛔ 不再 new 一个
    // DesktopStore:那会跟 desktop.runtime 的实例各持一份内存态互相漂移;惰性读,失败终态本身低频。
    diagnosis: {
      enabled: () => {
        try {
          const path = join(app.getPath('userData'), 'desktop.json')
          if (!existsSync(path)) return FAILURE_REPORT_DEFAULT_ENABLED
          const saved = JSON.parse(readFileSync(path, 'utf8')) as { failureReport?: unknown }
          return typeof saved.failureReport === 'boolean' ? saved.failureReport : FAILURE_REPORT_DEFAULT_ENABLED
        } catch { return FAILURE_REPORT_DEFAULT_ENABLED }
      },
      version: () => app.getVersion()
    },
    picker:
      deps.picker ??
      (async () => {
        const result = await dialog.showOpenDialog({
          title: '选择通道配置包',
          filters: [{ name: '来信通道配置包', extensions: ['lxtpack'] }],
          properties: ['openFile']
        })
        return result.canceled ? undefined : result.filePaths[0]
      }),
    trust: loadTrustContext(process.env, {
      allowTestKeys: !app.isPackaged && process.env.TOOLBOX_ENABLE_TEST_TRUST === '1'
    }),
    now: () => Date.now(),
    // D3:通道中断打断了正在回数据的连接时留一条经过,客服看得到「那次是回答到一半断的」。
    recordFault,
    spawnDaemon:
      deps.spawnDaemon ??
      ((dir: string, runId?: string) => {
        // 独立于主进程 Job 存活，仅为完成关闭恢复；IPC 断开即停止，不能常驻后台。
        const child = spawn(process.execPath, [launch.daemonPath, 'start', '--data-dir', dir, '--adapter', launch.adapterPath,
          '--parent-ipc', '1', '--run-id', runId ?? ''], {
          env: { ...process.env, ...launch.env }, detached: true, windowsHide: true,
          stdio: ['ignore', 'ignore', 'inherit', 'ipc']
        })
        const resume = () => { if (child.connected) child.send({ type: 'network-event', event: 'wake' }, () => {}) }
        powerMonitor.on('resume', resume)
        const cleanup = () => powerMonitor.removeListener('resume', resume)
        child.once('exit', cleanup)
        child.once('error', cleanup)
        return child
      }),
    spawnRestore:
      deps.spawnRestore ??
      ((dir: string) => spawn(process.execPath, [launch.daemonPath, 'restore', '--data-dir', dir, '--adapter', launch.adapterPath], {
        env: { ...process.env, ...launch.env }, detached: true, windowsHide: true,
        stdio: ['ignore', 'ignore', 'inherit']
      })),
    routesFile: join(sidecarDir, 'routes.default.json')
  }
}
