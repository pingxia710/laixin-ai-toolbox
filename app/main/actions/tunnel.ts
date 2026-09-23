// 通道动作注册(六个零参数动作 + 退出钩子登记)。
// registerActions 由桥的 action-loader 以 registry 单参调用;deps 参数仅供测试注入。
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, dialog, powerMonitor } from 'electron'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { actionLocalFault } from '../bridge/local-fault'
import { schema } from '../bridge/schema'
import { recordFault } from '../diagnostics/context'
import { FAILURE_REPORT_DEFAULT_ENABLED } from '../desktop/preferences'
import { daemonLaunchFor } from '../tunnel/platform/launch'
import { resolveTunnelDataDir } from '../tunnel/paths'
import { createCalibrationGate } from '../tunnel/calibration-gate'
import { initializeTunnelRuntime } from '../tunnel/runtime-owner'
import { makeResidentRuntime, residentLogDir, residentSpecFor } from '../tunnel/resident-bridge'
import { RESIDENT_TASK } from '../tunnel/platform/resident'
import { setResidentRuntime } from '../tunnel/resident-owner'
import { platformForRuntime, resolveSidecarDir } from '../tunnel/sidecar-path'
import { loadTrustContext } from '../tunnel/trust'
import { createFailureLog, daemonLogPath } from '../tunnel/failure-log'
import { TunnelService, accountFailure, isLocalWriteFault, type ActionResult } from '../tunnel/tunnel-service'
import { NetworkAccountError } from '../tunnel/account-client'
import { PackageReject } from '../tunnel/package-format'
import type { SpawnedDaemon } from '../tunnel/supervisor'
import type { Platform } from '../precheck/software-platform'

/** 动作异常就地翻译成受控失败(⛔ 落到桥层「重新导入配置包」的通用兜底——那个兜底只留给
 *  真正不可归因的情况)。受控账号/包异常按原码原话透传;stop 的本机异常按 N-18 判据分
 *  「写入失败 / 未预期」两档,但都必须交代「通道可能仍在连接」——断开意图没写成,通道就没停。 */
function translateActionError(action: 'start' | 'stop', error: unknown): ActionResult {
  if (error instanceof NetworkAccountError) return accountFailure(error.message)
  if (error instanceof PackageReject) return { outcome: 'rejected', code: error.code, message: error.message }
  // 甲-6 报告 §五尾巴:走到这里的本机异常会翻成受控码,文案/FB-1 都在,缺的是本机故障记录里
  // 的一笔——翻译的同时留证,归类与桥层兜底同源(actionLocalFault),⛔ 两处口径漂移、⛔ 原始消息。
  const fault = actionLocalFault('ACTION_FAILED', `tunnel.${action}`, error)
  if (fault !== undefined) recordFault(fault)
  if (action === 'stop') {
    const write = isLocalWriteFault(error)
    return write
      ? { outcome: 'rejected', code: 'TUNNEL_LOCAL_WRITE_FAILED',
          message: '断开未完成：本机写入失败，通道可能仍在连接。请清理磁盘空间或检查数据目录后重试' }
      : { outcome: 'rejected', code: 'TUNNEL_LOCAL_UNEXPECTED',
          message: '断开没能完成，工具箱遇到一个未预期的问题；通道可能仍在连接。请退出工具箱后重开，仍不行请复制诊断给客服' }
  }
  return accountFailure('TUNNEL_LOCAL_UNEXPECTED')
}

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
  // 源头(configSummary)截断到 300;schema 上限是第二道闸——历史事故:组件清单变长把整个 status 顶成 ACTION_RESULT_INVALID。
  currentConfig: schema.string({ maxLength: 300 }),
  pendingConfig: schema.string({ maxLength: 300 }),
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
    handler: () => service.start().catch((error: unknown) => translateActionError('start', error))
  })
  registry.registerAction({
    name: 'tunnel.stop',
    paramsSchema: schema.undefined(),
    resultSchema: actionResultSchema,
    handler: () => service.stop().catch((error: unknown) => translateActionError('stop', error))
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
  // Phase 1 ④:失败留痕与守护/恢复子进程 stderr 同落 <userData>/logs/tunnel-daemon.log——
  // 它已是常驻日志(mac launchd StandardErrorPath / win schtasks 重定向),诊断包既有通道收录。
  const supervisorLog = createFailureLog(daemonLogPath(app.getPath('userData')))
  // 常驻运行时:装/卸/叫醒/探席位。⛔ 在这里按开关装——客户的选择存在桌面片的偏好里,
  // 由它调 calibrateResident;这边只负责把「怎么装」这件事装配好。
  // 甲-1:校准落定前被推迟的开机接续排在闸门里,落定(含装上/没装上/卸下/抛错)后统一补做。
  // 等待期手动点连接也并进同一个闸门(tunnel-service 经 afterResidentCalibration 登记)。
  const calibrationGate = createCalibrationGate()
  const resident = makeResidentRuntime({
    dataDir,
    platform,
    supported: app.isPackaged,
    onCalibrated: () => calibrationGate.markCalibrated(),
    logFailure: supervisorLog,
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
    // 开发态校准从不发生(desktop 片直接 return):给了通知反而让开机接续永远等,⛔ 给。
    ...(app.isPackaged
      ? { afterResidentCalibration: (fn: () => void) => calibrationGate.afterCalibration(fn) }
      : {}),
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
    // Phase 1 ④:UNKNOWN 归因——监管器的意外退出/叫醒耗尽/恢复失败第一现场进常驻日志。
    logFailure: supervisorLog,
    spawnDaemon:
      deps.spawnDaemon ??
      ((dir: string, runId?: string) => {
        // 独立于主进程 Job 存活，仅为完成关闭恢复；IPC 断开即停止，不能常驻后台。
        const child = spawn(process.execPath, [launch.daemonPath, 'start', '--data-dir', dir, '--adapter', launch.adapterPath,
          '--parent-ipc', '1', '--run-id', runId ?? ''], {
          env: { ...process.env, ...launch.env }, detached: true, windowsHide: true,
          // Phase 1 ④:spawn 路径守护的 stderr 基线走 inherit(打包后无处可去)——接流进常驻日志。
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        child.stderr?.on('data', (chunk) => supervisorLog('daemon-stderr', String(chunk).trim()))
        const resume = () => { if (child.connected) child.send({ type: 'network-event', event: 'wake' }, () => {}) }
        powerMonitor.on('resume', resume)
        const cleanup = () => powerMonitor.removeListener('resume', resume)
        child.once('exit', cleanup)
        child.once('error', cleanup)
        return child
      }),
    spawnRestore:
      deps.spawnRestore ??
      ((dir: string) => {
        const child = spawn(process.execPath, [launch.daemonPath, 'restore', '--data-dir', dir, '--adapter', launch.adapterPath], {
          env: { ...process.env, ...launch.env }, detached: true, windowsHide: true,
          // Phase 1 ④:恢复子进程的梯子进度/写权原因都在 stderr,基线 inherit 打包后丢失——接流留痕。
          stdio: ['ignore', 'ignore', 'pipe']
        })
        child.stderr?.on('data', (chunk) => supervisorLog('restore-stderr', String(chunk).trim()))
        return child
      }),
    routesFile: join(sidecarDir, 'routes.default.json')
  }
}
