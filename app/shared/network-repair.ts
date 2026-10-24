/** 只含受控状态和说明；不包含账号、凭据或本机配置内容。 */
export interface NetworkRepairStatus {
  readonly running: boolean
  readonly phase: 'idle' | 'restoring' | 'syncing' | 'connecting' | 'finished'
  readonly outcome: 'idle' | 'running' | 'recovered' | 'still_failing' | 'unknown' | 'cancelled'
  readonly code: string
  readonly message: string
  readonly startedAt: string
  readonly finishedAt: string
}

export const idleNetworkRepair: NetworkRepairStatus = {
  running: false, phase: 'idle', outcome: 'idle', code: '', message: '', startedAt: '', finishedAt: ''
}
