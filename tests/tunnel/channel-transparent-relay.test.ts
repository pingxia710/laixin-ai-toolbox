import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, createServer, type Socket } from 'node:net'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, type FakeSocks5, waitFor } from './helpers'

// Real Xray, loopback destinations only. No system proxy changes or external downloads.
const hosts = ['content.dl.delivery.mp.microsoft.com', 'api.example.test'] as const

describe('DL-03: downloads use the ordinary network channel', () => {
  let dataDir: string
  let bridge: ReturnType<typeof createLocalBridge>
  let upstream: FakeSocks5
  let target: ReturnType<typeof createServer>
  const sockets = new Set<Socket>()

  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  beforeEach(async () => {
    dataDir = makeTempDir('channel-transparent-')
    target = createServer((socket) => { track(socket); socket.on('data', (chunk) => socket.write(chunk)) })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const address = target.address()
    if (!address || typeof address === 'string') throw new Error('Loopback target unavailable')
    upstream = await startFakeSocks5Server(Object.fromEntries(hosts.map((host) => [`${host}:80`, ['127.0.0.1', address.port]])))
    bridge = createLocalBridge({ listenPort: 0, dataDir, upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { protectedDirectSuffixes: [], directSuffixes: [], tunnelSuffixes: [...hosts] } })
    await bridge.listen()
  })

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    await bridge?.close()
    await upstream?.close()
    if (target?.listening) await new Promise<void>((resolve) => target.close(() => resolve()))
    removeTempDir(dataDir)
  })

  const httpConnect = (host: string): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = track(connect({ host: '127.0.0.1', port: bridge.port() }))
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')) }, 2_000)
    let response = ''
    const read = (chunk: Buffer) => {
      response += chunk.toString('latin1')
      if (!response.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.off('data', read)
      if (!/^HTTP\/1\.[01] 200 /.test(response)) { socket.destroy(); reject(new Error('CONNECT rejected')); return }
      resolve(socket)
    }
    socket.on('data', read)
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    socket.once('connect', () => {
      socket.write('CON')
      setImmediate(() => socket.write(`NECT ${host}:80 HTTP/1.1\r\nHost: ${host}:80\r\n\r\n`))
    })
  })

  it.each(hosts.flatMap((host) => ['SOCKS5', 'HTTP CONNECT'].map((protocol) => ({ host, protocol }))))(
    '$protocol to $host: 32 idle connections are admitted before any payload, then transfer and settle', async ({ host, protocol }) => {
      const opened = await Promise.allSettled(Array.from({ length: 32 }, async () => protocol === 'SOCKS5'
        ? track(await socks5Connect({ host: '127.0.0.1', port: bridge.port(), targetHost: host, targetPort: 80, timeoutMs: 2_000 }))
        : httpConnect(host)))
      expect(opened.filter((result) => result.status === 'rejected')).toHaveLength(0)
      await waitFor(() => upstream.hits().length === 32)
      expect(upstream.hits()).toHaveLength(32)
      const clients = opened.map((result) => {
        if (result.status !== 'fulfilled') throw result.reason
        return result.value
      })
      const before = bridge.traffic()
      await Promise.all(clients.map((socket, index) => new Promise<void>((resolve, reject) => {
        const payload = Buffer.alloc(8_192, index)
        let received = Buffer.alloc(0)
        const timer = setTimeout(() => reject(new Error('Echo timed out')), 2_000)
        const read = (chunk: Buffer) => {
          received = Buffer.concat([received, chunk])
          if (received.length < payload.length) return
          clearTimeout(timer)
          socket.off('data', read)
          if (!received.equals(payload)) { reject(new Error('Payload changed')); return }
          resolve()
        }
        socket.on('data', read)
        socket.write(payload)
      })))
      const after = bridge.traffic()
      expect(after.uploadBytes - before.uploadBytes).toBe(32 * 8_192)
      expect(after.downloadBytes - before.downloadBytes).toBe(32 * 8_192)
      for (const socket of clients) socket.destroy()
      await waitFor(() => bridge.traffic().activeStreams === 0)
      expect(bridge.isAlive()).toBe(true)
    })
})
