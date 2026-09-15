import type { RouteTable } from './daemon-core.d.mts'

export interface LocalBridgeOptions {
  readonly listenPort: number | undefined
  readonly routes: RouteTable | undefined
  readonly upstream: { readonly host: string; readonly port: number } | undefined
  readonly dataDir: string
  readonly executablePath?: string
  readonly outbound?: Record<string, unknown>
  /** 隐藏多节点:这份授权的全部入口出站。给了两个以上时,内核装探活 + 均衡器自己择路;⛔ 与 outbound 同时给。 */
  readonly outbounds?: readonly Record<string, unknown>[]
  readonly verifyUrl?: string
  readonly verifyFallbackUrl?: string
  readonly verifyTimeoutMs?: number
  /** 回显失败后的通用探测点(缺省 TUNNEL_PROBE_URLS;用例注入本地地址)。 */
  readonly probeUrls?: readonly string[]
  /** 多入口探活间隔(秒);缺省 ENTRY_PROBE_INTERVAL_SECONDS。核验脚本压短它以观察内核择路。 */
  readonly probeIntervalSeconds?: number
  /** 在途流的空闲窗口:回答静下来这么久就不再算「正在回答」(缺省 15 秒;用例压短它)。 */
  readonly idleStreamMs?: number
  // 注入点(仅测试):spawnImpl 换假 runner/taskkill 执行,platform 模拟 win32/darwin。
  readonly spawnImpl?: ((executable: string, args: readonly string[], options?: Record<string, unknown>) => unknown)
  readonly platform?: NodeJS.Platform | string
}
export interface LocalBridgeHandle {
  verify?: (() => Promise<{ exitIp: string }>) | undefined
  probeReachability?: (() => Promise<{ url: string }>) | undefined
  /** activeStreams:此刻正在往回吐回答的连接数(D3 在途流)。起算点是**正文**第一个字节
   *  (⛔ SOCKS 握手应答),连接结束或静默超过空闲窗口即销账;只计数 ⛔ 记内容。 */
  traffic(): { uploadBytes: number; downloadBytes: number; activeStreams: number; observedAt: number }
  listen(): Promise<void>
  port(): number
  close(): Promise<void>
  isAlive(): boolean
  onLost(callback: (error: Error) => void): void
  /** 被动检测:客户真实请求在通道里连续失败时回调。 */
  onDegraded(callback: () => void): void
}

export type RelayVerdict = 'failed' | 'ok' | 'none'
export interface FailureDetector { report(verdict: RelayVerdict): boolean; pendingFailures(): number }
export declare const PASSIVE_FAILURE_THRESHOLD: number
export declare const PASSIVE_FAILURE_WINDOW_MS: number
export declare function createFailureDetector(options?: { onDegraded?: () => void; threshold?: number; windowMs?: number; now?: () => number }): FailureDetector
export declare function upstreamPayloadReader(): { noteRequest(chunk: Buffer): void; consume(chunk: Buffer): boolean; verdict(): RelayVerdict }

export declare function createLocalBridge(options: LocalBridgeOptions): LocalBridgeHandle
export declare function xrayExecutable(): string
/** 本机网络名直连后缀:mDNS .local、home.arpa、localdomain、localhost。 */
export declare const LOCAL_NETWORK_DIRECT_SUFFIXES: readonly string[]
/** 通道出站的 tag:单入口沿用历史名;多入口是 `${TUNNEL_BALANCER_TAG}-0..N`,规则改指均衡器。 */
export declare const TUNNEL_OUTBOUND_TAG: string
export declare const TUNNEL_BALANCER_TAG: string
/** CH-1 专用出站的 tag:单入口用出站 tag 'dedicated';多入口是 'dedicated-0..N' + 均衡器 'dedicated'。 */
export declare const DEDICATED_OUTBOUND_TAG: string
export declare const DEDICATED_BALANCER_TAG: string
/** 多入口的探活间隔(秒)。 */
export declare const ENTRY_PROBE_INTERVAL_SECONDS: number
export declare function buildXrayConfig(options: Pick<LocalBridgeOptions, 'listenPort' | 'upstream' | 'routes' | 'outbound' | 'outbounds' | 'verifyUrl' | 'verifyFallbackUrl' | 'probeUrls' | 'probeIntervalSeconds'>): {
  log: object
  inbounds: object[]
  outbounds: { tag: string }[]
  observatory?: { subjectSelector: string[]; probeUrl: string; probeInterval: string; enableConcurrency: boolean }
  routing: {
    domainStrategy: string
    balancers?: Array<{ tag: string; selector: string[]; strategy: { type: string } }>
    rules: Array<{ type: string; domain?: string[]; ip?: string[]; outboundTag?: string; balancerTag?: string }>
  }
}
