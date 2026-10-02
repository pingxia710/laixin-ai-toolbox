import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as mac from '../../sidecar/mac/vless-connector.mjs'
import * as win from '../../sidecar/win/vless-connector.mjs'
import { CONTROL_CODES } from '../../sidecar/mac/connectors.mjs'

const servers: Server[] = []
const sockets = new Set<Socket>()
const timers = new Set<ReturnType<typeof setTimeout>>()
afterEach(async () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const socket of sockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

type Mode = 'empty-close' | 'partial-close' | 'reset' | 'deny' | 'oversized' | 'silent' | 'ok' | 'split' | 'tunnel-close' | 'tunnel-silent'
async function proxy(mode: Mode): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffer = ''
    const handshake = (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      requests.push(buffer)
      socket.off('data', handshake)
      if (mode === 'empty-close') { socket.end(); return }
      if (mode === 'partial-close') { socket.end('HTTP/1.1 200 Connection Established\r\n'); return }
      if (mode === 'reset') { socket.resetAndDestroy(); return }
      if (mode === 'deny') { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
      if (mode === 'oversized') { socket.write('X'.repeat(8193)); return }
      if (mode === 'silent') return
      socket.once('data', () => {
        if (mode === 'tunnel-close') socket.end()
        else if (mode !== 'tunnel-silent') socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
      })
      if (mode === 'split') {
        socket.write('HTTP/1.1 200 Connection Established\r\n')
        const timer = setTimeout(() => { timers.delete(timer); socket.write('\r\n') }, 20)
        timers.add(timer)
      } else socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    }
    socket.on('data', handshake)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, requests }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('已关闭的代理 750ms 内没有结束')), 750)
    })])
  } finally { clearTimeout(timer) }
}

describe.each([['mac', mac], ['win', win]] as const)('%s HTTP CONNECT 终止', (_, connector) => {
  const url = 'http://target.invalid/check'
  const check = async (mode: Mode, timeoutMs = 5_000) => {
    const existing = await proxy(mode)
    const operation = connector.probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: existing.port }, [url], timeoutMs)
    return { existing, operation }
  }

  it.each(['empty-close', 'partial-close', 'reset'] as const)('%s 及时失败，不等待默认 5 秒', async (mode) => {
    const { existing, operation } = await check(mode)
    await expect(bounded(operation)).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
    expect(existing.requests[0]).toContain('CONNECT target.invalid:80 HTTP/1.1')
  })

  it.each(['deny', 'oversized'] as const)('%s 仍正确拒绝', async (mode) => {
    const { operation } = await check(mode)
    await expect(bounded(operation)).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })

  it('一直没有应答仍按超时失败', async () => {
    const { operation } = await check('silent', 100)
    await expect(bounded(operation)).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })

  it.each(['ok', 'split'] as const)('%s 握手成功后 HTTP 检测继续成功', async (mode) => {
    const { existing, operation } = await check(mode, 300)
    await expect(bounded(operation)).resolves.toEqual({ url })
    expect(existing.requests).toHaveLength(1)
  })

  it.each(['tunnel-close', 'tunnel-silent'] as const)('%s 不因握手成功而误判整个代理可用', async (mode) => {
    const { operation } = await check(mode, 100)
    await expect(bounded(operation)).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })
})
