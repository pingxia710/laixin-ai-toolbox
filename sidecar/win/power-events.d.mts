export type PowerEvent = 'wake' | 'network-change'

export declare function parsePowerEvent(line: unknown): PowerEvent | undefined

// 供测试执行实际生成的脚本;⛔ 在产品代码里二次拼接
export declare function watcherScript(): string

export declare const WAKE_EVENT_TYPES: readonly number[]

export interface PowerEventSource {
  stop(): void
}

export declare function createPowerEventSource(options: {
  emit: (event: PowerEvent) => void
  spawnProcess?: typeof import('node:child_process').spawn
  // 连续失败放弃重启时回调一次(诊断记录用)
  onGiveUp?: (reason: string) => void
  // 注入点(仅测试)
  timers?: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (id: unknown) => void
  }
  // N-83 快照兜底层注入点(与 mac 源同款;缺省 node:os/Date.now/setInterval)
  interfaces?: () => Record<string, Array<{ address: string; netmask: string; family: string; internal: boolean; mac: string; cidr?: string }>>
  now?: () => number
  every?: (callback: () => void, intervalMs: number) => unknown
  cancel?: (id: unknown) => void
}): PowerEventSource
