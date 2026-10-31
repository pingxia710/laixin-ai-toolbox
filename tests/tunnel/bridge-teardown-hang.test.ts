import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { createLocalBridge, startTrafficRelay } from '../../sidecar/mac/local-bridge.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, type FakeSocks5 } from './helpers'

// N-76:2026-10-08 内部复查复现的「上游异常关闭后 bridge.close() 等待 31s 不完成」。
// 根因:任一端关闭时 forget() 把两端同时移出清理集合,而干净收尾(FIN 级联)只会
// 半关另一端——它还开着、却已不在集合里,closeTrafficRelay 销不到它,server.close()
// 只能等对端自己超时。契约:一端关闭(含上游 FIN)必须真的销毁对端,半开连接两侧都不许滞留。
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

// 实测(xray 异步拨上游):socks5Connect 返回时上游连接可能尚未出现,~150ms 后才在途。
async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  for (let elapsed = 0; elapsed < deadlineMs; elapsed += 50) {
    if (predicate()) return true
    await delay(50)
  }
  return predicate()
}

describe('桥收尾:一端关闭必须真的销毁对端(N-76 半开连接不留)', () => {
  let dataDir: string
  let upstream: FakeSocks5
  let target: Server
  // 目标站行为由用例切换:false=接受后保持连接;true=立即干净收尾(FIN)。
  let targetEndsOnAccept: boolean

  beforeEach(async () => {
    dataDir = makeTempDir('toolbox-n76-')
    targetEndsOnAccept = false
    target = createServer((socket) => {
      if (targetEndsOnAccept) socket.end('N76-END')
    })
    await new Promise<void>((resolveListen) => target.listen(0, '127.0.0.1', resolveListen))
    const targetPort = (target.address() as { port: number }).port
    upstream = await startFakeSocks5Server({ 'hang.test:80': ['127.0.0.1', targetPort] })
  })

  afterEach(async () => {
    const bridge = bridgeHolder
    bridgeHolder = undefined
    // 兜底:即使被测行为悬挂,也别让收尾钩子把整个文件拖死。
    if (bridge !== undefined) await Promise.race([bridge.close().catch(() => undefined), delay(5_000)])
    await upstream.close()
    await new Promise<void>((resolveClose) => target.close(() => resolveClose()))
    removeTempDir(dataDir)
  })

  let bridgeHolder: ReturnType<typeof createLocalBridge> | undefined
  async function start() {
    const bridge = createLocalBridge({
      listenPort: 0,
      dataDir,
      upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { protectedDirectSuffixes: ['deepseek.com'], directSuffixes: ['cn'], tunnelSuffixes: ['localhost'] }
    })
    bridgeHolder = bridge
    await bridge.listen()
    return bridge
  }

  it('端到端:上游干净收尾后,还开着的客户端连接被桥主动拆掉,close() 有界完成', { timeout: 20_000 }, async () => {
    targetEndsOnAccept = true
    const live = await start()
    const client: Socket = await socks5Connect({ host: '127.0.0.1', port: live.port(), targetHost: 'hang.test', targetPort: 80 })
    // 桥强拆对端时对侧可能收到 RST,⛔ 让它冒成未捕获异常污染结果。
    client.on('error', () => undefined)
    // socks5Connect 以暂停模式读握手;不恢复流动,'end' 事件不会触发。
    client.resume()
    // close 可能与 end 同一拍到达,监听必须先于等待 end 挂上,否则永远等不到。
    const closed = once(client, 'close')
    await once(client, 'end')
    // FIN 级联已到测试侧;留一段「什么都不该发生」的窗口给未修复代码。
    await delay(300)

    // 断言A:客户端这半条连接被桥主动拆除。修复前:对端早被 forget 除名,没人拆它,
    // 连接停在半开直到对端自己超时——这正是 close() 悬挂 31s 的那半条。
    const tornInTime = await Promise.race([closed.then(() => true), delay(2_000).then(() => false)])
    if (!tornInTime) client.destroy() // 红跑自愈:别把收尾拖进悬挂
    expect(tornInTime).toBe(true)

    const closing = live.close()
    const closedInTime = await Promise.race([closing.then(() => true), delay(3_000).then(() => false)])
    if (!closedInTime) client.destroy()
    await closing.catch(() => undefined)
    expect(closedInTime).toBe(true)
    expect(live.isAlive()).toBe(false)
  })

  // 下面两条不经 xray,直接对转发对本身验证配对拆毁语义:xray 对出口连接的回收
  // 有自身 ~1s 的节奏,透过它观察无法区分「桥立即拆」与「自然消亡」。
  it('直测:上游干净收尾(FIN),服务端侧立即拆对,server.close 有界完成', { timeout: 10_000 }, async () => {
    const upstreamSide = createServer(() => undefined)
    await new Promise<void>((resolveListen) => upstreamSide.listen(0, '127.0.0.1', resolveListen))
    const upstreamPort = (upstreamSide.address() as { port: number }).port
    let upstreamSocket: Socket | undefined
    upstreamSide.once('connection', (socket) => { upstreamSocket = socket })
    const relay = await startTrafficRelay(0, upstreamPort, { uploadBytes: 0, downloadBytes: 0, activeStreams: 0 }, new Set<Socket>())
    try {
      // allowHalfOpen 客户端=undici keep-alive 的真实形状:收到 FIN 只到 'end',
      // 半开不自毁。桥若不主动拆它,它就一直是 server.close() 等不到的那半条。
      const client = connect({ host: '127.0.0.1', port: relay.port, allowHalfOpen: true })
      client.on('error', () => undefined)
      client.resume()
      if (!await waitFor(() => upstreamSocket !== undefined, 2_000)) throw new Error('上游侧未见到连接')
      upstreamSocket!.end('N76-END')
      // 修复前:FIN 只被当成「这条回答结束」,服务端侧客户端 socket 被 forget 除名后
      // 没人销毁,一直等对端自己超时——即 2026-10-08 复现的 close() 收尾悬挂。
      // 对端 allowHalfOpen socket 收到 FIN 后本就半开滞留(TCP 语义,强拆不掉),
      // 所以判据是服务端侧收尾有界,而不是对端自毁。
      const closing = new Promise<void>((resolveClose) => relay.server.close(() => resolveClose()))
      const closedInTime = await Promise.race([closing.then(() => true), delay(1_000).then(() => false)])
      if (!closedInTime) client.destroy() // 红跑自愈
      await closing
      expect(closedInTime).toBe(true)
    } finally {
      await new Promise<void>((resolveClose) => relay.server.close(() => resolveClose()))
      await new Promise<void>((resolveClose) => upstreamSide.close(() => resolveClose()))
    }
  })

  it('直测:上游只半关(FIN 但不关闭),桥也把客户端半条拆掉——2026-10-08 收尾悬挂的真实形状', { timeout: 10_000 }, async () => {
    // allowHalfOpen=true:end() 只发 FIN,服务器侧 socket 不随之关闭——上游连接停在
    // 半开,上游 'close' 永远不来,只有上游 FIN 本身能触发拆对。
    const upstreamSide = createServer({ allowHalfOpen: true }, () => undefined)
    await new Promise<void>((resolveListen) => upstreamSide.listen(0, '127.0.0.1', resolveListen))
    const upstreamPort = (upstreamSide.address() as { port: number }).port
    let upstreamSocket: Socket | undefined
    upstreamSide.once('connection', (socket) => { upstreamSocket = socket })
    const relay = await startTrafficRelay(0, upstreamPort, { uploadBytes: 0, downloadBytes: 0, activeStreams: 0 }, new Set<Socket>())
    try {
      // allowHalfOpen 客户端=undici keep-alive 的真实形状:收到 FIN 只到 'end',
      // 半开不自毁。桥若不主动拆它,它就一直是 server.close() 等不到的那半条。
      const client = connect({ host: '127.0.0.1', port: relay.port, allowHalfOpen: true })
      client.on('error', () => undefined)
      client.resume()
      if (!await waitFor(() => upstreamSocket !== undefined, 2_000)) throw new Error('上游侧未见到连接')
      upstreamSocket!.end('N76-END')
      upstreamSocket!.on('error', () => undefined)
      // 同上:上游 'close' 永远不来,只有上游 FIN 本身能触发服务端侧拆对;
      // 对端半开 socket 强拆不掉(TCP 语义),判据是 server.close 有界。
      // 修复前这对就是 close() 收尾悬挂 31s 的原始形状。
      const closing = new Promise<void>((resolveClose) => relay.server.close(() => resolveClose()))
      const closedInTime = await Promise.race([closing.then(() => true), delay(1_000).then(() => false)])
      if (!closedInTime) client.destroy() // 红跑自愈
      await closing
      expect(closedInTime).toBe(true)
    } finally {
      upstreamSocket?.destroy()
      await new Promise<void>((resolveClose) => relay.server.close(() => resolveClose()))
      await new Promise<void>((resolveClose) => upstreamSide.close(() => resolveClose()))
    }
  })
})
