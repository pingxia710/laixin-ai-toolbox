import type { networkInterfaces } from 'node:os'

export declare function createPowerEventSource(options: {
  emit(event: 'wake' | 'network-change'): void
  interfaces?: typeof networkInterfaces
  now?: () => number
  every?: (tick: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}): { stop(): void }
