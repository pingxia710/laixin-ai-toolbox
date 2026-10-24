// 常驻运行时的进程内唯一持有者。
//
// 为什么要这一层:创建它要 sidecarDir / launch 参数(只有通道片算得出,__dirname 依赖),
// 而按开关校准要读客户的选择(只有桌面片拿得到 store)。两边谁先起来不确定,⛔ 让其中一边等另一边——
// 校准来早了就记下,运行时注册上来立刻补跑。
import type { ResidentOutcome } from './platform/resident'
import type { ResidentRuntime } from './resident-bridge'

let runtime: ResidentRuntime | undefined
let pendingChoice: boolean | undefined
let calibrationError = ''

/** Only a stable code crosses into the UI; command output can contain local paths. */
export function residentCalibrationError(): string { return calibrationError }
function failureCode(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? '')
  return /0x80070005/i.test(message) ? '0x80070005' : 'RESIDENT_SETUP_FAILED'
}

export function setResidentRuntime(value: ResidentRuntime): void {
  runtime = value
  calibrationError = ''
  if (pendingChoice !== undefined) {
    const wanted = pendingChoice
    pendingChoice = undefined
    void calibrateResident(wanted).catch(() => undefined)
  }
}

/** 按开关校准常驻:该装就装、该卸就卸。启动时跑一次(更新换过 bundle 后描述文件里的路径已经不对,必须重装),
 *  客户拨开关时再跑一次(⛔ 让他等到下次重连才生效)。运行时还没注册就记下,注册时补跑。 */
export async function calibrateResident(enabled: boolean): Promise<ResidentOutcome | undefined> {
  if (runtime === undefined) {
    pendingChoice = enabled
    return undefined
  }
  const current = runtime
  try {
    const outcome = await current.calibrate(enabled)
    if (runtime === current) calibrationError = enabled && !outcome.installed ? failureCode(outcome.reason) : ''
    return outcome
  } catch (error) {
    if (runtime === current) calibrationError = enabled ? failureCode(error) : ''
    throw error
  }
}

/** 仅供测试复位。 */
export function resetResidentRuntime(): void {
  runtime = undefined
  pendingChoice = undefined
  calibrationError = ''
}
