import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { verifyHttpExitIp } from '../../sidecar/shared/http-verify.mjs'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function fixture(response: (socket: Socket) => void) {
  const server = createServer(response)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as { port: number }).port
}

async function verify(port: number, timeoutMs = 100) {
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
  return verifyHttpExitIp(socket, new URL(`http://127.0.0.1:${String(port)}/toolbox-exit-ip`), timeoutMs)
}

it('只接受 200 与合法出口 IP，并保留查询串', async () => {
  let request = ''
  const port = await fixture((socket) => {
    socket.on('data', (chunk) => { request += chunk.toString(); if (request.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n203.0.113.42\r\n') })
  })
  await expect(verify(port)).resolves.toBe('203.0.113.42')
  expect(request).toContain('GET /toolbox-exit-ip HTTP/1.1')
})

it.each(['204 No Content', '500 Server Error'])('拒绝非 200 响应: %s', async (status) => {
  const port = await fixture((socket) => socket.once('data', () => socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`)))
  await expect(verify(port)).rejects.toThrow('状态码不是 200')
})

it('拒绝非 IP、超大正文与一直不结束的响应', async () => {
  const badBody = await fixture((socket) => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\nnot-an-ip')))
  await expect(verify(badBody)).rejects.toThrow('不是出口 IP')
  const large = await fixture((socket) => socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(513)}`)))
  await expect(verify(large)).rejects.toThrow('响应体过大')
  const held = await fixture((socket) => socket.once('data', () => undefined))
  await expect(verify(held, 30)).rejects.toThrow('响应超时')
})
