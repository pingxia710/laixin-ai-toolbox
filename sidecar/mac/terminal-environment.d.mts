export interface TerminalProxy {
  readonly host: '127.0.0.1'
  readonly port: number
}

export interface TerminalEnvironmentOptions {
  readonly enabled?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
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
