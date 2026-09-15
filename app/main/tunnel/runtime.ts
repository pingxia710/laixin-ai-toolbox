// 其他主进程模块的网络接口；会话接入仅由账号模块在主进程调用。
export { readTunnelSnapshot, setNetworkAccountAccess } from './runtime-owner'
export { NetworkAccountClient } from './account-client'
export type { NetworkAccountAccess, NetworkAccountSession } from './account-client'
export type { TunnelRuntimeSnapshot } from './runtime-owner'
