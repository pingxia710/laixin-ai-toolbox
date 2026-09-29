import type { Transform } from 'node:stream'

export interface DeliveryOptimizationLease {
  noteBytes(bytes: number): void
  release(): void
}

export interface DeliveryOptimizationAdmission {
  acquire(host: string, signal?: AbortSignal): Promise<DeliveryOptimizationLease | undefined>
  status(): { active: number; queued: number; concurrentLimit: number; provenLimit: number }
}

export declare const DELIVERY_OPTIMIZATION_SUFFIXES: readonly string[]
export declare const DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS: readonly number[]
export declare function isDeliveryOptimizationHost(host: string): boolean
export declare function createDeliveryOptimizationAdmission(options?: {
  now?: () => number
  sampleWindowMs?: number
  minSampleBytes?: number
  retryCooldownMs?: number
}): DeliveryOptimizationAdmission
export declare function createProxyDestinationAdmissionTransform(admission: DeliveryOptimizationAdmission): {
  stream: Transform
  noteBytes(bytes: number): void
}
