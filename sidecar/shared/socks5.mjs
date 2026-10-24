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
    let settled = false
    let phase = 'greeting'
    let needed = 2
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('readable', onReadable)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
    }
    const fail = (reason) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      rejectPromise(new Error(reason))
    }
    const timer = setTimeout(() => fail('SOCKS5 握手超时'), timeoutMs)
    const onError = (error) => fail(`SOCKS5 连接失败:${error.message}`)
    const onEnd = () => fail('SOCKS5 握手提前结束')
    const onReadable = () => {
      // 只取当前握手字段。其后的业务数据保留在 socket 缓冲区，交给 HTTP/TLS 调用者。
      while (!settled) {
        const field = socket.read(needed)
        if (field === null) return
        // EOF 时 read(n) 可能交出不足 n 字节的尾段，不能当完整回复。
        if (field.length !== needed) { onEnd(); return }
        if (phase === 'greeting') {
          if (field[0] !== 0x05 || field[1] !== 0x00) { fail('SOCKS5 无认证方式被拒'); return }
          phase = 'header'
          needed = 4
          socket.write(encodeConnect(targetHost, targetPort))
        } else if (phase === 'header') {
          if (field[0] !== 0x05 || field[2] !== 0x00 || ![0x01, 0x03, 0x04].includes(field[3])) {
            fail('SOCKS5 CONNECT 回复格式无效'); return
          }
          if (field[1] !== 0x00) { fail(`SOCKS5 CONNECT 被拒:rep=${field[1]}`); return }
          phase = field[3] === 0x03 ? 'domain-length' : 'address'
          needed = field[3] === 0x03 ? 1 : field[3] === 0x01 ? 6 : 18
        } else if (phase === 'domain-length') {
          if (field[0] === 0) { fail('SOCKS5 CONNECT 回复域名为空'); return }
          phase = 'address'
          needed = field[0] + 2
        } else {
          settled = true
          cleanup()
          resolvePromise(socket)
        }
      }
    }
    socket.on('readable', onReadable)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onEnd)

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
