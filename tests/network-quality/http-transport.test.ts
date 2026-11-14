import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { NetworkQualityMeasurement } from '../../app/main/network-quality/measurement'
import { httpMeasurementTransport } from '../../app/main/network-quality/http-transport'

let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
})

describe('network measurement over a real isolated HTTP server', () => {
  it('counts actual transferred bytes and receives upload confirmation', async () => {
    server = createServer((request, response) => {
      if (request.url === '/v1/network/quality/response') { response.writeHead(204).end(); return }
      if (request.url === '/v1/network/quality/download') {
        const size = 262144
        response.writeHead(200, { 'cache-control': 'no-store' }).end(randomBytes(size)); return
      }
      if (request.url === '/v1/network/quality/upload') {
        let bytes = 0
        request.on('data', chunk => { bytes += (chunk as Buffer).length })
        request.on('end', () => response.writeHead(204, { 'x-measurement-received-bytes': String(bytes) }).end())
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_INVALID')
    const transport = httpMeasurementTransport({ origin: `http://127.0.0.1:${String(address.port)}`,
      fetch, accessToken: 'fixture', sessionId: '11111111-1111-4111-8111-111111111111', context: async () => 'fixture-route-generation-1' })
    const result = await new NetworkQualityMeasurement().run(transport, { bytes: 262144, timeoutMs: 5000 })
    expect(result.downloadBytes).toBe(262144)
    expect(result.uploadBytes).toBe(262144)
    expect(result.downloadMbps).toBeGreaterThan(0)
    expect(result.uploadMbps).toBeGreaterThan(0)
  })

  it('rejects remote unencrypted origins and userinfo', () => {
    for (const origin of ['http://example.com', 'https://user:pass@example.com']) {
      expect(() => httpMeasurementTransport({ origin, fetch, accessToken: 'fixture', sessionId: '11111111-1111-4111-8111-111111111111', context: async () => 'route' })).toThrow('MEASUREMENT_ORIGIN_INVALID')
    }
  })
})

describe('network interruption', () => {
  it('returns timeout rather than a made-up value when the server stalls', async () => {
    server = createServer(() => { /* Intentionally no response. */ })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_INVALID')
    const transport = httpMeasurementTransport({ origin: `http://127.0.0.1:${String(address.port)}`,
      fetch, accessToken: 'fixture', sessionId: '11111111-1111-4111-8111-111111111111', context: async () => 'fixture-route-generation-1' })
    await expect(new NetworkQualityMeasurement().run(transport, { bytes: 1024, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'timeout' })
    server.closeAllConnections()
  })
})
