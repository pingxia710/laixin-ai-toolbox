// xray-runner:bridge 的子进程,只管自己启动的 Xray 的生命周期(停止主通道 = stdin 管道关闭)。
export interface XrayRunnerOptions {
  readonly executable?: string | undefined
  readonly config?: string | undefined
  readonly parent?: number | undefined
  readonly stdin?: unknown
  readonly ppid?: number | undefined
  readonly platform?: string | undefined
  readonly spawnImpl?: ((executable: string, args: readonly string[], options?: Record<string, unknown>) => unknown)
  readonly getPpid?: () => number
  readonly exit?: (code: number) => void
  readonly timers?: {
    setInterval: (fn: () => void, ms?: number) => unknown
    clearInterval: (id: unknown) => void
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (id: unknown) => void
  }
}

export declare function startXrayRunner(options: XrayRunnerOptions): { stop(): void, child?: unknown, stopped?: boolean }
