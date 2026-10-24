import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { socks5Connect as macConnect } from '../../sidecar/mac/socks5.mjs'
import { socks5Connect as winConnect } from '../../sidecar/win/socks5.mjs'

const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function proxy(reply: (socket: Socket) => void, greeting = Buffer.from([5, 0])) {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(greeting)
      socket.once('data', () => reply(socket))
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return (server.address() as { port: number }).port
}

const replies = [
  ['IPv4', Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])],
  ['IPv6', Buffer.from([5, 0, 0, 4, ...Array<number>(16).fill(0), 0, 80])],
  ['short domain', Buffer.from([5, 0, 0, 3, 1, 97, 0, 80])],
  ['long domain', Buffer.from([5, 0, 0, 3, 255, ...Array<number>(255).fill(97), 0, 80])]
] as const

async function body(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of socket) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe.each([['macOS', macConnect], ['Windows', winConnect]] as const)('%s SOCKS5 reply', (_platform, socks5Connect) => {
  const connect = async (port: number, timeoutMs = 500) => {
    const socket = await socks5Connect({ host: '127.0.0.1', port, targetHost: 'target.invalid', targetPort: 80, timeoutMs })
    sockets.add(socket)
    return socket
  }

  it.each(replies)('%s 回复与业务数据合包时，数据完整留给调用者', async (_name, reply) => {
    const payload = Buffer.from('first payload\u0000\u00ff')
    const port = await proxy((socket) => socket.end(Buffer.concat([reply, payload])))
    const socket = await connect(port)
    expect(socket.listenerCount('readable')).toBe(0)
    expect(await body(socket)).toEqual(payload)
  })

  it.each(replies)('%s 回复分两段到达时，必须等完整地址和端口', async (_name, reply) => {
    let deliver!: (socket: Socket) => void
    const received = new Promise<Socket>((resolve) => { deliver = resolve })
    const port = await proxy(deliver)
    let settled = false
    const pending = connect(port).then((socket) => { settled = true; return socket })
    const peer = await received
    // IPv6/长域名先给 10 字节；短回复先给到倒数一个字节。
    const split = Math.min(10, reply.length - 1)
    peer.write(reply.subarray(0, split))
    await delay(30)
    const early = settled
    peer.end(Buffer.concat([reply.subarray(split), Buffer.from('payload')]))
    const socket = await pending
    expect(early).toBe(false)
    expect(await body(socket)).toEqual(Buffer.from('payload'))
  })

  it.each([
    ['version', [4, 0, 0, 1, 0, 0, 0, 0, 0, 0]],
    ['reserved', [5, 0, 1, 1, 0, 0, 0, 0, 0, 0]],
    ['address type', [5, 0, 0, 9, 0, 0, 0, 0, 0, 0]],
    ['empty domain', [5, 0, 0, 3, 0, 0, 0, 0, 0, 0]],
    ['rejected', [5, 5, 0, 1]],
    ['truncated', [5, 0, 0, 4, 0, 0, 0, 0, 0, 0]]
  ] as const)('拒绝 %s 回复而不是成功或等超时', async (_name, bytes) => {
    const port = await proxy((socket) => socket.end(Buffer.from(bytes)))
    const result = await connect(port).then((socket) => { socket.destroy(); return 'accepted' }, (error: Error) => error.message)
    expect(result).not.toBe('accepted')
    expect(result).not.toContain('超时')
  })

  it('无认证被拒绝时立即失败', async () => {
    const port = await proxy(() => {}, Buffer.from([5, 255]))
    await expect(connect(port)).rejects.toThrow('无认证方式被拒')
  })

  it('逐字节的 IPv6 握手后，完整交付超过缓冲水位的首段数据', async () => {
    const payload = Buffer.alloc(128 * 1024, 123)
    const port = await proxy((socket) => {
      void (async () => {
        for (const byte of replies[1][1]) { socket.write(Buffer.from([byte])); await delay(1) }
        socket.end(payload)
      })()
    })
    expect(await body(await connect(port))).toEqual(payload)
  })

  it('半途关闭立即失败；没有响应才等握手超时', async () => {
    const closed = await proxy((socket) => socket.end())
    await expect(connect(closed)).rejects.toThrow('提前结束')
    const silent = await proxy(() => {})
    await expect(connect(silent, 40)).rejects.toThrow('握手超时')
  })

  it('成功后不保留握手错误监听或定时器，后续 data 消费正常', async () => {
    const port = await proxy((socket) => { socket.write(replies[0][1]); socket.once('data', () => socket.end('later payload')) })
    const socket = await connect(port, 50)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('readable')).toBe(0)
    await delay(75)
    expect(socket.destroyed).toBe(false)
    const response = once(socket, 'data')
    socket.write('request')
    expect((await response)[0].toString()).toBe('later payload')
  })
})
