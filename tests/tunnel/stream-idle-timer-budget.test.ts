// P3(网络数据面优化):在途流空闲定时器节流。upstream 'data' 每个 chunk 原都 clearTimeout
// +setTimeout 重挂(64KB 流式 ≈ 320 次/秒);改后仅当剩余窗口 < 一半才重挂(记 armedAt 时间戳)。
// 无现成时钟注入,用测试侧对全局 setTimeout 的计数探针按 delay=本用例独有的 idleStreamMs 过滤
// 做可红断言。变异自证:恢复每 chunk 重挂 → 计数 20 → 红。等价性锚:窗口过后 activeStreams 归零。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, waitFor, type FakeSocks5 } from './helpers'

const IDLE_MS = 1_234 // 本用例独有值:计数探针按 delay 过滤,⛔ 撞上其他内部定时器
const CHUNKS = 20
const CHUNK_SPACING_MS = 10

describe('在途流空闲定时器节流', () => {
  let dataDir: string
  let bridge: ReturnType<typeof createLocalBridge> | undefined
  let upstream: FakeSocks5 | undefined
  let target: ReturnType<typeof createServer> | undefined
  const targetSockets = new Set<Socket>()

  beforeEach(async () => {
    dataDir = makeTempDir('netopt-idle-')
    target = createServer((socket) => {
      targetSockets.add(socket)
      socket.on('error', () => undefined)
      socket.on('close', () => targetSockets.delete(socket))
      let sent = 0
      const timer = setInterval(() => {
        sent += 1
        socket.write(`chunk-${String(sent).padStart(2, '0')};`)
        if (sent >= CHUNKS) clearInterval(timer)
      }, CHUNK_SPACING_MS)
      socket.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => target!.listen(0, '127.0.0.1', resolve))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('测试目标未监听')
    upstream = await startFakeSocks5Server({ 'api.example.test:80': ['127.0.0.1', address.port] })
    bridge = createLocalBridge({
      listenPort: 0,
      dataDir,
      upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { protectedDirectSuffixes: [], directSuffixes: [], tunnelSuffixes: ['example.test'] },
      idleStreamMs: IDLE_MS
    })
    await bridge.listen()
  })

  afterEach(async () => {
    await bridge?.close()
    await upstream?.close()
    for (const socket of targetSockets) socket.destroy()
    await new Promise<void>((resolve) => target?.close(() => resolve()))
    removeTempDir(dataDir)
  })

  it('流式期间不逐 chunk 重挂:整段至多重挂一次;静默后仍按窗口销账', async () => {
    const originalSetTimeout = globalThis.setTimeout
    let idleTimerArms = 0
    // 计数后原样调用(返回真实 Timeout,unref 才可用)。
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      if (delay === IDLE_MS) idleTimerArms += 1
      return originalSetTimeout(handler, delay, ...(rest as []))
    }) as typeof setTimeout
    let received = ''
    try {
      const client = await socks5Connect({ host: '127.0.0.1', port: bridge!.port(), targetHost: 'api.example.test', targetPort: 80 })
      client.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
      await waitFor(() => received.split(';').length - 1 >= CHUNKS, 10_000)
      client.destroy()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
    // 20 个 chunk 只许重挂 ≤ 2 次(首次 + 剩余窗口过半时的一次);每 chunk 重挂 = 20 次 → 红。
    expect(idleTimerArms).toBeLessThanOrEqual(2)
    expect(idleTimerArms).toBeGreaterThanOrEqual(1)
    // 等价性锚:静默超过窗口后,在途流销账归零(节流不得推迟销账)。
    await waitFor(() => (bridge!.traffic!().activeStreams ?? 0) === 0, 5_000)
    expect(received).toContain('chunk-20;')
  }, 30_000)
})
