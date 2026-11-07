export declare const ENTRY_HEALTH_STATES: readonly string[]
export declare const ENTRY_FAILURE_THRESHOLD: 2
export declare const ENTRY_DWELL_MS: 30000
export declare const ENTRY_COOLDOWN_MS: 300000
export interface EntryHealthValue { state: string; failures: number; changedAt: number; lastFailureAt: number | null }
export interface EntryHealthView { entries: Record<string, EntryHealthValue>; lastRotationAt: number | null }
export interface NextHeadDecision { head: string | undefined; rotated: boolean; reason: 'kept' | 'rotated' | 'dwell' | 'exhausted' }
export interface EntryHealthStore {
  load(): void
  recordFailure(key: string): EntryHealthValue
  recordSuccess(key: string): void
  nextHead(candidateKeys: readonly string[]): NextHeadDecision
  exhausted(candidateKeys: readonly string[]): boolean
  view(): EntryHealthView
  persist(): void
}
/** N-86 入口健康状态机(healthy/suspect/cooling+耗尽决策态);证据只按当头入口记,单入口语义不变。
 * 运行期冷却/驻留判定用单调时钟(缺省 performance.now;墙钟回拨/快进不影响冷却窗),
 * 跨重启用持久墙钟差判满期,回拨签名(存的时间在未来)保守按整窗重计。 */
export declare function createEntryHealthStore(options: { path: string; now: () => number; monotonicNow?: () => number; limit?: number }): EntryHealthStore
