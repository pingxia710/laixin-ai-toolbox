import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export class HttpVerifyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HttpVerifyError'
  }
}

const MAX_HEADER_BYTES = 16 * 1024
const MAX_BODY_BYTES = 512

/**
 * Reads the small exit-IP response through an already connected socket.
 * The socket may be a SOCKS tunnel; HTTPS is layered on top of that socket.
 */
export function verifyHttpExitIp(socket, url, timeoutMs = 10_000) {
  if (!(url instanceof URL) || !['http:', 'https:'].includes(url.protocol)) {
    throw new HttpVerifyError('复验地址协议不支持')
  }
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.trunc(timeoutMs)) : 10_000
  const transport = url.protocol === 'https:'
    ? tlsConnect({ socket, servername: isIP(url.hostname) === 0 ? url.hostname : undefined, rejectUnauthorized: true })
    : socket
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => finish(new HttpVerifyError('复验响应超时')), deadlineMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      transport.removeListener('data', onData)
      transport.removeListener('end', onEnd)
      transport.removeListener('close', onClose)
      transport.removeListener('error', onError)
      transport.removeListener('timeout', onTimeout)
      if (error) { transport.destroy(); reject(error) } else resolve(value)
    }
    const parse = () => {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (buffer.length > MAX_HEADER_BYTES) finish(new HttpVerifyError('复验响应头过大'))
        return false
      }
      if (headerEnd > MAX_HEADER_BYTES) { finish(new HttpVerifyError('复验响应头过大')); return false }
      const header = buffer.subarray(0, headerEnd).toString('latin1')
      const firstLine = header.split('\r\n', 1)[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(firstLine)
      if (!match || Number(match[1]) !== 200) { finish(new HttpVerifyError('复验响应状态码不是 200')); return false }
      const body = buffer.subarray(headerEnd + 4)
      if (body.length > MAX_BODY_BYTES) { finish(new HttpVerifyError('复验响应体过大')); return false }
      return body
    }
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      parse()
    }
    const onEnd = () => {
      const body = parse()
      if (!body) { finish(new HttpVerifyError('复验响应畸形')); return }
      const value = body.toString('utf8').trim()
      if (isIP(value) === 0) { finish(new HttpVerifyError('复验响应不是出口 IP')); return }
      finish(undefined, value)
    }
    const onClose = () => { if (!settled) onEnd() }
    const onError = (error) => finish(new HttpVerifyError(error?.message ?? '复验连接失败'))
    const onTimeout = () => finish(new HttpVerifyError('复验响应超时'))
    transport.on('data', onData)
    transport.once('end', onEnd)
    transport.once('close', onClose)
    transport.once('error', onError)
    transport.once('timeout', onTimeout)
    transport.setTimeout?.(deadlineMs, onTimeout)
    // A SOCKS socket is already connected. TLS buffers writes until its handshake
    // completes, so one write is safe for both raw HTTP and HTTPS transports.
    transport.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`)
  })
}
