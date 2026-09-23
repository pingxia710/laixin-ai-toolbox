export interface TerminalProxy {
  readonly host: '127.0.0.1'
  readonly port: number
}

export interface TerminalRun {
  (command: string, args: readonly string[]): string
}

export interface TerminalEnvironmentOptions {
  readonly enabled?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly run?: TerminalRun
  // 注入点(仅测试):跳过注册表读数,直接指定「文档」已知文件夹解析结果。
  readonly documentsDirectory?: string
  // 注入点(仅测试):环境变量写入/删除后的 WM_SETTINGCHANGE 广播;生产走 koffi 原生 + PowerShell 回落。
  readonly notifyEnvironmentChanged?: () => void
}

export interface TerminalEnvironmentAdapter {
  readonly service: 'TerminalEnvironment'
  readonly enabled: boolean
  owns(ref: { readonly service: string; readonly item: string }): boolean
  preflight(proxy: TerminalProxy): void
  managedItems(proxy: TerminalProxy): Array<{ readonly ref: { readonly service: 'TerminalEnvironment'; readonly item: string }; readonly value: unknown }>
  read(ref: { readonly service: 'TerminalEnvironment'; readonly item: string }): unknown
  write(ref: { readonly service: 'TerminalEnvironment'; readonly item: string }, value: unknown): void
  valuesEqual(current: unknown, written: unknown): boolean
  restoredValueMatches(current: unknown, originalValue: unknown, writtenValue: unknown): boolean
}

export declare const TERMINAL_ENVIRONMENT_SERVICE: 'TerminalEnvironment'
export declare function createTerminalEnvironmentAdapter(options?: TerminalEnvironmentOptions): TerminalEnvironmentAdapter
