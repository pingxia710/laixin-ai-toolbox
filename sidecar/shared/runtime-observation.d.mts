export declare const RUNTIME_OBSERVATION_VERSION: number
export declare const RUNTIME_OBSERVATION_INTERVAL_MS: number
export declare const RUNTIME_OBSERVATION_LIMIT: number
export declare function isPreOneRuntimeObservationVersion(version: string): boolean

export interface RuntimeObservationSample {
  readonly at: number
  readonly state: string
  readonly stage?: string
  readonly reconnectAttempts?: number
  readonly activeStreams?: number
  readonly uploadBytes?: number
  readonly downloadBytes?: number
  readonly rssBytes?: number
  readonly heapUsedBytes?: number
  readonly cpuPercent?: number
}

export declare function runtimeObservationPath(dataDir: string): string
export declare function sanitizeRuntimeObservationSample(sample: unknown): RuntimeObservationSample | undefined
export declare function buildRuntimeObservationSample(options: {
  readonly at: number
  readonly state: string
  readonly stage?: string
  readonly reconnectAttempts?: number
  readonly traffic?: { readonly activeStreams?: number; readonly uploadBytes?: number; readonly downloadBytes?: number }
  readonly memoryUsage?: { readonly rss?: number; readonly heapUsed?: number }
  readonly cpuUsage?: { readonly user?: number; readonly system?: number }
  readonly previous?: { readonly at: number; readonly user: number; readonly system: number }
}): { readonly sample: RuntimeObservationSample; readonly cpu?: { readonly at: number; readonly user: number; readonly system: number } } | undefined
export declare function appendRuntimeObservation(samples: readonly RuntimeObservationSample[], sample: unknown, limit?: number): RuntimeObservationSample[]
export declare function readRuntimeObservations(path: string): RuntimeObservationSample[]
export declare function writeRuntimeObservations(path: string, samples: readonly RuntimeObservationSample[]): void
