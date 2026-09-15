export interface DeviceFacts {
  platform: 'macos' | 'windows'
  architecture: 'x86_64' | 'arm64' | 'unknown'
  systemVersion: string | null
  memoryBytes: number | null
  availableDiskBytes: number | null
  toolboxVersion: string
}

export interface DeviceRecord extends DeviceFacts {
  deviceId: string
  firstSeenAt: number
  updatedAt: number
}

// 回执只由本人设备记录推导（DR- + 记录指纹），可由后台对账重现，不含账号、令牌或机器信息。
export const DEVICE_RECEIPT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const DEVICE_RECEIPT_PATTERN = /^DR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
export function validDeviceReceipt(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_RECEIPT_PATTERN.test(value)
}

export type IssueStatus = 'pending' | 'in-progress' | 'resolved'
export interface IssueUpdate {
  status: IssueStatus
  note: string
  recordedBy: string
  recordedAt: number
}
export interface CustomerIssue {
  id: string
  title: string
  deviceId: string | null
  software: 'codex' | 'hermes' | 'claude' | null
  status: IssueStatus
  revision: number
  createdAt: number
  updatedAt: number
  history: IssueUpdate[]
}
