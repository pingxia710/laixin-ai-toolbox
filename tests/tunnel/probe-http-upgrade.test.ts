// 甲-4:复用探测升级为「经该路真发一次轻量 HTTP 请求并校验响应」。
// 基线只做 TCP+TLS 握手——「放行握手、按域名掐数据」的管控网络(公司/校园防火墙)会永远判通,
// 显示已连接而 AI 软件用不了、永不自愈。桩:握手通/HTTP 断 → 必须判不通并(由守护)接管;
// 握手通/HTTP 通 → 照常复用(正向)。全部走回环假服务器,⛔ 真外网。
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as netServer, type Server as NetServer, type Socket } from 'node:net'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { probeDirectReachability, probeExistingProxy } from '../../sidecar/win/vless-connector.mjs'

const servers: Array<NetServer | HttpServer> = []
const openSockets = new Set<Socket>()
const track = (socket: Socket) => { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)) }
afterEach(async () => {
  // net.Server 没有 closeAllConnections:接受的连接得自己毁,半开连接会卡住 close()。
  for (const socket of openSockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()) })
})

const listen = (server: NetServer | HttpServer) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
})

/** 握手能过、数据被掐:接受连接后一个字节都不回(防火墙哑弹形状)。 */
async function silentServer(): Promise<number> {
  const server = netServer((socket: Socket) => { track(socket); socket.on('error', () => undefined) })
  servers.push(server)
  return listen(server)
}

/** 收到任何字节立刻拆连接(防火墙 RST 形状)。 */
async function resetOnDataServer(): Promise<number> {
  const server = netServer((socket: Socket) => { track(socket); socket.on('data', () => socket.destroy()); socket.on('error', () => undefined) })
  servers.push(server)
  return listen(server)
}

/** 正常 HTTP 应答(状态 200,正文一小段)。 */
async function okHttpServer(): Promise<number> {
  const server = httpServer((req, res) => { res.writeHead(200); res.end('ok') })
  server.on('connection', track)
  servers.push(server)
  return listen(server)
}

/** 假 HTTP CONNECT 代理:记录被请求的目标,按 variant 决定隧道内行为。 */
async function connectProxyStub(variant: 'silent' | 'answer' | 'answer-first-host-only'): Promise<{ port: number; targets: string[] }> {
  const targets: string[] = []
  let answeredHosts = 0
  const server = netServer((socket: Socket) => {
    track(socket)
    socket.on('error', () => undefined)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const line = buffer.split('\r\n')[0]
      const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line)
      if (match === null) { socket.destroy(); return }
      targets.push(match[1])
      // CONNECT 应答 200 = 隧道建立
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      buffer = buffer.slice(end + 4)
      socket.removeAllListeners('data')
      const answerable = variant === 'answer' || (variant === 'answer-first-host-only' && answeredHosts === 0)
      answeredHosts += 1
      if (!answerable) return // 隧道建立后对数据装哑(掐数据形状)
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
      })
    })
  })
  servers.push(server)
  return { port: await listen(server), targets }
}

describe('直连复用探测:握手通不算数,要真拿到 HTTP 响应(甲-4)', () => {
  it('TCP 通但 HTTP 永远不应答(掐数据)→ 判不通(基线:连上就算通)', async () => {
    const port = await silentServer()
    await expect(probeDirectReachability([`http://127.0.0.1:${port}/`], 400)).rejects.toThrow()
  })

  it('TCP 通、收到数据立刻拆(防火墙 RST)→ 判不通', async () => {
    const port = await resetOnDataServer()
    await expect(probeDirectReachability([`http://127.0.0.1:${port}/`], 400)).rejects.toThrow()
  })

  it('HTTP 真应答 → 照常判通(正向,⛔ 升级把好事误杀)', async () => {
    const port = await okHttpServer()
    await expect(probeDirectReachability([`http://127.0.0.1:${port}/`], 800)).resolves.toMatchObject({ direct: true })
  })

  it('两个探测点一个应答一个被掐 → 判不通(一个通可能只是运气)', async () => {
    const good = await okHttpServer()
    const choked = await silentServer()
    await expect(probeDirectReachability([`http://127.0.0.1:${good}/`, `http://127.0.0.1:${choked}/`], 400)).rejects.toThrow()
  })
})

describe('已有代理复用探测:经该路真发请求到 AI 服务才算数(甲-4)', () => {
  it('CONNECT 隧道建了但数据被掐 → 判不通(基线:CONNECT 通就算能用)', async () => {
    const proxy = await connectProxyStub('silent')
    const target = await okHttpServer()
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port },
      [`http://127.0.0.1:${target}/`], 400)).rejects.toThrow()
    expect(proxy.targets).toEqual([`127.0.0.1:${target}`]) // 正向证据:确实经该路探过
  })

  it('CONNECT 通、隧道内 HTTP 真应答 → 照常复用(正向)', async () => {
    const proxy = await connectProxyStub('answer')
    const target = await okHttpServer()
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port },
      [`http://127.0.0.1:${target}/`], 800)).resolves.toMatchObject({ url: `http://127.0.0.1:${target}/` })
  })

  it('经该路到得了 A 到不了 B(按域名掐)→ 判不通(基线任一探测点通就算通)', async () => {
    const proxy = await connectProxyStub('answer-first-host-only')
    const good = await okHttpServer()
    const choked = await silentServer()
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port },
      [`http://127.0.0.1:${good}/`, `http://127.0.0.1:${choked}/`], 400)).rejects.toThrow()
    expect(proxy.targets).toEqual([`127.0.0.1:${good}`, `127.0.0.1:${choked}`]) // 两个都真探过
  })

  it('缺省探测点就是 AI 服务,⛔ 退回通用 204 点(公司网放行 Google 拦 AI 的形状)', async () => {
    const proxy = await connectProxyStub('silent')
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, undefined, 300)).rejects.toThrow()
    // 掐数据形状下首个目标必失败;断言探的第一个目标是 chatgpt 而不是 gstatic(基线红)
    expect(proxy.targets[0]).toBe('chatgpt.com:443')
  })
})
