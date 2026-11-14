import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { connect, createServer, type Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { startTrafficRelay } from '../../sidecar/mac/local-bridge.mjs'
import { waitFor } from './helpers'

async function fixture(onTarget: (socket: Socket) => void) {
  const sockets = new Set<Socket>(), tracked = new Set<Socket>()
  const target = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => undefined); onTarget(socket)
  })
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const relay = await startTrafficRelay(0, (target.address() as { port: number }).port,
    { uploadBytes: 0, downloadBytes: 0, activeStreams: 0 }, tracked)
  const client = connect({ host: '127.0.0.1', port: relay.port })
  sockets.add(client); client.on('error', () => undefined)
  await once(client, 'connect')
  await waitFor(() => tracked.size === 2)
  const pair = [...tracked]
  for (const socket of pair) sockets.add(socket)
  return { client, tracked, pair, close: async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => relay.server.close(() => resolve()))
    await new Promise<void>(resolve => target.close(() => resolve()))
  } }
}

it('client closure destroys the half-open upstream before forgetting the relay pair', async () => {
  const f = await fixture(socket => { socket.on('end', () => undefined) })
  try {
    const closed = once(f.client, 'close')
    f.client.end('fixture-request')
    await closed
    await waitFor(() => f.pair.every(socket => socket.destroyed), 500)
    expect(f.tracked.size).toBe(0)
  } finally { await f.close() }
})

it('normal FIN flushes an already buffered response before closing the relay pair', async () => {
  const payload = Buffer.alloc(32 * 1024, 120)
  const f = await fixture(socket => { socket.on('data', () => socket.end(payload)) })
  const received: Buffer[] = []
  try {
    // Keep the final response in the relay's writable buffer until end() flushes it.
    f.pair[0].cork()
    f.client.on('data', (chunk: Buffer) => received.push(chunk))
    const closed = once(f.client, 'close')
    f.client.write('fixture-request')
    await closed
    expect(Buffer.concat(received).length).toBe(payload.length)
    await waitFor(() => f.pair.every(socket => socket.destroyed) && f.tracked.size === 0)
  } finally { await f.close() }
})

it('normal FIN bounds cleanup when the response buffer never finishes', async () => {
  const f = await fixture(socket => { socket.on('data', () => socket.end('response')) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // Model a writable side whose final buffer cannot finish; both sockets remain tracked.
  const end = vi.spyOn(f.pair[0], 'end').mockImplementation(() => f.pair[0])
  try {
    f.client.resume()
    const ended = once(f.pair[1], 'end')
    f.client.write('fixture-request')
    await ended
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.pair.every(socket => socket.destroyed)).toBe(true)
  } finally { end.mockRestore(); vi.useRealTimers(); await f.close() }
})

it('relay teardown preserves a full response for a slow reader', async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 120)
  const f = await fixture(socket => { socket.on('data', () => socket.end(payload)) })
  const received: Buffer[] = []
  let resume: ReturnType<typeof setTimeout> | undefined
  try {
    f.client.on('data', (chunk: Buffer) => {
      received.push(chunk); f.client.pause()
      resume = setTimeout(() => f.client.resume(), 2)
    })
    const closed = once(f.client, 'close')
    f.client.write('fixture-request')
    await closed
    const actual = Buffer.concat(received)
    expect(actual.length).toBe(payload.length)
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  } finally { clearTimeout(resume); await f.close() }
}, 10_000)
