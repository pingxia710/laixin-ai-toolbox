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

/** 支持包仅在主进程内比较本轮来源；不暴露给 bridge 或渲染层。 */
export function readReportRuntimeProvenance(): ReturnType<TunnelService['reportRuntimeProvenance']> | undefined {
  return tunnelService?.reportRuntimeProvenance()
}

/** 私有诊断会话跟随当前通路；undefined 仅表示已确认的复用直连，不代表使用系统代理。 */
export function readNetworkDiagnosticProxy(): string | undefined {
  const reused = tunnelService?.reusedProxy()
  if (!reused) return `http://127.0.0.1:${String(activeBridgePort())}`
  if (reused.kind === 'direct') return undefined
  if (!['http', 'socks'].includes(reused.kind) || !reused.host || /[\s/@?#;\\]/.test(reused.host) ||
      !Number.isInteger(reused.port) || reused.port! < 1 || reused.port! > 65535) throw new Error('DIAGNOSTIC_PATH_UNAVAILABLE')
  const host = reused.host.includes(':') && !reused.host.startsWith('[') ? `[${reused.host}]` : reused.host
  const proxy = new URL(`${reused.kind === 'socks' ? 'socks5' : 'http'}://${host}:${String(reused.port)}`)
  return `${proxy.protocol}//${proxy.host}`
}

/** 当前运行时保留的来信桥地址；只用于排除重复路径，不代表通道可用。 */
export function readLaixinNetworkDiagnosticEndpoint(): string | undefined {
  if (tunnelService === undefined) return undefined
  try { return tunnelService.diagnosticBridgeEndpoint() } catch { return undefined }
}

/** 接管前的系统现有代理；只供主进程私有诊断会话使用。 */
export function readExistingNetworkDiagnosticProxy(): string | undefined {
  return readExistingNetworkDiagnosticEvidence()?.proxyUrl
}

/** 接管前代理与活动路径的原子证据；服务/设备原文不离开 TunnelService。 */
export function readExistingNetworkDiagnosticEvidence(): ReturnType<TunnelService['diagnosticExistingProxyEvidence']> {
  if (tunnelService === undefined) return undefined
  try { return tunnelService.diagnosticExistingProxyEvidence() } catch { return undefined }
}

/**
 * N-54 的“来信通道”对照只能在当前运行时确认持有通道时使用。
 * 不因默认端口或同端口的其他进程猜测来信入口。
 */
export function readLaixinNetworkDiagnosticProxy(): string | undefined {
  if (tunnelService === undefined) return undefined
  let status: ReturnType<TunnelService['status']>
  try { status = tunnelService.status() } catch { return undefined }
  const now = Date.now()
  const verifiedAt = Date.parse(status.lastVerifiedAt)
  if (status.state !== DISPLAY_STATES.connected || status.pathSource !== 'laixin' || status.unrestored || status.componentMissing ||
      !Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > 90_000) return undefined
  return readLaixinNetworkDiagnosticEndpoint()
}

/**
 * 更新后这一轮到底算不算成（更新回执用）。
 * ⛔ 用 supervisor 的 `surrendered` 判：那一位只在「守护进程起不来」时置位，而「守护起来了、
 * 连不上节点」压根不经过 supervisor —— 那正是更新后最可能的失败形态，用它判会判成成功。
 * 判据用守护写的状态，它同时盖住两种失败。
 *  · 已连 ⇒ connected
 *  · 明确的客户断开／退出且状态已离线 ⇒ abandoned：不能靠状态文案猜客户意图。
 *  · 未配置 ⇒ waiting：更新前明明已连接时，新版突然读不到配置可能正是更新回归，
 *    不能猜成客户主动放弃而删掉唯一回退通道。
 *  · 其余（连接中 / 通道待确认 / 异常 / 非客户意图的已停止）一律 waiting：这几种正是坏版本会停在的地方，
 *    等到点仍在这里就该回退。
 */
export function updateConnectOutcome(): 'connected' | 'abandoned' | 'waiting' {
  if (tunnelService === undefined) return 'waiting'
  let state: string
  try { state = tunnelService.status().state } catch { return 'waiting' }
  if (state === DISPLAY_STATES.connected) return 'connected'
  if ((state === DISPLAY_STATES.userDisconnected || state === DISPLAY_STATES.disconnecting || state === DISPLAY_STATES.stoppedRestored) &&
      tunnelService.explicitlyStoppedNetwork()) return 'abandoned'
  return 'waiting'
}

export function readNetworkDiagnosticStatus() {
  if (!tunnelService) throw new Error('TUNNEL_RUNTIME_UNINITIALIZED')
  return tunnelService.status()
}
