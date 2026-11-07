export declare const FUNNEL_LEDGER_LIMIT: 10
export declare const FUNNEL_STAGE_OUTCOMES: readonly string[]
export declare const FUNNEL_ATTEMPT_OUTCOMES: readonly string[]
export interface FunnelStageRow {
  name: string
  durationMs: number
  outcome: string
  code?: string
  at?: number
  /** 失败/超时阶段的网络相位;ok 行不带。 */
  phase?: 'dns' | 'tcp' | 'tls' | 'proxy' | 'backend' | 'timeout' | 'unknown'
}
/** 守护在内存里会继续写 stages/outcome/endedAt,⛔ 标 readonly。 */
export interface FunnelAttempt {
  trigger: string
  startedAt: number
  stages: FunnelStageRow[]
  outcome: string
  endedAt: number | null
  nodeId?: string
  legRole?: 'primary' | 'secondary'
  code?: string
}
export declare function sanitizeFunnelCode(code: unknown): string | undefined
export declare function blankFunnelAttempt(trigger: string, startedAt: number): FunnelAttempt
export declare function setFunnelLeg(attempt: FunnelAttempt, nodeId: unknown, legRole?: unknown): void
export declare function funnelStageRow(name: unknown, durationMs: unknown, outcome: unknown, code: unknown, now?: unknown, phase?: unknown): FunnelStageRow | undefined
export declare function sanitizeFunnelAttempt(row: unknown): FunnelAttempt | undefined
export declare function appendFunnelAttempt(attempts: readonly FunnelAttempt[], attempt: FunnelAttempt, limit?: number): readonly FunnelAttempt[]
export declare function writeFunnelAttempts(path: string, attempts: readonly FunnelAttempt[]): void
export declare function readFunnelAttempts(path: string): readonly FunnelAttempt[]
