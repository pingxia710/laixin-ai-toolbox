import { describe, expect, it } from 'vitest'
import { MeasurementError, NetworkQualityMeasurement, type MeasurementTransport } from '../../app/main/network-quality/measurement'

function fixture(): MeasurementTransport {
  return { context: async () => 'verified-path', response: async () => undefined,
    download: async size => size, upload: async size => size }
}

describe('network quality measurement', () => {
  it('reports measured byte rates with the verified path', async () => {
    let time = 0
    const result = await new NetworkQualityMeasurement().run(fixture(), { bytes: 1_000_000, timeoutMs: 1000,
      now: () => { time += 1000; return time }, wallNow: () => 123 })
    expect(result).toEqual({ measuredAt: 123, responseMs: 1000, responseSpreadMs: 0, downloadMbps: 8, uploadMbps: 8,
      downloadBytes: 1_000_000, uploadBytes: 1_000_000 })
  })

  it('refuses to attribute results to an unavailable or changed path', async () => {
    const service = new NetworkQualityMeasurement()
    await expect(service.run({ ...fixture(), context: async () => undefined }, { bytes: 1, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'path-unavailable' })
    let reads = 0
    await expect(service.run({ ...fixture(), context: async () => ++reads === 1 ? 'old' : 'new' },
      { bytes: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'path-changed' })
  })

  it('does not accept partial downloads or unconfirmed uploads', async () => {
    for (const partial of ['download', 'upload'] as const) {
      const transport = { ...fixture(), [partial]: async () => 4 }
      await expect(new NetworkQualityMeasurement().run(transport, { bytes: 5, timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: 'invalid-transfer' })
    }
  })

  it('rejects overlapping runs and allows a later run after cancellation', async () => {
    const service = new NetworkQualityMeasurement()
    const controller = new AbortController()
    let unblock!: () => void
    const transport = { ...fixture(), response: async () => new Promise<void>(resolve => { unblock = resolve }) }
    const first = service.run(transport, { bytes: 1, timeoutMs: 1000, signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    await expect(service.run(fixture(), { bytes: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'busy' })
    controller.abort(); unblock()
    await expect(first).rejects.toBeInstanceOf(MeasurementError)
    await expect(service.run(fixture(), { bytes: 1, timeoutMs: 1000 })).resolves.toMatchObject({ downloadBytes: 1 })
  })

  it('returns on timeout but keeps the guard until a stuck operation actually ends', async () => {
    const service = new NetworkQualityMeasurement()
    let release!: () => void
    const stalled = { ...fixture(), response: async () => new Promise<void>(resolve => { release = resolve }) }
    const first = service.run(stalled, { bytes: 1, timeoutMs: 20 })
    await expect(first).rejects.toMatchObject({ code: 'timeout' })
    await expect(service.run(fixture(), { bytes: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'busy' })
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(service.run(fixture(), { bytes: 1, timeoutMs: 1000 })).resolves.toMatchObject({ uploadBytes: 1 })
  })

})
