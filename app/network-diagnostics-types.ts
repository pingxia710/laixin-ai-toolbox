export type DiagnosticSoftware = 'codex' | 'claude' | 'hermes'
export type DiagnosticState = 'passed' | 'attention' | 'unknown' | 'not-checked'
export const diagnosticProbePhases = ['dns', 'proxy', 'connection', 'tls', 'http'] as const
export type DiagnosticProbePhase = typeof diagnosticProbePhases[number]
export const diagnosticProbeRoutes = ['direct', 'tunnel', 'existing-proxy', 'laixin-tunnel'] as const
export type DiagnosticProbeRoute = typeof diagnosticProbeRoutes[number]
export const diagnosticPathKinds = ['direct', 'existing-proxy', 'laixin-tunnel'] as const
export type DiagnosticPathKind = typeof diagnosticPathKinds[number]
export const diagnosticPathStates = ['reachable', 'failed', 'unavailable'] as const
export type DiagnosticPathState = typeof diagnosticPathStates[number]
export const networkDiagnosticReportTtlMs = 10 * 60_000
export const supportDiagnosticAttemptLimit = 20
export interface DiagnosticCheck {
  readonly id: 'internet' | 'tunnel' | 'service' | 'account' | 'application'
  readonly label: string
  readonly state: DiagnosticState
  readonly code: DiagnosticCheckCode
  readonly message: string
  /** 仅表示这次固定目标探测已确认到或失败在的网络阶段，不包含地址、证书或异常正文。 */
  readonly phase?: DiagnosticProbePhase
  // 仅记录本次固定探测的总耗时；没有请求内容、地址或流量数据。
  readonly elapsedMs?: number
}
/** 检查结果码的唯一清单：主进程产出与界面校验共用一份，新增一类不会被界面判成非法报告。 */
export const diagnosticCheckCodes = [
  'AI_DIAG_INTERNET_OK', 'AI_DIAG_INTERNET_UNEXPECTED', 'AI_DIAG_INTERNET_UNAVAILABLE', 'AI_DIAG_INTERNET_TIMEOUT',
  'AI_DIAG_INTERNET_DNS_FAILED', 'AI_DIAG_INTERNET_CONNECTION_FAILED', 'AI_DIAG_INTERNET_TLS_FAILED', 'AI_DIAG_INTERNET_HTTP_FAILED',
  'AI_DIAG_DIRECT_SERVICE', 'AI_DIAG_ISOLATED_SERVICE', 'AI_DIAG_TUNNEL_VERIFIED', 'AI_DIAG_TUNNEL_REQUIRED', 'AI_DIAG_TUNNEL_UNKNOWN', 'AI_DIAG_TUNNEL_CHANGED',
  'AI_DIAG_SERVICE_AUTH', 'AI_DIAG_SERVICE_RESTRICTED', 'AI_DIAG_SERVICE_LIMITED', 'AI_DIAG_SERVICE_ERROR',
  'AI_DIAG_SERVICE_REACHABLE', 'AI_DIAG_SERVICE_UNEXPECTED', 'AI_DIAG_SERVICE_TIMEOUT', 'AI_DIAG_SERVICE_UNAVAILABLE',
  'AI_DIAG_CONTEXT_CHANGED', 'AI_DIAG_PATH_CONTEXT_UNKNOWN', 'AI_DIAG_PRIMARY_PATH_UNAVAILABLE',
  'AI_DIAG_SERVICE_DNS_FAILED', 'AI_DIAG_SERVICE_PROXY_FAILED', 'AI_DIAG_SERVICE_CONNECTION_FAILED', 'AI_DIAG_SERVICE_TLS_FAILED', 'AI_DIAG_SERVICE_HTTP_FAILED',
  'AI_DIAG_ACCOUNT_MANUAL', 'AI_DIAG_ACCOUNT_PROVIDER', 'AI_DIAG_ACCOUNT_UNKNOWN',
  'AI_DIAG_APPLICATION_UNCONFIRMED', 'AI_DIAG_APPLICATION_STALE', 'AI_DIAG_APPLICATION_OBSERVED',
  'AI_DIAG_APPLICATION_CONFIGURATION_MISSING', 'AI_DIAG_APPLICATION_CONFIGURATION_MODIFIED',
  'AI_DIAG_APPLICATION_CONFIGURATION_UNKNOWN', 'AI_DIAG_APPLICATION_FAILED', 'AI_DIAG_LOCAL_SERVICE_DOWN'
] as const
export type DiagnosticCheckCode = typeof diagnosticCheckCodes[number]

export const diagnosticConclusionStatuses = ['blocked', 'limited', 'unknown', 'clear'] as const
export type DiagnosticConclusionStatus = typeof diagnosticConclusionStatuses[number]
export const diagnosticConclusionScopes = ['local-service', 'tunnel', 'target-service', 'target-path', 'application', 'diagnostic-context', 'none'] as const
export type DiagnosticConclusionScope = typeof diagnosticConclusionScopes[number]
export const diagnosticConclusionRuleIds = [
  'DG01_LOCAL_SERVICE_DOWN', 'DG01_TUNNEL_REQUIRED', 'DG01_TARGET_RESPONSE_BOUNDARY', 'DG01_TARGET_PATH_UNCONFIRMED',
  'DG01_APPLICATION_UNCONFIRMED', 'DG01_APPLICATION_CONFIGURATION', 'DG01_APPLICATION_CONFIGURATION_UNKNOWN',
  'DG01_EVIDENCE_CHANGED', 'DG01_CONTEXT_UNREADABLE', 'DG01_NO_BLOCKER_FOUND',
  'DG03_TARGET_DNS_FAILURE', 'DG03_PROXY_FAILURE', 'DG03_TARGET_CONNECTION_FAILURE', 'DG03_TARGET_TLS_FAILURE', 'DG03_TARGET_HTTP_FAILURE'
] as const
export type DiagnosticConclusionRuleId = typeof diagnosticConclusionRuleIds[number]
export const diagnosticConclusionContracts: Readonly<Record<DiagnosticConclusionRuleId, {
  readonly status: DiagnosticConclusionStatus
  readonly scope: DiagnosticConclusionScope
}>> = {
  DG01_LOCAL_SERVICE_DOWN: { status: 'blocked', scope: 'local-service' },
  DG01_TUNNEL_REQUIRED: { status: 'blocked', scope: 'tunnel' },
  DG01_TARGET_RESPONSE_BOUNDARY: { status: 'limited', scope: 'target-service' },
  DG01_TARGET_PATH_UNCONFIRMED: { status: 'unknown', scope: 'target-path' },
  DG01_APPLICATION_UNCONFIRMED: { status: 'unknown', scope: 'application' },
  DG01_APPLICATION_CONFIGURATION: { status: 'blocked', scope: 'application' },
  DG01_APPLICATION_CONFIGURATION_UNKNOWN: { status: 'unknown', scope: 'application' },
  DG01_EVIDENCE_CHANGED: { status: 'unknown', scope: 'diagnostic-context' },
  DG01_CONTEXT_UNREADABLE: { status: 'unknown', scope: 'diagnostic-context' },
  DG01_NO_BLOCKER_FOUND: { status: 'clear', scope: 'none' },
  DG03_TARGET_DNS_FAILURE: { status: 'blocked', scope: 'target-path' },
  DG03_PROXY_FAILURE: { status: 'blocked', scope: 'target-path' },
  DG03_TARGET_CONNECTION_FAILURE: { status: 'blocked', scope: 'target-path' },
  DG03_TARGET_TLS_FAILURE: { status: 'blocked', scope: 'target-path' },
  DG03_TARGET_HTTP_FAILURE: { status: 'blocked', scope: 'target-path' }
}

export interface DiagnosticConclusionEvidence {
  readonly checkId: DiagnosticCheck['id']
  readonly code: DiagnosticCheckCode
  readonly statement: string
}

export interface DiagnosticConclusion {
  readonly status: DiagnosticConclusionStatus
  readonly scope: DiagnosticConclusionScope
  /** 内部追溯标识；客户界面只展示下面的自然语言。 */
  readonly ruleId: DiagnosticConclusionRuleId
  readonly title: string
  readonly summary: string
  readonly nextStep: string
  readonly evidence: readonly DiagnosticConclusionEvidence[]
}

export interface DiagnosticPathMatrixEntry {
  readonly path: DiagnosticPathKind
  readonly state: DiagnosticPathState
  readonly phase?: DiagnosticProbePhase
  readonly elapsedMs?: number
  readonly message: string
}

export interface DiagnosticPathMatrix {
  /** 三条对照路径与报告共用一个冻结时刻；配置变化时整份矩阵失效。 */
  readonly checkedAt: number
  readonly valid: boolean
  readonly entries: readonly [
    DiagnosticPathMatrixEntry & { readonly path: 'direct' },
    DiagnosticPathMatrixEntry & { readonly path: 'existing-proxy' },
    DiagnosticPathMatrixEntry & { readonly path: 'laixin-tunnel' }
  ]
}

export interface NetworkDiagnosticReport {
  readonly software: DiagnosticSoftware
  readonly checkedAt: number
  readonly validUntil: number
  readonly target: { readonly label: string, readonly route: 'direct' | 'tunnel' | 'isolated' }
  readonly conclusion: DiagnosticConclusion
  readonly checks: readonly DiagnosticCheck[]
  /** 仅主目标路径失败时出现；不会包含目标 URL、代理地址、IP、证书或异常正文。 */
  readonly pathMatrix?: DiagnosticPathMatrix
}
