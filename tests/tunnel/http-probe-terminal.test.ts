import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as mac from '../../sidecar/mac/vless-connector.mjs'
import * as win from '../../sidecar/win/vless-connector.mjs'
import { CONTROL_CODES } from '../../sidecar/mac/connectors.mjs'
import { startFakeSocks5Server, type FakeSocks5 } from './helpers'

const servers: Server[] = []
const sockets = new Set<Socket>()
const proxies: FakeSocks5[] = []

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const socket of sockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function target(response?: string): Promise<string> {
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.once('data', () => { if (response !== undefined) socket.end(response) })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/ip`
}

async function proxyFor(url: string): Promise<number> {
  const port = Number(new URL(url).port)
  const proxy = await startFakeSocks5Server({ [`127.0.0.1:${port}`]: ['127.0.0.1', port] })
  proxies.push(proxy)
  return proxy.port
}

// 限定旧代码的永久等待，断言仍要求真实 ConnectorError，不能把夹具超时当正确失败。
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('探测 750ms 内没有结束')), 750)
    })])
  } finally { clearTimeout(timer) }
}

const upgrade = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
const ok = (body: string) => `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`

describe.each([['mac', mac], ['win', win]] as const)('%s HTTP 探测终止', (_, connector) => {
  it('直连遇到 101 会结束失败，不因 request.close 清除超时而永久等待', async () => {
    const url = await target(upgrade)
    await expect(bounded(connector.probeDirectReachability([url], 100))).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })

  it('已有 SOCKS 代理内遇到 101 也会结束失败', async () => {
    const url = await target(upgrade)
    const port = await proxyFor(url)
    await expect(bounded(connector.probeExistingProxy({ kind: 'socks', host: '127.0.0.1', port }, [url], 100)))
      .rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })

  it('出口回显遇到 101 会结束失败，后续正常回显仍能成功', async () => {
    const bad = await target(upgrade)
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(bad), bad, 100)))
      .rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
    const good = await target(ok('203.0.113.20'))
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(good), good, 100)))
      .resolves.toEqual({ exitIp: '203.0.113.20' })
  })

  it.each(['203.0.113.20', '2001:db8::20'])('正常回显 %s 保持成功，直连也可用', async (ip) => {
    const url = await target(ok(ip))
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(url), url, 300))).resolves.toEqual({ exitIp: ip })
    await expect(bounded(connector.probeDirectReachability([url], 300))).resolves.toEqual({ direct: true })
  })

  it('正常 HTTP 响应但无 IP，保留检测服务不可用分类', async () => {
    const url = await target(ok('not-an-ip'))
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(url), url, 300)))
      .rejects.toMatchObject({ code: CONTROL_CODES.probeUnavailable })
  })

  it('出口回显正文截断时失败，不将半截 IP 判成功', async () => {
    const url = await target('HTTP/1.1 200 OK\r\nContent-Length: 30\r\n\r\n203.0.113.20')
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(url), url, 100)))
      .rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })

  it('完全没有响应时仍按请求超时结束', async () => {
    const url = await target()
    await expect(bounded(connector.probeDirectReachability([url], 100))).rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
    await expect(bounded(connector.verifyThroughProxy(await proxyFor(url), url, 100)))
      .rejects.toMatchObject({ code: CONTROL_CODES.upstreamUnreachable })
  })
})
