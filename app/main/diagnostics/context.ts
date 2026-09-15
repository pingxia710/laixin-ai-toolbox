// 主进程单例：故障经过留存。测试不走这里，直接构造 FaultLog。
import { app } from 'electron'
import { join } from 'node:path'
import { createFaultLogFiles, FaultLog, type FaultInput } from './fault-log'

let log: FaultLog | undefined

export function faultLog(): FaultLog {
  log ??= new FaultLog({ files: createFaultLogFiles(join(app.getPath('userData'), 'faults')), version: () => app.getVersion() })
  return log
}

/** 留痕是尽力而为：记不下来 ⛔ 影响客户正在做的事。 */
export function recordFault(fault: FaultInput): void {
  try { void faultLog().record(fault).catch(() => undefined) } catch { /* 版本号、磁盘、路径任一不可用都只是少一条记录 */ }
}
