// 收敛包3·件5:SOCKS5 编码把超长主机名(>255 字节)的长度字节截断,发出畸形请求。
// 故障注入:喂 260 字节目标主机名。修法:直接拒绝该连接,⛔ 影响守护进程。
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'

let server: Server | undefined
let received: Buffer | undefined
let port = 0

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  received = undefined
})

function startFakeSocks5(): Promise<number> {
  received = undefined
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      socket.once('data', () => {
        // 回「无需认证」,等 CONNECT 请求;把收到的请求字节记录下来
        socket.write(Buffer.from([0x05, 0x00]))
        socket.once('data', (request) => {
          received = Buffer.from(request)
          socket.end(Buffer.from([0x05, 0x00, 0x00, 0x01, 10, 0, 0, 1, 0, 0]))
        })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port
      resolve(port)
    })
  })
}

describe('SOCKS5 超长目标主机名(收敛包3·件5)', () => {
  it('目标主机名超过 255 字节:立即拒绝该连接并给出明确错误,不发出畸形 CONNECT', async () => {
    port = await startFakeSocks5()
    const longHost = 'a'.repeat(260)
    await expect(socks5Connect({ host: '127.0.0.1', port, targetHost: longHost, targetPort: 443, timeoutMs: 500 })
      .then((socket) => { socket.destroy(); throw new Error('应当拒绝') }),
    ).rejects.toThrow('超过 255 字节')
    // 给可能的错误写入留一点时间,再断言没有发出 CONNECT
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toBeUndefined()
  })

  it('正常主机名不受影响,CONNECT 长度字节正确', async () => {
    port = await startFakeSocks5()
    const socket = await socks5Connect({ host: '127.0.0.1', port, targetHost: 'verify.example.invalid', targetPort: 443, timeoutMs: 2_000 })
    socket.destroy()
    expect(received).toBeDefined()
    expect(received![3]).toBe(0x03)
    expect(received![4]).toBe('verify.example.invalid'.length)
  })
})
