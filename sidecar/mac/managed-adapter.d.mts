import type { TerminalEnvironmentAdapter, TerminalProxy } from './terminal-environment.mjs'

export interface ManagedNetworkAdapter {
  preflight?(proxy: TerminalProxy): void
  managedItems(proxy: TerminalProxy): Array<{ readonly ref: { readonly service: string; readonly item: string }; readonly value: unknown }>
  read(ref: { readonly service: string; readonly item: string }): unknown
  write(ref: { readonly service: string; readonly item: string }, value: unknown): void
  valuesEqual?(left: unknown, right: unknown): boolean
  restoredValueMatches?(current: unknown, originalValue: unknown, writtenValue: unknown): boolean
  broadcastSettingsChanged?(): void
  /** 09-13 发布审查 R4:电脑上别的代理(不是我们的)当前开着吗;守护据此决定复用还是接管。 */
  existingProxy?(ours: { host: string; port: number; knownPorts?: readonly number[] }): { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number; url?: string; source?: string } | undefined
  /** 09-13 发布审查 R2:可选项(终端接入)这次没启用的原因。 */
  optionalNote?(): string
}

export declare function createAdapter(options?: { readonly enabled?: boolean; readonly env?: Readonly<Record<string, string | undefined>>; readonly home?: string }): Promise<ManagedNetworkAdapter>
export declare function composeManagedAdapters(networkAdapter: ManagedNetworkAdapter, terminalAdapter: TerminalEnvironmentAdapter): ManagedNetworkAdapter
