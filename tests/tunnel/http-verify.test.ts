import { connect, createServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function verify(port: number, timeoutMs = 100, url = new URL(`http://127.0.0.1:${String(port)}/toolbox-exit-ip`)) {
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
  return verifyHttpExitIp(socket, url, timeoutMs)
}

it('只接受 200 与合法出口 IP，并保留查询串', async () => {
  let request = ''
  const port = await fixture((socket) => {
    socket.on('data', (chunk) => { request += chunk.toString(); if (request.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\n203.0.113.42\r\n') })
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

it('解析分块正文和尾部字段，不等服务端断开连接', async () => {
  const port = await fixture((socket) => socket.once('data', () => {
    socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n203.0.\r\n')
    socket.write('6\r\n113.42\r\n0\r\nX-Probe: done\r\n\r\n')
  }))
  await expect(verify(port)).resolves.toBe('203.0.113.42')
})

it('按 Content-Length 结束读取，保留原有隧道、Host 和查询串', async () => {
  let request = ''
  const port = await fixture((socket) => socket.once('data', (chunk) => {
    request = chunk.toString()
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n203.0.113.42')
  }))
  await expect(verify(port, 100, new URL('http://exit.example.invalid/ip?format=text'))).resolves.toBe('203.0.113.42')
  expect(request).toContain('GET /ip?format=text HTTP/1.1')
  expect(request).toMatch(/host: exit\.example\.invalid/i)
})

it.each([
  'Content-Length: 100\r\n\r\n203.0.113.42',
  'Transfer-Encoding: chunked\r\n\r\nc\r\n203.0.113.42\r\n',
  'Transfer-Encoding: chunked\r\n\r\nz\r\n203.0.113.42\r\n0\r\n\r\n'
])('拒绝正文看似合法但报文不完整或畸形的响应：%s', async (body) => {
  const port = await fixture((socket) => socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\n${body}`)))
  await expect(verify(port)).rejects.toThrow()
})

it('分块解码后仍限制正文和响应头大小', async () => {
  const large = await fixture((socket) => socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n201\r\n${'x'.repeat(513)}\r\n0\r\n\r\n`)))
  await expect(verify(large)).rejects.toThrow('响应体过大')
  const headers = await fixture((socket) => socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nX-Large: ${'x'.repeat(17 * 1024)}\r\n\r\n203.0.113.42`)))
  await expect(verify(headers)).rejects.toThrow('响应头过大')
})

it('HTTPS 仍拒绝不受信任证书，并对 TLS 握手使用同一超时', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laixin-http-verify-tls-'))
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem')
    execFileSync(process.platform === 'win32' ? 'openssl' : '/usr/bin/openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'],
      { stdio: 'pipe', timeout: 10_000 })
    const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await expect(verify(port, 1000, new URL(`https://localhost:${String(port)}/ip`))).rejects.toThrow(/certificate/i)
    const held = await fixture((socket) => socket.on('data', () => undefined))
    await expect(verify(held, 30, new URL(`https://localhost:${String(held)}/ip`))).rejects.toThrow('响应超时')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
