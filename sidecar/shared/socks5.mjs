// 最小 SOCKS5 客户端(RFC 1928 无认证 CONNECT):供守护的复验与本地 bridge 的上游转发用。
// 零依赖,只支持 domain / IPv4 两种目标形式;⛔ 认证 ⛔ UDP ASSOCIATE。
import { connect } from 'node:net'

export function socks5Connect({ host, port, targetHost, targetPort, timeoutMs = 10_000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // RFC 1928 长度字节只有 1 字节(收敛包3·件5):超过 255 字节会把长度截断、发出畸形
    // CONNECT。直接拒绝该连接并走既有错误路径,⛔ 影响守护进程。
    if (Buffer.byteLength(targetHost, 'utf8') > 255) {
      rejectPromise(new Error(`SOCKS5 目标主机名超过 255 字节,已拒绝连接`))
      return
    }
    const socket = connect({ host, port })
    const fail = (reason) => {
      socket.destroy()
      rejectPromise(new Error(reason))
    }
    const timer = setTimeout(() => fail('SOCKS5 握手超时'), timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timer)
      fail(`SOCKS5 连接失败:${error.message}`)
    })

    let phase = 'greeting'
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (phase === 'greeting') {
        if (buffer.length < 2) {
          return
        }
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          clearTimeout(timer)
          fail('SOCKS5 无认证方式被拒')
          return
        }
        phase = 'connect'
        socket.write(encodeConnect(targetHost, targetPort))
        buffer = buffer.subarray(2)
        return
      }
      if (buffer.length < 10) {
        return
      }
      if (buffer[1] !== 0x00) {
        clearTimeout(timer)
        fail(`SOCKS5 CONNECT 被拒:rep=${buffer[1]}`)
        return
      }
      clearTimeout(timer)
      socket.removeAllListeners('data')
      resolvePromise(socket)
    })

    socket.write(Buffer.from([0x05, 0x01, 0x00]))
  })
}

function encodeConnect(host, port) {
  const portBuffer = Buffer.alloc(2)
  portBuffer.writeUInt16BE(port)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split('.').map((part) => Number.parseInt(part, 10))
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(octets), portBuffer])
  }
  const hostBuffer = Buffer.from(host, 'utf8')
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]),
    hostBuffer,
    portBuffer
  ])
}
