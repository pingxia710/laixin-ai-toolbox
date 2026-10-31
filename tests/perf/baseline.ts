// N-88 性能基准采集:连接全链各阶段耗时(单调时钟)+资源占用快照。
// 只采集与汇总,⛔ 改任何超时/重试/传输/入口选择语义。测试与本地诊断共用;
// 本机毫秒数只作回归门槛相对比较,⛔ 写成全机型 SLA(边界由报告 usage 字段自述)。
import { monotonicNow } from './monotonic-now'
import { resourceSnapshot } from './resource-snapshot'

export const BASELINE_STAGES = [
  'account-request', 'config-claim', 'provisioning-wait', 'bridge-start', 'settings-write',
  'settings-restore', 'tunnel-establish', 'path-identity', 'target-confirm', 'reconnect-recovery'
] as const
export type BaselineStage = typeof BASELINE_STAGES[number]

export interface BaselineStageSample { stage: BaselineStage; durationMs: number; outcome: 'ok' | 'timeout' | 'error'; startedAtMono: number }
export interface BaselineRun {
  readonly scenario: string
  readonly startedAt: number
  readonly samples: BaselineStageSample[]
  readonly resourceDeltas: { rssBytes: number; heapUsedBytes: number; handles: number | null }
  readonly notes: readonly string[]
}

/** 单次基准运行的采集器:stage() 计时(单调时钟),finish() 产报告。 */
export function startBaselineRun(scenario: string, notes: readonly string[] = []): {
  samplesSoFar: () => readonly BaselineStageSample[]
  stage: (stage: BaselineStage, run: () => Promise<void>) => Promise<void>
  finish: () => BaselineRun
} {
  const samples: BaselineStageSample[] = []
  const startResource = resourceSnapshot()
  const startedAt = Date.now()
  return {
    /** 已采集样本快照(供断言读取)。 */
    samplesSoFar: (): readonly BaselineStageSample[] => [...samples],
    stage: async (stage, run) => {
      const startedAtMono = monotonicNow()
      let outcome: BaselineStageSample['outcome'] = 'ok'
      try {
        await run()
      } catch (error) {
        outcome = (error as { baselineTimeout?: boolean }).baselineTimeout === true ? 'timeout' : 'error'
        samples.push({ stage, durationMs: monotonicNow() - startedAtMono, outcome, startedAtMono })
        throw error
      }
      samples.push({ stage, durationMs: monotonicNow() - startedAtMono, outcome, startedAtMono })
    },
    finish: () => {
      const end = resourceSnapshot()
      return {
        scenario, startedAt, samples,
        resourceDeltas: {
          rssBytes: (end?.rssBytes ?? 0) - (startResource?.rssBytes ?? 0),
          heapUsedBytes: (end?.heapUsedBytes ?? 0) - (startResource?.heapUsedBytes ?? 0),
          handles: end?.handles ?? null
        },
        notes
      }
    }
  }
}

export interface BaselinePercentile { stage: BaselineStage; count: number; p50Ms: number | null; p95Ms: number | null; timeouts: number; errors: number }
export interface BaselineReport {
  readonly scenario: string
  readonly runs: number
  readonly totalMsP50: number | null
  readonly totalMsP95: number | null
  readonly stages: readonly BaselinePercentile[]
  readonly resourceCeiling: { rssBytes: number; heapUsedBytes: number; handles: number | null }
  readonly boundaries: readonly string[]
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

/** 多次运行 → 基线报告;资源取各 run 峰值。 */
export function baselineReport(runs: readonly BaselineRun[]): BaselineReport {
  if (runs.length === 0) throw new Error('BASELINE_EMPTY')
  const scenario = runs[0]!.scenario
  const totals = runs.map((run) => run.samples.reduce((sum, sample) => sum + sample.durationMs, 0))
  const stages = BASELINE_STAGES.map((stage) => {
    const samples = runs.flatMap((run) => run.samples.filter((sample) => sample.stage === stage))
    const durations = samples.filter((sample) => sample.outcome === 'ok').map((sample) => sample.durationMs)
    return { stage, count: samples.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
      timeouts: samples.filter((sample) => sample.outcome === 'timeout').length,
      errors: samples.filter((sample) => sample.outcome === 'error').length }
  }).filter((entry) => entry.count > 0)
  return {
    scenario, runs: runs.length,
    totalMsP50: percentile(totals, 0.5), totalMsP95: percentile(totals, 0.95),
    stages,
    resourceCeiling: {
      rssBytes: Math.max(...runs.map((run) => run.resourceDeltas.rssBytes)),
      heapUsedBytes: Math.max(...runs.map((run) => run.resourceDeltas.heapUsedBytes)),
      handles: runs.every((run) => run.resourceDeltas.handles === null) ? null : Math.max(...runs.map((run) => run.resourceDeltas.handles ?? 0))
    },
    boundaries: [
      '本机单机毫秒数,只作回归门槛相对比较,⛔ 全机型 SLA',
      '资源为各 run 起止差值(⛔ 运行中峰值);句柄数为 process._getActiveHandleCount 近似(平台边界),CPU 时间在 CI 噪声下不采集',
      ...(runs.some((run) => run.notes.length > 0) ? ['注入慢化: ' + runs.flatMap((run) => run.notes).join('; ')] : [])
    ]
  }
}
