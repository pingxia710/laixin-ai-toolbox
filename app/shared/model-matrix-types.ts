import type { ApiFailure, ApiShell, ModelProviderId } from './api-service-types'

export type ModelMatrixState = 'passed' | 'failed' | 'skipped'
/** 没测的原因：这个壳这家没存 Key / 这个软件没装 / 版本闸门拦住。 */
export type ModelMatrixSkip = 'key_missing' | 'shell_missing' | 'version_gate'

/** 一格：某个来源在某个软件上用某个模型的真实探测结果。⛔ 含 Key。 */
export interface ModelMatrixEntry {
  readonly provider: ModelProviderId
  readonly shell: ApiShell
  readonly model: string
  readonly state: ModelMatrixState
  /** 失败时的 C5 判类。 */
  readonly code?: ApiFailure
  readonly skipped?: ModelMatrixSkip
  /** 首段文字返回耗时，毫秒；没测或没读到为空。 */
  readonly firstTextMs?: number
  readonly at: string
}

export interface ModelMatrixReport {
  readonly at: string
  readonly entries: readonly ModelMatrixEntry[]
}

export interface ModelMatrixProgress {
  readonly done: number
  readonly total: number
  readonly current?: { readonly provider: ModelProviderId; readonly shell: ApiShell; readonly model: string }
}

/**
 * 给运维的**建议**：每家挑一个「测过的软件都通过、最慢的那个软件也最快」的模型。
 * 按最慢壳排序而不是平均，这样给出的保证对每个软件都成立。
 * 只在真测过的软件里判（没装的软件是跳过、不是失败）；一家一个都没通过就不给建议。
 * **⛔ 自动改配方**——由人看过矩阵后手工定，再走 prepare-recipes.mjs 签发。
 */
export function suggestDefaultModels(report: ModelMatrixReport): Readonly<Partial<Record<ModelProviderId, string>>> {
  const suggestions: Partial<Record<ModelProviderId, string>> = {}
  for (const provider of providersIn(report)) {
    const rows = report.entries.filter((entry) => entry.provider === provider)
    const tested = new Set(rows.filter((entry) => entry.state !== 'skipped').map((entry) => entry.shell))
    if (tested.size === 0) continue
    const ranked = [...new Set(rows.map((entry) => entry.model))]
      .map((model) => {
        const graded = rows.filter((entry) => entry.model === model && entry.state !== 'skipped')
        if (graded.length !== tested.size || graded.some((entry) => entry.state !== 'passed')) return undefined
        const times = graded.map((entry) => entry.firstTextMs ?? Number.MAX_SAFE_INTEGER)
        return { model, slowest: Math.max(...times), total: times.reduce((sum, value) => sum + value, 0) }
      })
      .filter((row): row is { model: string; slowest: number; total: number } => row !== undefined)
      .sort((left, right) => left.slowest - right.slowest || left.total - right.total || left.model.localeCompare(right.model))
    if (ranked.length > 0) suggestions[provider] = ranked[0].model
  }
  return suggestions
}

function providersIn(report: ModelMatrixReport): readonly ModelProviderId[] {
  return [...new Set(report.entries.map((entry) => entry.provider))]
}

const stateMarks: Record<ModelMatrixState, string> = { passed: '通过', failed: '失败', skipped: '跳过' }
const skipReasons: Record<ModelMatrixSkip, string> = { key_missing: '没存 Key', shell_missing: '软件没装', version_gate: '版本不兼容' }

/** 运维看的一行；⛔ 含 Key。 */
export function matrixLine(entry: ModelMatrixEntry): string {
  const detail = entry.state === 'passed' ? `${entry.firstTextMs === undefined ? '' : `${String(entry.firstTextMs)} ms`}`
    : entry.state === 'skipped' ? skipReasons[entry.skipped ?? 'key_missing'] : entry.code ?? 'unknown'
  return `${entry.provider.padEnd(9)} ${entry.shell.padEnd(7)} ${entry.model.padEnd(28)} ${stateMarks[entry.state].padEnd(4)} ${detail}`
}
