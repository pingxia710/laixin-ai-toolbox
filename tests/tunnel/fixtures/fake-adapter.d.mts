export interface FakeAdapter {
  read(itemRef: { service: string; item: string }): unknown
  write(itemRef: { service: string; item: string }, value: unknown): void
  managedItems(proxy: { host: string; port: number }): Array<{
    ref: { service: string; item: string }
    value: unknown
  }>
  preflight(): void
  existingProxy(ours: { host: string; port: number }): { kind: 'http' | 'socks'; host: string; port: number; source: string } | undefined
}

export declare function createAdapter(env?: NodeJS.ProcessEnv): FakeAdapter

