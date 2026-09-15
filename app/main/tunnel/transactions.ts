// current / pending / rollback 指针与「应用」事务(定稿第 4 轮 2):
// current 指针与它指向的批次目录在导入全程一个字节不动;applyPending 把 current
// 原子改指 pending 批次、pending 清空;旧 current 批次保留一份作回退候选,由下一次
// 成功应用后清理。取消 / 失败 / 崩溃只清 staging,⛔ 删 current 引用的任何文件。
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { layout, writeFileAtomic } from './paths'

const BATCH_ID = /^[0-9]{14}-[a-f0-9]{8}$/

function pointerValue(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined
    return readFileSync(path, 'utf8').trim()
  } catch { return undefined }
}

export function readPointer(path: string): string | undefined {
  const content = pointerValue(path)
  return content !== undefined && BATCH_ID.test(content) ? content : undefined
}

export function hasInvalidPointers(dataDir: string): boolean {
  return [layout.currentPointer(dataDir), layout.pendingPointer(dataDir), layout.rollbackPointer(dataDir)].some((path) => {
    try { lstatSync(path) } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    const content = pointerValue(path)
    return content === undefined || (content !== '' && !BATCH_ID.test(content))
  })
}

// 只删本数据目录下的常规批次目录；imports 或批次被换成链接时保留现场。
function removeBatch(dataDir: string, batchId: string): void {
  if (!BATCH_ID.test(batchId)) return
  const imports = layout.imports(dataDir)
  const target = layout.batchDir(dataDir, batchId)
  if (!existsSync(target) || !lstatSync(imports).isDirectory() || !lstatSync(target).isDirectory()) return
  if (dirname(realpathSync(imports)) !== realpathSync(dataDir) || dirname(realpathSync(target)) !== realpathSync(imports)) return
  rmSync(target, { recursive: true, force: true })
}

export function currentBatchId(dataDir: string): string | undefined {
  return readPointer(layout.currentPointer(dataDir))
}

export function pendingBatchId(dataDir: string): string | undefined {
  return readPointer(layout.pendingPointer(dataDir))
}

export function writePendingPointer(dataDir: string, batchId: string): void {
  if (!BATCH_ID.test(batchId)) throw new Error('TUNNEL_POINTER_INVALID')
  writeFileAtomic(layout.pendingPointer(dataDir), `${batchId}\n`)
}

export type ApplyOutcome =
  | { readonly outcome: 'applied'; readonly batchId: string; readonly previousBatchId: string | undefined }
  | { readonly outcome: 'rejected'; readonly code: 'TUNNEL_NO_PENDING' | 'TUNNEL_PENDING_MISSING' | 'TUNNEL_POINTER_INVALID' }

// 应用 = 完整事务。崩溃安全:current 指针单文件原子写 —— kill 后盘上要么旧要么新,⛔ 半状态;
// pending 与 current 同值属可收尾中间态,由 reconcilePointers 幂等清理。
// hooks 是测试注入的 kill 窗口(判据 13④),生产调用不传。
export function applyPending(
  dataDir: string,
  hooks: { beforeCurrentWrite?: () => void; afterCurrentWrite?: () => void } = {}
): ApplyOutcome {
  if (hasInvalidPointers(dataDir)) return { outcome: 'rejected', code: 'TUNNEL_POINTER_INVALID' }
  const pendingId = pendingBatchId(dataDir)
  if (pendingId === undefined) {
    return { outcome: 'rejected', code: 'TUNNEL_NO_PENDING' }
  }
  if (!existsSync(layout.batchDir(dataDir, pendingId))) {
    return { outcome: 'rejected', code: 'TUNNEL_PENDING_MISSING' }
  }
  const previousId = currentBatchId(dataDir)
  // 下一次成功应用后清理上一份回退候选。
  const previousRollback = readPointer(layout.rollbackPointer(dataDir))
  if (previousRollback !== undefined && previousRollback !== pendingId && previousRollback !== previousId) {
    removeBatch(dataDir, previousRollback)
  }
  hooks.beforeCurrentWrite?.()
  writeFileAtomic(layout.currentPointer(dataDir), `${pendingId}\n`) // ← 原子切换点
  hooks.afterCurrentWrite?.()
  writeFileAtomic(layout.pendingPointer(dataDir), '')
  if (previousId !== undefined) {
    writeFileAtomic(layout.rollbackPointer(dataDir), `${previousId}\n`)
  }
  return { outcome: 'applied', batchId: pendingId, previousBatchId: previousId }
}

// 启动时幂等收尾:pending 与 current 同值 = 上次崩在「切完指针、清 pending 前」,清掉即可。
export function reconcilePointers(dataDir: string): void {
  const pendingId = pendingBatchId(dataDir)
  const currentId = currentBatchId(dataDir)
  if (pendingId !== undefined && pendingId === currentId) {
    writeFileAtomic(layout.pendingPointer(dataDir), '')
  }
}

// 清理不被任何指针引用的孤儿批次目录(崩溃在 rename 与指针写入之间的产物)。
export function sweepOrphanBatches(dataDir: string): void {
  if (hasInvalidPointers(dataDir)) return
  const referenced = new Set(
    [currentBatchId(dataDir), pendingBatchId(dataDir), readPointer(layout.rollbackPointer(dataDir))].filter(
      (id): id is string => id !== undefined
    )
  )
  const importsDir = layout.imports(dataDir)
  if (!existsSync(importsDir)) {
    return
  }
  for (const entry of readdirSync(importsDir)) {
    if (!referenced.has(entry)) {
      removeBatch(dataDir, entry)
    }
  }
}

// staging 目录:导入失败 / 取消 / 崩溃只清本次 staging(⛔ 动 current 引用的任何文件)。
export function sweepStaging(dataDir: string): void {
  const stagingDir = layout.staging(dataDir)
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
