export type DiagnosticSoftware = 'codex' | 'claude' | 'hermes'
export type DiagnosticState = 'passed' | 'attention' | 'unknown' | 'not-checked'
export interface DiagnosticCheck {
  readonly id: 'internet' | 'tunnel' | 'service' | 'account' | 'application'
  readonly label: string
  readonly state: DiagnosticState
  readonly code: string
  readonly message: string
  // 仅记录本次固定探测的总耗时；没有请求内容、地址或流量数据。
  readonly elapsedMs?: number
}
/** 检查结果码的唯一清单：主进程产出与界面校验共用一份，新增一类不会被界面判成非法报告。 */
export const diagnosticCheckCodes = [
  'AI_DIAG_INTERNET_OK', 'AI_DIAG_INTERNET_UNEXPECTED', 'AI_DIAG_INTERNET_UNAVAILABLE', 'AI_DIAG_INTERNET_TIMEOUT',
  'AI_DIAG_DIRECT_SERVICE', 'AI_DIAG_TUNNEL_VERIFIED', 'AI_DIAG_TUNNEL_REQUIRED', 'AI_DIAG_TUNNEL_CHANGED',
  'AI_DIAG_SERVICE_AUTH', 'AI_DIAG_SERVICE_RESTRICTED', 'AI_DIAG_SERVICE_LIMITED', 'AI_DIAG_SERVICE_ERROR',
  'AI_DIAG_SERVICE_REACHABLE', 'AI_DIAG_SERVICE_UNEXPECTED', 'AI_DIAG_SERVICE_TIMEOUT', 'AI_DIAG_SERVICE_UNAVAILABLE',
  'AI_DIAG_ACCOUNT_MANUAL', 'AI_DIAG_ACCOUNT_PROVIDER', 'AI_DIAG_ACCOUNT_UNKNOWN',
  'AI_DIAG_APPLICATION_UNCONFIRMED', 'AI_DIAG_APPLICATION_OBSERVED', 'AI_DIAG_LOCAL_SERVICE_DOWN'
] as const
export type DiagnosticCheckCode = typeof diagnosticCheckCodes[number]

export interface NetworkDiagnosticReport {
  readonly software: DiagnosticSoftware
  readonly checkedAt: number
  readonly checks: readonly DiagnosticCheck[]
}
