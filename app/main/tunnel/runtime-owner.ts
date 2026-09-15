import { DISPLAY_STATES } from './status-service'
import { type AccountAccessReason, type TunnelService } from './tunnel-service'
import type { NetworkAccountAccess } from './account-client'

export interface TunnelRuntimeSnapshot {
  readonly state: 'connected' | 'stopped'
  readonly localProxyUrl: string | undefined
}

let tunnelService: TunnelService | undefined

// 仅通道片动作注册使用；初始化后返回进程内唯一的运行时。
export function initializeTunnelRuntime(createService: () => TunnelService): TunnelService {
  if (tunnelService === undefined) {
    tunnelService = createService()
  }
  return tunnelService
}

// Account integration hook; call after normal authentication or with undefined on logout.
export function setNetworkAccountAccess(access: NetworkAccountAccess | undefined, reason?: AccountAccessReason) {
  if (!tunnelService) throw new Error('TUNNEL_RUNTIME_UNINITIALIZED')
  return tunnelService.setAccountAccess(access, reason)
}

export function readTunnelSnapshot(): TunnelRuntimeSnapshot {
  if (tunnelService === undefined) {
    throw new Error('TUNNEL_RUNTIME_UNINITIALIZED')
  }
  if (tunnelService.status().state !== DISPLAY_STATES.connected) {
    return { state: 'stopped', localProxyUrl: undefined }
  }
  // 复用了电脑上现有外网:终端接入按那个代理来(socks 类型给不出 http 地址就不给);没复用才是我们自己的入口
  const reused = tunnelService.reusedProxy()
  if (reused) return { state: 'connected', localProxyUrl: reused.kind === 'http' && reused.host ? `http://${reused.host}:${String(reused.port)}` : undefined }
  return { state: 'connected', localProxyUrl: `http://127.0.0.1:${String(tunnelService.activeBridgePort())}` }
}

/** 本次实际入口端口(诊断探针用);运行时未初始化时按默认口。 */
export function activeBridgePort(): number {
  return tunnelService?.activeBridgePort() ?? 18080
}

/**
 * 更新后这一轮到底算不算成（更新回执用）。
 * ⛔ 用 supervisor 的 `surrendered` 判：那一位只在「守护进程起不来」时置位，而「守护起来了、
 * 连不上节点」压根不经过 supervisor —— 那正是更新后最可能的失败形态，用它判会判成成功。
 * 判据用守护写的状态，它同时盖住两种失败。
 *  · 已连 ⇒ connected
 *  · 用户主动断开 / 未配置 ⇒ abandoned：客户自己不要连了，或本地没有可用配置（比如权益到期），
 *    这两种连不上都不是更新的锅，⛔ 因此回退 —— 回退了也一样连不上，还会把一个好版本永久标成坏的。
 *  · 其余（连接中 / 通道待确认 / 异常 / 已停止）一律 waiting：这几种正是坏版本会停在的地方，
 *    等到点仍在这里就该回退。
 */
export function updateConnectOutcome(): 'connected' | 'abandoned' | 'waiting' {
  if (tunnelService === undefined) return 'waiting'
  let state: string
  try { state = tunnelService.status().state } catch { return 'waiting' }
  if (state === DISPLAY_STATES.connected) return 'connected'
  if (state === DISPLAY_STATES.userDisconnected || state === DISPLAY_STATES.unconfigured) return 'abandoned'
  return 'waiting'
}

export function readNetworkDiagnosticStatus() {
  if (!tunnelService) throw new Error('TUNNEL_RUNTIME_UNINITIALIZED')
  return tunnelService.status()
}
