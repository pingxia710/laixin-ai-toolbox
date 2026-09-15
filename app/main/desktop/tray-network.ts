export interface TrayNetworkStatus {
  readonly state: string
  readonly currentConfig: string
  readonly unrestored: string
}

export interface TrayNetworkPresentation {
  readonly statusLabel: string
  readonly action: 'start' | 'stop' | 'show'
  readonly actionLabel: string
  readonly actionEnabled: boolean
}

export const TRAY_NETWORK_OPERATION_INCOMPLETE = '本次 AI网络操作未完成，请打开状态页查看后重试。'

/** 托盘菜单内容签名:签名未变就不重建菜单,⛔ 每 30 秒无条件重建。 */
export function trayMenuSignature(update: { readonly state: string; readonly version: string }, network: TrayNetworkPresentation): string {
  return JSON.stringify([update.state, update.version, network.statusLabel, network.action, network.actionLabel, network.actionEnabled])
}

export function trayNetworkPresentation(status: TrayNetworkStatus | undefined, actionPending: boolean): TrayNetworkPresentation {
  if (status === undefined) {
    return { statusLabel: 'AI网络 · 状态读取中', action: 'show', actionLabel: '查看 AI网络状态', actionEnabled: true }
  }
  const statusLabel = `AI网络 · ${status.state || '状态未知'}`
  if (status.unrestored) {
    return { statusLabel, action: 'show', actionLabel: '查看 AI网络状态', actionEnabled: true }
  }
  if (['已连', '连接中', '通道待确认'].includes(status.state) ||
      (status.state === '异常' && status.currentConfig !== '')) {
    return { statusLabel, action: 'stop', actionLabel: '断开 AI网络', actionEnabled: !actionPending }
  }
  if (status.state === '异常') {
    return { statusLabel, action: 'show', actionLabel: '查看 AI网络状态', actionEnabled: true }
  }
  if (status.currentConfig) {
    return { statusLabel, action: 'start', actionLabel: '连接 AI网络', actionEnabled: !actionPending }
  }
  return { statusLabel, action: 'show', actionLabel: '打开 AI网络设置', actionEnabled: true }
}

export function asTrayNetworkStatus(value: unknown): TrayNetworkStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const status = value as Partial<TrayNetworkStatus>
  return typeof status.state === 'string' && typeof status.currentConfig === 'string' && typeof status.unrestored === 'string'
    ? { state: status.state, currentConfig: status.currentConfig, unrestored: status.unrestored }
    : undefined
}

export function trayNetworkFailureMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const result = value as { readonly outcome?: unknown, readonly message?: unknown }
  return result.outcome === 'rejected' && typeof result.message === 'string' && result.message.length > 0 && result.message.length <= 300
    ? result.message
    : undefined
}
