// N-27 恢复知情(桌面半):「通道断了又自己接上」时弹一次系统通知。
// 这里是通知的决策与文案(纯函数,经用例钉死);真弹系统通知的胶水在 desktop/runtime
// (现有 Electron Notification 路径,与额度提醒同一套)。⛔ 在这个模块里碰 electron。
import type { DaemonStateView } from '../tunnel/status-service'
import { DISPLAY_STATES } from '../tunnel/status-service'

export interface RecoveryNoticeText {
  /** 去重键:随故障片段 id 稳定。落桌面偏好(跨重启),同片段 ⛔ 二次打扰。 */
  readonly key: string
  readonly title: string
  readonly body: string
}

/** 中断时长给人话。⛔ 毫秒裸数;⛔ 内部码/出口 IP/节点地址——正文只有客户能理解的结果。 */
export function recoveryOutageWords(outageMs: number): string {
  const seconds = Math.max(0, Math.round(outageMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/**
 * 这一拍要不要弹恢复通知:有恢复事件、且这个片段还没展示过,才给文案。
 * alreadyNotified 同时查持久化标记与在途通知——2 秒/5 秒轮询、守护重启都从同一道闸过。
 * 没有事件或已展示 → undefined(不弹)。
 */
export function pendingRecoveryNotice(
  daemon: Pick<DaemonStateView, 'state' | 'recovery'> | undefined,
  alreadyNotified: (key: string) => boolean,
  liveStatus: { readonly state: string } | undefined
): RecoveryNoticeText | undefined {
  // state.json 可能因崩溃兜底撞锁而停在旧 connected；必须再过网络服务按 supervisor
  // isRunning/currentState 算出的本轮状态闸，不能凭磁盘旧事件向客户报“已恢复”。
  if (liveStatus?.state !== DISPLAY_STATES.connected || daemon?.state !== 'connected' || daemon.recovery === undefined) return undefined
  const recovery = daemon.recovery
  const key = `recovery:${String(recovery.id)}`
  if (alreadyNotified(key)) return undefined
  return {
    key,
    title: '来信 AI 工具箱',
    body: `网络已恢复，来信通道已自动重新连接；本次中断约 ${recoveryOutageWords(recovery.outageMs)}。点击查看网络状态。`
  }
}
