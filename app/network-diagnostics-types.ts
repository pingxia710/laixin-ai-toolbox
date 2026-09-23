export type DiagnosticSoftware = 'codex' | 'claude' | 'hermes'
export type DiagnosticState = 'passed' | 'attention' | 'unknown' | 'not-checked'
export const networkDiagnosticReportTtlMs = 10 * 60_000
export const supportDiagnosticAttemptLimit = 20
export interface DiagnosticCheck {
  readonly id: 'internet' | 'tunnel' | 'service' | 'account' | 'application'
  readonly label: string
  readonly state: DiagnosticState
  readonly code: DiagnosticCheckCode
  readonly message: string
  // 仅记录本次固定探测的总耗时；没有请求内容、地址或流量数据。
  readonly elapsedMs?: number
}
/** 检查结果码的唯一清单：主进程产出与界面校验共用一份，新增一类不会被界面判成非法报告。 */
export const diagnosticCheckCodes = [
  'AI_DIAG_INTERNET_OK', 'AI_DIAG_INTERNET_UNEXPECTED', 'AI_DIAG_INTERNET_UNAVAILABLE', 'AI_DIAG_INTERNET_TIMEOUT',
  'AI_DIAG_DIRECT_SERVICE', 'AI_DIAG_TUNNEL_VERIFIED', 'AI_DIAG_TUNNEL_REQUIRED', 'AI_DIAG_TUNNEL_UNKNOWN', 'AI_DIAG_TUNNEL_CHANGED',
  'AI_DIAG_SERVICE_AUTH', 'AI_DIAG_SERVICE_RESTRICTED', 'AI_DIAG_SERVICE_LIMITED', 'AI_DIAG_SERVICE_ERROR',
  'AI_DIAG_SERVICE_REACHABLE', 'AI_DIAG_SERVICE_UNEXPECTED', 'AI_DIAG_SERVICE_TIMEOUT', 'AI_DIAG_SERVICE_UNAVAILABLE', 'AI_DIAG_CONTEXT_CHANGED',
  'AI_DIAG_ACCOUNT_MANUAL', 'AI_DIAG_ACCOUNT_PROVIDER', 'AI_DIAG_ACCOUNT_UNKNOWN',
  'AI_DIAG_APPLICATION_UNCONFIRMED', 'AI_DIAG_APPLICATION_STALE', 'AI_DIAG_APPLICATION_OBSERVED', 'AI_DIAG_LOCAL_SERVICE_DOWN'
] as const
export type DiagnosticCheckCode = typeof diagnosticCheckCodes[number]

export const diagnosticConclusionStatuses = ['blocked', 'limited', 'unknown', 'clear'] as const
export type DiagnosticConclusionStatus = typeof diagnosticConclusionStatuses[number]
export const diagnosticConclusionScopes = ['local-service', 'tunnel', 'target-service', 'target-path', 'application', 'diagnostic-context', 'none'] as const
export type DiagnosticConclusionScope = typeof diagnosticConclusionScopes[number]
export const diagnosticConclusionRuleIds = [
  'DG01_LOCAL_SERVICE_DOWN', 'DG01_TUNNEL_REQUIRED', 'DG01_TARGET_RESPONSE_BOUNDARY', 'DG01_TARGET_PATH_UNCONFIRMED',
  'DG01_APPLICATION_UNCONFIRMED', 'DG01_EVIDENCE_CHANGED', 'DG01_CONTEXT_UNREADABLE', 'DG01_NO_BLOCKER_FOUND'
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
  DG01_EVIDENCE_CHANGED: { status: 'unknown', scope: 'diagnostic-context' },
  DG01_CONTEXT_UNREADABLE: { status: 'unknown', scope: 'diagnostic-context' },
  DG01_NO_BLOCKER_FOUND: { status: 'clear', scope: 'none' }
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

export interface NetworkDiagnosticReport {
  readonly software: DiagnosticSoftware
  readonly checkedAt: number
  readonly validUntil: number
  readonly target: { readonly label: string, readonly route: 'direct' | 'tunnel' }
  readonly conclusion: DiagnosticConclusion
  readonly checks: readonly DiagnosticCheck[]
}
