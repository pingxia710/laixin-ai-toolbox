export declare const CONTROL_CODES: {
  readonly portBusy: '端口占用'
  readonly hostKeyMismatch: '节点身份不符'
  readonly authFailed: '授权失效'
  readonly quotaOrAuth: '配额或授权问题'
  readonly upstreamUnreachable: '上游不可达'
  readonly probeUnavailable: 'TUNNEL_PROBE_UNAVAILABLE'
  readonly proxyConflict: '已有代理控制'
  readonly managedPolicy: '受管理环境'
  readonly componentMissing: '组件缺失'
}

export type ControlCode = (typeof CONTROL_CODES)[keyof typeof CONTROL_CODES]

export declare class ConnectorError extends Error {
  readonly code: ControlCode
  constructor(code: ControlCode, detail?: string)
}

export interface VerifyResult {
  readonly exitIp: string
}

export interface Connector {
  readonly kind: string
  xrayOutbound?(): Record<string, unknown>
  localProxyPort(): number
  onLost(callback: (error: ConnectorError) => void): void
  start(): Promise<void> | void
  verify(): Promise<VerifyResult>
  stop(): Promise<void> | void
}

export interface LoopbackProbeSpec {
  readonly kind: 'loopback-probe'
  readonly host: string
  readonly port: number
  readonly exitIp: string
  readonly timeoutMs?: number
}

export interface SshSocksSpec {
  readonly kind: 'ssh-socks'
  readonly node: { readonly host: string; readonly port: number; readonly sshUser: string }
  readonly keyPath: string
  readonly knownHostsPath: string
  readonly localPort: number
  readonly verifyUrl: string
  readonly verifyFallbackUrl?: string
  readonly readyTimeoutMs?: number
  readonly timeoutMs?: number
}

export declare function createLoopbackProbeConnector(spec: LoopbackProbeSpec): Connector
export declare function createSshSocksConnector(
  spec: SshSocksSpec,
  injected?: { spawn?: unknown }
): Connector
