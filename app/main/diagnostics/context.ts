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

/**
 * 甲-6:本地故障留证的参数形状——「错误名:fs码」(如 `Error:ENOSPC`);程序错误只留名字。
 * ⛔ 原始消息(可能带路径/客户机文本):白名单口径下它出不了境,这里连本机记录也不进。
 * 形状保证过得了 noteParams 闸(短、字符集受限);超长名字交给清洗层丢,⛔ 在这里截断出半个词。
 */
export function faultParamsForLocalError(error: unknown): readonly string[] {
  const name = error instanceof Error && error.name !== '' ? error.name : 'Error'
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return [typeof code === 'string' && code !== '' ? `${name}:${code}` : name]
}
