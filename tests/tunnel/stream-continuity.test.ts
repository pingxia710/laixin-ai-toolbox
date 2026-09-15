// D3(0.4.9 网络组):长连接与持续传输。客户最常见的描述是「AI 回答到一半断掉」——
// 那是一条已经在回数据的长连接被切断。这里在真实 Xray + 假上游上实测本机 relay
// 对三种收尾的判定:正常收尾不计数、通道没了算「被切断」、我们自己停算「主动拆」。
// ⛔ 记网址、主机名与任何正文,只数次数。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, createServer, type Socket } from 'node:net'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, type FakeSocks5 } from './helpers'

/** 一个「流式回答」样子的目标:先回一段,再按 finish 指定的方式收尾。 */
async function startStreamingTarget(finish: 'clean' | 'reset' | 'hold'): Promise<{ port: number; close: () => Promise<void>; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: 第一段\n\n')
      if (finish === 'clean') setTimeout(() => socket.end('data: 收尾\n\n'), 50)
      if (finish === 'reset') setTimeout(() => socket.destroy(), 50)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('目标端口未就绪')
  return {
    port: address.port,
    sockets,
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) })
  }
}

function requestThroughRelay(relayPort: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: relayPort })
    let buffer = Buffer.alloc(0)
    socket.on('error', () => undefined)
    socket.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]) })
    socket.on('close', () => resolve(buffer))
    socket.on('connect', () => {
      socket.write('GET http://stream.test/answer HTTP/1.1\r\nHost: stream.test\r\nConnection: close\r\n\r\n')
    })
  })
}

describe('流式长连接的断流计数（真实 Xray 回环，⛔ 外网）', () => {
  let dataDir: string
  let upstream: FakeSocks5 | undefined
  let target: Awaited<ReturnType<typeof startStreamingTarget>> | undefined
  let bridge: ReturnType<typeof createLocalBridge> | undefined
  beforeEach(() => { dataDir = makeTempDir('toolbox-stream-') })
  afterEach(async () => {
    await bridge?.close(); bridge = undefined
    await upstream?.close(); upstream = undefined
    await target?.close(); target = undefined
    removeTempDir(dataDir)
  })

  async function start(finish: 'clean' | 'reset' | 'hold', idleStreamMs?: number) {
    target = await startStreamingTarget(finish)
    upstream = await startFakeSocks5Server({ 'stream.test:80': ['127.0.0.1', target.port] })
    bridge = createLocalBridge({
      listenPort: 0, dataDir, upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { protectedDirectSuffixes: [], directSuffixes: [], tunnelSuffixes: [] },
      ...(idleStreamMs === undefined ? {} : { idleStreamMs })
    })
    await bridge.listen()
    return bridge
  }

  it('回答正常收尾:在途流销账归零', async () => {
    const live = await start('clean')
    const body = await requestThroughRelay(live.port())
    expect(body.toString('utf8')).toContain('第一段')
    expect(live.traffic().activeStreams).toBe(0)
  })

  it('回答正在回数据时:这条连接算一条在途流(「回答到一半」就是它)', async () => {
    const live = await start('hold')
    const pending = requestThroughRelay(live.port())
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(live.traffic().downloadBytes).toBeGreaterThan(0)
    expect(live.traffic().activeStreams).toBe(1)

    await live.close()
    await pending
    bridge = undefined
  })

  // 上线检查 §4-3:relay 与 xray 之间走的是 SOCKS5,xray 的问候应答(05 00)就是上游回的
  // 第一个字节。原来「回过第一个字节即在途」于是把**任何握手完成的连接**都算成「正在回答」,
  // 包括刚握完手还没发请求的、以及回答早就回完只是没关的 keep-alive 连接。
  it('SOCKS 握手应答不算回答:握完手还没发请求的连接计 0', async () => {
    const live = await start('hold')
    const socket = connect({ host: '127.0.0.1', port: live.port() })
    socket.on('error', () => undefined)
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write(Buffer.from([5, 1, 0])) // 只发问候,不发 CONNECT
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(live.traffic().downloadBytes).toBeGreaterThan(0) // 上游确实回了字节(问候应答)
    expect(live.traffic().activeStreams).toBe(0) // 但那不是回答

    socket.destroy()
  })

  it('CONNECT 应答也不算回答:连上目标、正文一个字节没回时计 0', async () => {
    const live = await start('hold')
    const socket = connect({ host: '127.0.0.1', port: live.port() })
    socket.on('error', () => undefined)
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write(Buffer.from([5, 1, 0]))
    await new Promise((resolve) => setTimeout(resolve, 150))
    // CONNECT stream.test:80(域名形态),但不发 HTTP 请求 → 目标不会回正文
    const host = Buffer.from('stream.test')
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]))
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(live.traffic().activeStreams).toBe(0)

    socket.destroy()
  })

  it('回答回完之后连接空闲下来:过了空闲窗口就不再算「正在回答」', async () => {
    const live = await start('clean', 200) // 空闲窗口压到 200ms,⛔ 让用例等 15 秒
    const body = await requestThroughRelay(live.port())
    expect(body.toString('utf8')).toContain('第一段')

    const idle = connect({ host: '127.0.0.1', port: live.port() })
    idle.on('error', () => undefined)
    await new Promise((resolve) => idle.once('connect', resolve))
    idle.write(Buffer.from([5, 1, 0]))
    await new Promise((resolve) => setTimeout(resolve, 500)) // 超过空闲窗口

    expect(live.traffic().activeStreams).toBe(0)
    idle.destroy()
  })

  // 验收窗给的事实(0.4.8 收敛期实测):包里 xray 26.6.1 的 socks 入站**也接 HTTP 代理请求**,
  // 所以实际客户连接大多是 HTTP CONNECT 形态——上游先回一条「HTTP/1.1 200 Connection established」,
  // 那是「隧道建好了」,不是回答。它与 SOCKS 问候应答是同一类,必须一起吃掉。
  // 难点:CONNECT 应答与「普通代理 GET 的回答」开头都是 HTTP/1.1 200,只能看客户端那一行请求。
  async function connectTunnel(relayPort: number) {
    const socket = connect({ host: '127.0.0.1', port: relayPort })
    socket.on('error', () => undefined)
    await new Promise((resolve) => socket.once('connect', resolve))
    const established = new Promise<string>((resolve) => {
      let head = ''
      socket.on('data', (chunk: Buffer) => { head += chunk.toString('utf8'); if (head.includes('\r\n\r\n')) resolve(head) })
    })
    socket.write('CONNECT stream.test:80 HTTP/1.1\r\nHost: stream.test:80\r\n\r\n')
    return { socket, established }
  }

  it('HTTP CONNECT 的 200 应答不算回答:隧道建好后空闲计 0', async () => {
    const live = await start('hold')
    const tunnel = await connectTunnel(live.port())
    const head = await tunnel.established
    expect(head).toMatch(/^HTTP\/1\.[01] 200/)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(live.traffic().downloadBytes).toBeGreaterThan(0) // 200 应答确实回过字节
    expect(live.traffic().activeStreams).toBe(0) // 但那是「隧道建好了」,不是回答

    tunnel.socket.destroy()
  })

  it('HTTP CONNECT 隧道里回答回到一半被掐:计 1', async () => {
    const live = await start('hold')
    const tunnel = await connectTunnel(live.port())
    await tunnel.established
    tunnel.socket.write('GET /answer HTTP/1.1\r\nHost: stream.test\r\n\r\n')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(live.traffic().activeStreams).toBe(1)

    tunnel.socket.destroy()
  })

  it('普通代理 GET(非 CONNECT)的回答从第一个字节就算正文,⛔ 被当成握手掐掉', async () => {
    const live = await start('hold')
    const pending = requestThroughRelay(live.port())
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(live.traffic().activeStreams).toBe(1)

    await live.close()
    await pending
    bridge = undefined
  })

  it('还没回数据的连接不算在途流:⛔ 把连上就算成「回答中」', async () => {
    const live = await start('hold')
    const idle = connect({ host: '127.0.0.1', port: live.port() })
    idle.on('error', () => undefined)
    await new Promise((resolve) => idle.once('connect', resolve))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(live.traffic().activeStreams).toBe(0)

    idle.destroy()
  })
})
