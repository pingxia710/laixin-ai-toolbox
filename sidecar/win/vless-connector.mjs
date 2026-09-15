import { readFileSync } from 'node:fs'
import { Agent, request } from 'node:http'
import { connect as netConnect, isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { CONTROL_CODES, ConnectorError } from './connectors.mjs'
import { socks5Connect } from './socks5.mjs'
import { buildVlessOutbound, validVerifyUrl, validVerifyFallbackUrl } from './vless-settings.mjs'

// Xray 由原有 bridge 生命周期持有，本连接器只提供出口配置和通道内复验。
export function createVlessConnector(spec) {
  if (!validVerifyUrl(spec.verifyUrl) || (spec.verifyFallbackUrl !== undefined && !validVerifyFallbackUrl(spec.verifyUrl, spec.verifyFallbackUrl))) throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '复验配置无效')
  const outbound = buildVlessOutbound(spec.node, JSON.parse(readFileSync(spec.credentialPath, 'utf8')))
  return {
    kind: 'vless-reality',
    localProxyPort: () => spec.localPort,
    xrayOutbound: () => outbound,
    onLost() {}, // 内核退出事件由 bridge 统一报告。
    async start() {},
    async stop() {},
    verify: () => verifyWithFallback(spec.localPort, spec.verifyUrl, spec.verifyFallbackUrl, spec.timeoutMs ?? 10_000)
  }
}

export async function verifyWithFallback(port, primary, fallback, timeoutMs = 10_000, probe = verifyThroughProxy) {
  if (!validVerifyUrl(primary) || (fallback !== undefined && !validVerifyFallbackUrl(primary, fallback))) {
    throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '复验配置无效')
  }
  try { return await probe(port, primary, timeoutMs) }
  catch (first) {
    if (fallback === undefined) throw first
    try { return await probe(port, fallback, timeoutMs) }
    catch (second) {
      // An HTTP response proves the tunnel reached at least one probe host;
      // an invalid echo is not evidence that the upstream itself is down.
      throw first?.code === CONTROL_CODES.probeUnavailable ? first : second
    }
  }
}

// 通用探测点(创始人 09-13「点连接必连」):配置里的回显地址是我们自己的一台服务器,它抖一下不等于通道死了。
// 回显失败后再从通道里打这些通用地址,任何一处有 HTTP 回应就证明通道活着。⛔ 用国内可直连的地址(会被内核分流直连,测不到通道)。
export const TUNNEL_PROBE_URLS = Object.freeze(['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'])

/**
 * 「客户真正要用的那些服务」——判断这台电脑本来就有没有一条能用的路时,探的必须是这些,
 * ⛔ 用 TUNNEL_PROBE_URLS:公司网络常放行 Google 却拦着 AI 服务,拿通用探测点当判据会把这种客户
 * 判成「他自己就能用」而永远等不到我们接管(本机实测:能上外网的机器上 122 条用例集体走进复用分支)。
 */
export const AI_SERVICE_PROBE_URLS = Object.freeze(['https://chatgpt.com/', 'https://api.anthropic.com/'])

/** 逐个探测,任一有 HTTP 回应(状态 < 500)即视为通道可达;全部失败抛最后一个错误。 */
export async function probeTunnelReachability(port, urls = TUNNEL_PROBE_URLS, timeoutMs = 8_000, probe = reachThroughProxy) {
  let lastError = new ConnectorError(CONTROL_CODES.upstreamUnreachable, '通道探测无回应')
  for (const url of urls) {
    try { await probe(port, url, timeoutMs); return { url } } catch (error) { lastError = error }
  }
  throw lastError
}

export async function reachThroughProxy(port, url, timeoutMs = 8_000) {
  const target = new URL(url)
  const targetHost = target.hostname.replace(/^\[|\]$/g, '')
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  const socket = await socks5Connect({ host: '127.0.0.1', port, targetHost, targetPort, timeoutMs })
  let transport = socket
  const agent = new Agent({ keepAlive: false })
  try {
    if (target.protocol === 'https:') transport = tlsConnect({ socket, servername: isIP(targetHost) ? undefined : targetHost, host: targetHost, rejectUnauthorized: true })
    agent.createConnection = () => transport
    await new Promise((resolve, reject) => {
      const fail = () => reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '通道探测失败'))
      const req = request({ host: targetHost, port: targetPort, path: target.pathname + target.search, headers: { Host: target.host }, agent }, (res) => {
        res.resume()
        if (res.statusCode !== undefined && res.statusCode < 500) resolve(undefined)
        else fail()
      })
      const timer = setTimeout(() => req.destroy(new Error('PROBE_TIMEOUT')), timeoutMs)
      req.on('error', fail)
      req.on('close', () => clearTimeout(timer))
      req.end()
    })
  } finally {
    agent.destroy()
    transport.destroy()
    socket.destroy()
  }
}

/**
 * 这台电脑**不经任何代理**能不能到目标服务(客户装了 VPN 走全局、人在墙外、公司专线,都属于这一类)。
 * **判据是调用方传进来的那组地址,⛔ 图省事用默认的通用探测点**:通用点在国内直连不通、探通了只说明
 * 「有一条出去的路」,而「有一条出去的路」⛔ 等于「这条路能用 AI」。要判客户自己那条路能不能用,
 * 传 AI_SERVICE_PROBE_URLS。
 * 反过来「探不通」⛔ 推断成客户没网——那只是说明没有一条现成的路,该我们接管。
 *
 * 两个探测点要**都**通才算数:一个通可能只是运气(某个 CDN 恰好没被拦),两个都通才像真有一条稳定的路。
 * 直连要走干净的出口:显式不带任何代理,⛔ 读环境里的 HTTP_PROXY(那可能正是我们自己刚写下去的)。
 */
export async function probeDirectReachability(urls = TUNNEL_PROBE_URLS, timeoutMs = 4_000) {
  const targets = urls.slice(0, 2)
  if (targets.length === 0) throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '没有可用的探测点')
  for (const url of targets) {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const socket = await new Promise((resolve, reject) => {
      const attempt = netConnect({ host, port })
      const timer = setTimeout(() => { attempt.destroy(); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '直连探测超时')) }, timeoutMs)
      attempt.once('connect', () => { clearTimeout(timer); resolve(attempt) })
      attempt.once('error', () => { clearTimeout(timer); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '直连探测连不上')) })
    })
    try {
      if (target.protocol === 'https:') await tlsHandshake(socket, host, timeoutMs)
    } finally { socket.destroy() }
  }
  return { direct: true }
}

/**
 * 「已有可用外网就复用」(创始人 09-13 晚):客户电脑上已经开着别的代理时,先看它能不能出外网——
 * 经它对通用探测点做一次 CONNECT + TLS 握手,握上就是能用。http 代理走 CONNECT,socks 代理走 SOCKS5;
 * PAC 没法在这里求值,调用方按「不可判定」处理。任一探测点握上即可达;全部失败抛最后一个错误。
 */
export async function probeExistingProxy(existing, urls = TUNNEL_PROBE_URLS, timeoutMs = 5_000) {
  if (!existing || !['http', 'socks'].includes(existing.kind) || typeof existing.host !== 'string' || !Number.isInteger(existing.port)) {
    throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '现有代理无法探测')
  }
  let lastError = new ConnectorError(CONTROL_CODES.upstreamUnreachable, '现有代理探测无回应')
  for (const url of urls) {
    const target = new URL(url)
    const targetHost = target.hostname.replace(/^\[|\]$/g, '')
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    try {
      const socket = existing.kind === 'socks'
        ? await socks5Connect({ host: existing.host, port: existing.port, targetHost, targetPort, timeoutMs })
        : await httpConnectTunnel(existing.host, existing.port, targetHost, targetPort, timeoutMs)
      try {
        if (target.protocol === 'https:') await tlsHandshake(socket, targetHost, timeoutMs)
        return { url }
      } finally { socket.destroy() }
    } catch (error) { lastError = error }
  }
  throw lastError
}

function httpConnectTunnel(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxyHost, port: proxyPort })
    let buffer = ''
    const fail = (message) => { socket.destroy(); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, message)) }
    const timer = setTimeout(() => fail('现有代理 CONNECT 超时'), timeoutMs)
    socket.once('error', () => { clearTimeout(timer); fail('现有代理连接失败') })
    socket.once('connect', () => { socket.write(`CONNECT ${targetHost}:${String(targetPort)} HTTP/1.1\r\nHost: ${targetHost}:${String(targetPort)}\r\n\r\n`) })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) { if (buffer.length > 8192) fail('现有代理应答异常'); return }
      clearTimeout(timer)
      socket.removeAllListeners('data')
      const status = Number.parseInt(buffer.split(' ')[1] ?? '', 10)
      if (status >= 200 && status < 300) resolve(socket)
      else fail(`现有代理拒绝 CONNECT(${String(status)})`)
    })
  })
}

function tlsHandshake(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: isIP(servername) ? undefined : servername, host: servername, rejectUnauthorized: true })
    const timer = setTimeout(() => { tls.destroy(); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '现有代理 TLS 握手超时')) }, timeoutMs)
    tls.once('secureConnect', () => { clearTimeout(timer); tls.destroy(); resolve(undefined) })
    tls.once('error', (error) => { clearTimeout(timer); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, `现有代理 TLS 握手失败:${error.message}`)) })
  })
}

export async function verifyThroughProxy(port, verifyUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  const url = new URL(verifyUrl)
  const targetHost = url.hostname.replace(/^\[|\]$/g, '')
  const socket = await socks5Connect({ host: '127.0.0.1', port, targetHost, targetPort: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), timeoutMs })
  let transport = socket
  const agent = new Agent({ keepAlive: false })
  try {
    if (url.protocol === 'https:') {
      transport = tlsConnect({ socket, servername: isIP(targetHost) ? undefined : targetHost, host: targetHost, rejectUnauthorized: true })
    }
    agent.createConnection = () => transport
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '通道内复验失败'))
      const invalidEcho = () => reject(new ConnectorError(CONTROL_CODES.probeUnavailable, '检测服务未返回有效出口地址'))
      const req = request({ host: targetHost, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), path: url.pathname + url.search, headers: { Host: url.host }, agent }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk; if (body.length > 256) { invalidEcho(); req.destroy() } })
        res.on('error', fail)
        res.on('end', () => {
          const exitIp = body.trim()
          if (res.statusCode !== 200 || !isIP(exitIp)) invalidEcho()
          else resolve({ exitIp })
        })
      })
      const timer = setTimeout(() => req.destroy(new Error('VERIFY_TIMEOUT')), Math.max(1, deadline - Date.now()))
      req.on('error', fail)
      req.on('close', () => clearTimeout(timer))
      req.end()
    })
  } finally {
    agent.destroy()
    transport.destroy()
    socket.destroy()
  }
}
