import { isIP } from 'node:net'
import { Agent, request } from 'node:http'
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
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const transport = url.protocol === 'https:'
    ? tlsConnect({ socket, host, servername: isIP(host) === 0 ? host : undefined, rejectUnauthorized: true })
    : socket
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = () => transport
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new HttpVerifyError('复验响应超时')), deadlineMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      agent.destroy()
      transport.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    // Node's HTTP parser validates framing and decodes chunked bodies over the
    // supplied tunnel. It never opens a second connection to the destination.
    const req = request({ host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      path: url.pathname + url.search, headers: { Host: url.host }, agent, maxHeaderSize: MAX_HEADER_BYTES }, (res) => {
      res.on('error', () => finish(new HttpVerifyError('复验响应不完整')))
      res.on('aborted', () => finish(new HttpVerifyError('复验响应不完整')))
      if (res.statusCode !== 200) { finish(new HttpVerifyError('复验响应状态码不是 200')); return }
      let size = 0
      const chunks = []
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) { finish(new HttpVerifyError('复验响应体过大')); return }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (!res.complete) { finish(new HttpVerifyError('复验响应不完整')); return }
        const value = Buffer.concat(chunks).toString('utf8').trim()
        if (isIP(value) === 0) { finish(new HttpVerifyError('复验响应不是出口 IP')); return }
        finish(undefined, value)
      })
    })
    req.on('error', (error) => finish(new HttpVerifyError(error.code === 'HPE_HEADER_OVERFLOW' ? '复验响应头过大' : error.message)))
    req.on('close', () => { if (!settled) finish(new HttpVerifyError('复验响应不完整')) })
    req.end()
  })
}
