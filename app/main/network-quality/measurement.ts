/** Transport and route verification are supplied by the caller; this module never selects a network path. */
export interface MeasurementTransport {
  /** Monotonic path generation; must change on every reconnect or binding change. */
  readonly context: () => Promise<string | undefined>
  readonly response: (signal: AbortSignal) => Promise<void>
  readonly download: (limit: number, signal: AbortSignal) => Promise<number>
  readonly upload: (size: number, signal: AbortSignal) => Promise<number>
}

export interface NetworkMeasurement {
  readonly measuredAt: number
  readonly responseMs: number
  /** Max-minus-min for the three requests in this run; not an ICMP jitter measurement. */
  readonly responseSpreadMs: number
  readonly downloadMbps: number
  readonly uploadMbps: number
  readonly downloadBytes: number
  readonly uploadBytes: number
}

/** An incomplete measurement is never returned as a zero or a previous result. */
export class MeasurementError extends Error {
  constructor(readonly code: 'busy' | 'cancelled' | 'timeout' | 'path-unavailable' | 'path-changed' | 'invalid-transfer' | 'failed') {
    super(code)
  }
}

export interface MeasurementOptions {
  readonly bytes: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly wallNow?: () => number
}

/** One user-triggered run at a time; the host must establish and verify the actual route. */
export class NetworkQualityMeasurement {
  private pending = false

  async run(transport: MeasurementTransport, options: MeasurementOptions): Promise<NetworkMeasurement> {
    if (this.pending) throw new MeasurementError('busy')
    if (!Number.isSafeInteger(options.bytes) || options.bytes < 1 || options.bytes > 10 * 1024 * 1024 ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000) {
      throw new MeasurementError('invalid-transfer')
    }
    this.pending = true
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    const now = options.now ?? (() => performance.now())
    const check = () => { if (signal.aborted) throw new MeasurementError(options.signal?.aborted ? 'cancelled' : 'timeout') }
    const duration = (start: number) => {
      const elapsed = now() - start
      if (!Number.isFinite(elapsed) || elapsed <= 0) throw new MeasurementError('invalid-transfer')
      return elapsed
    }
    const verify = async (original: string) => {
      check()
      const context = await transport.context()
      check()
      if (!context || context !== original) throw new MeasurementError('path-changed')
    }
    const operation = (async () => {
      try {
        check()
        const context = await transport.context()
        check()
        if (!context) throw new MeasurementError('path-unavailable')
        const responses: number[] = []
        for (let index = 0; index < 3; index++) {
          const start = now()
          await transport.response(signal)
          check()
          responses.push(duration(start))
          await verify(context)
        }
        responses.sort((left, right) => left - right)
        const responseMs = responses[1]
        const responseSpreadMs = responses[2] - responses[0]
        let start = now()
        const downloadBytes = await transport.download(options.bytes, signal)
        check()
        const downloadMs = duration(start)
        if (downloadBytes !== options.bytes) throw new MeasurementError('invalid-transfer')
        await verify(context)
        start = now()
        const uploadBytes = await transport.upload(options.bytes, signal)
        check()
        const uploadMs = duration(start)
        if (uploadBytes !== options.bytes) throw new MeasurementError('invalid-transfer')
        await verify(context)
        return { measuredAt: (options.wallNow ?? Date.now)(), responseMs: Math.round(responseMs), responseSpreadMs: Math.round(responseSpreadMs),
          downloadMbps: downloadBytes * 8 / downloadMs / 1000, uploadMbps: uploadBytes * 8 / uploadMs / 1000,
          downloadBytes, uploadBytes }
      } catch (error) {
        if (signal.aborted) throw new MeasurementError(options.signal?.aborted ? 'cancelled' : 'timeout')
        if (error instanceof MeasurementError) throw error
        throw new MeasurementError('failed')
      } finally { this.pending = false }
    })()
    // Keep the busy guard until the transport settles, even when it ignores cancellation.
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new MeasurementError(options.signal?.aborted ? 'cancelled' : 'timeout'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try { return await Promise.race([operation, aborted]) }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  }
}
