export interface FakeRegistryValue {
  readonly type: string
  readonly data: string
}

export interface FakeWininetStore {
  readonly ProxyEnable?: FakeRegistryValue
  readonly ProxyServer?: FakeRegistryValue
  readonly ProxyOverride?: FakeRegistryValue
  readonly AutoConfigURL?: FakeRegistryValue
  readonly [key: string]: unknown
}

export interface FakeWininetAdapter {
  valuesEqual(left: unknown, right: unknown, ref?: { service: string; item: string }): boolean
  preserveExternalChanges(ref: { service: string; item: string }): boolean
  reapplyOnChange(ref: { service: string; item: string }): boolean
  preflight(proxy: { host: string; port: number }): void
  /** 电脑上别的代理(不是我们的)当前是否开着。「是不是我们的」按 ours.knownPorts 这份记录判。 */
  existingProxy(ours: { host: string; port: number; knownPorts?: readonly number[] }):
    { kind: 'http' | 'socks' | 'pac'; host?: string; port?: number; url?: string; source?: string } | undefined
  read(itemRef: { service: string; item: string }): unknown
  write(itemRef: { service: string; item: string }, value: unknown): void
  managedItems(proxy: { host: string; port: number }): Array<{
    ref: { service: string; item: string }
    value: unknown
  }>
  broadcastSettingsChanged(): void
}

export declare function createAdapter(env?: NodeJS.ProcessEnv): FakeWininetAdapter
