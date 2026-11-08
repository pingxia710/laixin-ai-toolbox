export declare function createEmergencyRecoveryAdapter(options?: {
  readonly platform?: string
  readonly exec?: (command: string, args: readonly string[], options?: Record<string, unknown>) => unknown
}): Promise<{
  readonly managedItems: () => readonly never[]
  readonly acquireWriteRight: (options?: { readonly timeoutMs?: number }) => { readonly acquired: boolean; readonly reason?: string; readonly release?: () => void }
  readonly read: (ref: { readonly service: string; readonly item: string }) => unknown
  readonly write: (ref: { readonly service: string; readonly item: string }, value: unknown, options?: Record<string, unknown>) => void
  readonly valuesEqual: (left: unknown, right: unknown) => boolean
  readonly restoredValueMatches: (current: unknown, original: unknown) => boolean
  readonly preserveExternalChanges: () => true
  readonly identifyPortOwner: (port: number, options?: Record<string, unknown>) => { readonly kind: string; readonly reason?: string; readonly pid?: number }
  readonly readProxyEndpoints: () => readonly { readonly host: string; readonly port: number }[]
  readonly broadcastSettingsChanged: () => void
}>
