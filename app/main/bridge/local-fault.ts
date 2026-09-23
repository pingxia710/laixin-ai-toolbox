// 甲-6返工:桥层兜底(ACTION_FAILED)的本机故障归类。按动作名前缀定模块:
//  · tunnel.* 是通道(网络)动作,失败照旧记通道码 AI_DIAG_TUNNEL_ACTION_FAILED + tunnel_local_fault——
//    网络路径与甲-6 一字不差;
//  · 其余模块的动作失败是工具箱本机问题,⛔ 再冒充网络问题——不带网络码,记模块+动作维度
//    (bridgeAction 全名 + 模板里的模块短名),客服与数据按「没有网络码」即知不是网络问题。
// 隐私边界与甲-6 相同:参数只有受控的模块短名与「错误名:fs码」形状,⛔ 原始消息与路径。
import { faultParamsForLocalError } from '../diagnostics/context'
import type { FaultInput } from '../diagnostics/fault-log'

/** 前缀超了记录参数闸(≤15 字)的模块记短名;其余前缀原样进记录。 */
const moduleNoteNames: Readonly<Record<string, string>> = { networkdiagnostics: 'netdiag' }
/** 模块短名的自保判据(与 fault-log-types 的参数闸同向):小写字母数字、≤15 字,超了归 unknown。 */
const moduleNamePattern = /^[a-z0-9]{1,15}$/

export function isTunnelAction(actionName: string): boolean {
  return actionName.startsWith('tunnel.')
}

/** 桥层诊断应记的本机故障;不是「动作失败带原始错误」就返回 undefined(维持甲-6 行为)。 */
export function actionLocalFault(code: string, actionName: string, error?: unknown): FaultInput | undefined {
  if (code !== 'ACTION_FAILED' || error === undefined || actionName === '') return undefined
  if (isTunnelAction(actionName)) {
    return { network: 'AI_DIAG_TUNNEL_ACTION_FAILED', note: 'tunnel_local_fault', noteParams: faultParamsForLocalError(error) }
  }
  const dot = actionName.indexOf('.')
  const prefix = dot === -1 ? actionName : actionName.slice(0, dot)
  const mapped = Object.hasOwn(moduleNoteNames, prefix) ? moduleNoteNames[prefix] : undefined
  const module = mapped ?? (moduleNamePattern.test(prefix) ? prefix : 'unknown')
  return { note: 'action_local_fault', noteParams: [module, ...faultParamsForLocalError(error)], bridgeAction: actionName }
}
