import type { TerminalEnvironmentAdapter, TerminalProxy } from './terminal-environment.mjs'

export interface ManagedNetworkAdapter {
  currentPathIdentity?(): { readonly id: string; readonly kind?: string }
  identifyPortOwner?(port: number | undefined): { readonly kind: string; readonly pid?: number; readonly name?: string } | undefined
  acquireWriteRight?(options?: { readonly timeoutMs?: number }):
    | { readonly acquired: true; readonly abandoned?: boolean; readonly abandonedRecovered?: boolean; assertHeld?(): void; release(): boolean }
    | { readonly acquired: false; readonly reason: string }
  preflight?(proxy: TerminalProxy): void
  managedItems(proxy: TerminalProxy): Array<{ readonly ref: { readonly service: string; readonly item: string }; readonly value: unknown }>
  read(ref: { readonly service: string; readonly item: string }): unknown
  write(ref: { readonly service: string; readonly item: string }, value: unknown): void
  valuesEqual?(left: unknown, right: unknown): boolean
  restoredValueMatches?(current: unknown, originalValue: unknown, writtenValue: unknown): boolean
  broadcastSettingsChanged?(): void
  /** 09-13 发布审查 R4:电脑上别的代理(不是我们的)当前开着吗;守护据此决定复用还是接管。 */
  existingProxy?(ours: { host: string; port: number; knownPorts?: readonly number[] }): { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number; url?: string; source?: string } | undefined
  /** 异步探测完成后显式复核候选仍对应当前系统 HTTPS 路径。 */
  validateExistingProxy?(candidate: { kind: string; host?: string; port?: number }): void
  /** 去掉一次性系统快照元数据，生成可长期保存的普通不可变 DTO。 */
  materializeExistingProxy?(candidate: { kind: string; host?: string; port?: number; source?: string }): { kind: 'http' | 'socks' | 'pac' | 'direct'; host?: string; port?: number; url?: string; source?: string }
  /** 09-13 发布审查 R2:可选项(终端接入)这次没启用的原因。 */
  optionalNote?(): string
}

export declare function createAdapter(options?: {
  readonly enabled?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly acquireWriteRight?: (options?: { readonly timeoutMs?: number }) => unknown
  readonly identifyPortOwner?: (port: number | undefined) => unknown
}): Promise<ManagedNetworkAdapter>
export declare function composeManagedAdapters(
  networkAdapter: ManagedNetworkAdapter,
  terminalAdapter: TerminalEnvironmentAdapter,
  acquireWriteRight?: (options?: { readonly timeoutMs?: number }) => unknown,
  identifyPortOwner?: (port: number | undefined) => unknown
): ManagedNetworkAdapter
