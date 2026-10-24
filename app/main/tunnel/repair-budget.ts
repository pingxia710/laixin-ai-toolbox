// N-23:修复复验预算与恢复子进程 deadline 的统一伸缩尺(09-18 真机 HUAWEI 钉死的主导分支)。
// 慢机上每个用户环境变量写 30-40s(杀软冷启动 PowerShell),一轮 restore+apply 全 14 项要 2-5 分钟,
// 而预算固定 45 秒——修复必然超时,客户反复点、反复「复验超时」;固定 60 秒的恢复 deadline 同理会把
// 慢机上**合法的**恢复拦腰杀掉。两者都改为「基础/保底 + 账本待结算条数 × 单条上限」,封顶防病态账本。
// ⛔ 依赖本文件之外任何模块(它被 tunnel-service 与 supervisor 两侧共用,别造出环)。

/** 无账本可结时的预算基础:与 0.5.11 前的固定修复超时同值(纯连接复验场景节奏不变)。 */
export const REPAIR_BUDGET_BASE_MS = 45_000
/** 单条设置账目按慢机节奏给的上限(真机实测 30-40s/条,取 30s 盖住多数;预算只是上限,修好即提前收)。 */
export const REPAIR_BUDGET_PER_ENTRY_MS = 30_000
/** 病态账本(上千条)的封顶:修复结论不能无限期悬着。 */
export const REPAIR_BUDGET_MAX_MS = 15 * 60_000
/** 恢复子进程 deadline 的保底:账本为空时也允许一轮完整空跑+收尾。 */
export const RESTORE_DEADLINE_FLOOR_MS = 60_000

export function repairBudgetMs(pendingCount: number): number {
  const count = Number.isFinite(pendingCount) && pendingCount > 0 ? Math.floor(pendingCount) : 0
  return Math.min(REPAIR_BUDGET_MAX_MS, REPAIR_BUDGET_BASE_MS + count * REPAIR_BUDGET_PER_ENTRY_MS)
}

/** 一次性恢复子进程的 deadline:与修复预算同源,保底 60s,账本大时按同一条数节奏放大。 */
export function restoreDeadlineMs(pendingCount: number): number {
  return Math.max(RESTORE_DEADLINE_FLOOR_MS, repairBudgetMs(pendingCount))
}
