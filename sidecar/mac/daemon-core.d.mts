import type { Connector, LoopbackProbeSpec, SshSocksSpec } from './connectors.d.mts'
import type { SettingsAdapter } from './restore.d.mts'
import type { VlessSpec } from './vless-connector.mjs'

export declare function readIntentChecked(dataDir: string): { intent: DaemonIntent | { desired: 'shutdown' } | undefined; corrupted: boolean }
/** 同一数据目录的恢复权规则(退出流程与崩溃兜底共用):状态文件已由别的 runId 写过 = 别的守护已实际接手。 */
/** 上一轮实际监听的入口端口(候选口占满时会是系统随机分的那个)。 */
export declare function lastBridgePort(dataDir: string): number | undefined
export declare function recoveryOwnedByOther(dataDir: string, runId: string): boolean
export declare function installCrashBailout(options: {
  dataDir: string
  adapterOf: () => ManagedAdapter
  /** 本进程守护的 runId;别的守护已接手时兜底只退出、不碰设置。缺省为空 = 永不判交接。 */
  runId?: string
  exit?: (code: number) => void
  log?: (line: string) => void
}): { dispose(): void }

export declare const RECONNECT_BACKOFF_MS: readonly number[]
export declare const SLOW_RECONNECT_MS: number
export declare const SHUTDOWN_RESTORE_RETRY_MS: readonly number[]
/** 网络抖动闸:事件驱动的立即恢复每这么久只放行一次;窗口内的网络变化交给常规退避。 */
export declare const NETWORK_SETTLE_MS: number
/** 按平台创建电源/网络事件源(mac 与 Windows 都要);platform 与 create 仅供用例注入。 */
export declare function startPowerEvents(options?: {
  readonly platform?: NodeJS.Platform | string
  readonly emit?: (event: string) => void
  readonly log?: (line: string) => void
  readonly create?: (options: { emit?: (event: string) => void; onGiveUp?: (reason: string) => void }) => { stop: () => void }
}): { stop: () => void }

export interface DaemonClock {
  now(): number
  setTimeout(fn: () => void, delayMs: number): number
  setInterval(fn: () => void, intervalMs: number): number
  clearTimer(id: number): void
}

export type ConnectorSpec = LoopbackProbeSpec | SshSocksSpec | VlessSpec

export interface DaemonIntent {
  readonly desired: 'connected' | 'user-disconnected' | 'shutdown'
  readonly authorization?: { readonly id: string; readonly expiresAt: number }
  readonly connector?: ConnectorSpec
  /** 隐藏多节点:这份授权的全部入口(第一项即 `connector`)。全是 vless-reality 时守护把它们一起交给内核探活择路。 */
  readonly connectors?: readonly ConnectorSpec[]
  readonly bridgePort?: number
  /** 入口端口候选(第一个没被占的生效;缺省只用 bridgePort)。 */
  readonly bridgePortCandidates?: readonly number[]
  readonly routes?: RouteTable
  readonly sessionToken?: string
  /** 「客户本来就能到 AI 服务就用它」的开关。⛔ 缺省为真:真实探测会在用例与开发机上真跑。 */
  readonly reuseDirect?: boolean
  readonly updatedAt?: number
}

export interface RouteTable {
  readonly directSuffixes: readonly string[]
  readonly protectedDirectSuffixes: readonly string[]
  readonly tunnelSuffixes?: readonly string[]
  /** CH-1(创始人 2026-09-15):AI 和 GitHub 的专用后缀。指向专用出站,与其余国外的通用出站分开;
   *  同一批入口,不参与任何防漂移设计;签名 overlay 写不了本表(overlay 只有 tunnel/direct 两类)。 */
  readonly dedicatedSuffixes?: readonly string[]
}

export interface DaemonState {
  readonly runId?: string
  readonly intentToken?: string
  readonly state: string
  readonly sessionToken: string
  readonly code: string
  readonly message: string
  readonly exitIp?: string
  readonly lastVerifiedAt?: number
  /** 本次实际监听的入口端口(系统代理指向它)。 */
  readonly bridgePort?: number
  /** 复用了电脑上现有的外网代理(未改系统设置)。 */
  readonly reusedProxy?: ExistingProxyInfo
  /** 可选项说明(终端接入未启用等)。 */
  readonly note?: string
  readonly updatedAt: number
}

export interface TrafficState {
  readonly source: 'local-proxy-entry'
  readonly uploadBytes: number
  readonly downloadBytes: number
  readonly uploadBytesPerSecond: number
  readonly downloadBytesPerSecond: number
  readonly updatedAt: number
}

export interface ManagedItem {
  readonly ref: { readonly service: string; readonly item: string }
  readonly value: unknown
}

/** 客户电脑上现成的那条外网:别人的代理(http/socks)、PAC,或者「本来就能直连」(装了 VPN 走全局、人在墙外、公司专线)。 */
export interface ExistingProxyInfo { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number; url?: string; source?: string }

export interface ManagedAdapter extends SettingsAdapter {
  reapplyOnChange?(ref: { service: string; item: string }): boolean
  /** 电脑上别的代理(不是我们的)当前是否开着;PAC 也报,但守护按不可判定处理。
   *  knownPorts = 守护用过/可能用的入口端口(本轮实际、意图默认、候选表、上一轮 state.json 里的实际口);
   *  「这是不是我们的」按这份记录判,⛔ 靠端口长什么样猜。 */
  existingProxy?(ours: { host: string; port: number; knownPorts?: readonly number[] }): ExistingProxyInfo | undefined
  /** 可选项(终端接入)这次没启用的原因。 */
  optionalNote?(): string
  preflight?(proxy: { host: string; port: number }): void
  managedItems(proxy: { host: string; port: number }): ManagedItem[]
}

export interface LocalBridge {
  verify?(): Promise<{ exitIp: string }>
  /** 回显失败后的第二意见:通用探测点经通道可达即 resolve。 */
  probeReachability?(): Promise<unknown>
  listen(): Promise<void> | void
  close(): Promise<void> | void
  isAlive?(): boolean
  onLost?(callback: (error: Error) => void): void
  /** 被动检测:客户真实请求在通道里连续失败时回调,守护据此立即复验。 */
  onDegraded?(callback: () => void): void
  traffic?(): { uploadBytes: number; downloadBytes: number; observedAt: number }
}

export interface DaemonOptions {
  readonly dataDir: string
  readonly runId?: string
  readonly clock: DaemonClock
  readonly adapter: ManagedAdapter
  readonly connectorFactory: (spec: ConnectorSpec) => Connector
  readonly bridgeFactory: (spec: {
    upstream: { host: string; port: number }
    listenPort: number | undefined
    routes: RouteTable | undefined
    dataDir: string
    outbound?: Record<string, unknown>
    verifyUrl?: string
    verifyFallbackUrl?: string
    verifyTimeoutMs?: number
  }) => LocalBridge
  readonly parentAlive: () => boolean
  readonly onExit: (code: number) => void
  readonly intentPollMs?: number
  readonly parentPollMs?: number
  readonly verifyIntervalMs?: number
  readonly random?: () => number
  readonly log?: (line: string) => void
  /** 探测「现有代理能不能出外网」;缺省 probeExistingProxy,用例注入。 */
  readonly probeProxy?: (existing: ExistingProxyInfo) => Promise<unknown>
  /** 这台电脑不经任何代理能不能到 AI 服务。缺省探 AI_SERVICE_PROBE_URLS；只在意图带 reuseDirect 时才被调用。 */
  readonly probeDirect?: () => Promise<unknown>
  /** 常驻自检:探「我自己的程序还在不在」。由入口注入,守护本身 ⛔ 认识常驻那套东西。 */
  readonly residentIntegrity?: { check(): { missing: boolean } }
  /** 程序被删后的自愈:还原 + 卸常驻。返回 shouldExit=true 才允许退出。 */
  readonly residentSelfHeal?: () => { shouldExit: boolean } | undefined
}

export interface Daemon {
  run(): Promise<void>
  requestShutdown(): void
  notifyEvent(event: string): void
  restoreSettings(options?: { checkHandover?: boolean; keepWriteRight?: boolean }): Record<string, unknown> | undefined
  settingsBusy: boolean
  restoreWithRetryLadder(
    label: string,
    options?: { checkHandover?: boolean; shouldContinue?: () => boolean }
  ): Promise<Record<string, unknown> | undefined>
}

export declare function intentPath(dataDir: string): string
export declare function statePath(dataDir: string): string
export declare function trafficPath(dataDir: string): string
export declare function readIntent(dataDir: string): DaemonIntent | undefined
export declare function writeState(dataDir: string, state: object): void
export declare function writeTraffic(dataDir: string, traffic: TrafficState): void
export declare function createDaemon(options: DaemonOptions): Daemon
