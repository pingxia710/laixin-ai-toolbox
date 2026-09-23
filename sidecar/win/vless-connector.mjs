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

/**
 * 甲-4 补强(2026-09-17):AI 服务按**每个探测地址的真实响应特征**判「这条路能不能用」,⛔ 一刀切。
 * 甲-4 基线是任何 <500 都算通,但两家对**不支持地区**都会在网络可达的前提下回 403 → 被判可用 →
 * 不接管 → 显示已连接而 AI 用不了、永不自愈(香港等走境外出口的公司网络命中此形)。
 *
 * 样本(2026-09-17 经出口 23.106.156.30/LAX 采样,原始记录 evidence/jia4b-region403/):
 * - api.anthropic.com  支持地区 GET / → **404**(ASCII 招牌,text/plain);不支持地区 → **403**
 *   {"error":{"type":"forbidden","message":"Request not allowed"}}(甲-4 验收线实测)。干净二分。
 *   官方依据:anthropic.com/supported-countries:「Commercial API access and Claude.ai. To the extent
 *   permitted by law, Anthropic reserves the right to not provide its products or services to
 *   entities whose majority direct or indirect ownership is attributable to nations other than those
 *   listed in our Supported Regions Policy.」(所列地区不含中国内地/香港。)
 * - chatgpt.com        非浏览器请求在**支持地区**也吃 Cloudflare 挑战:403 + `cf-mitigated: challenge`
 *   (任何 UA 都吃,采样;挑战是「挑剔客户端」,客户的真浏览器能过,不证明地区被拒)。Cloudflare 官方
 *   developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/:
 *   「the Challenge Page response … will have the cf-mitigated header present and set to challenge …
 *   For the cf-mitigated header, challenge is the only valid value」——官方给的判别挑战的方法。
 *   地区拦截的 403 不带该头(或为 cf-mitigated: block);OpenAI 官方
 *   developers.openai.com/api/docs/supported-countries:「Accessing or offering access to our services
 *   outside of the countries and territories listed below may result in your account being blocked
 *   or suspended.」
 *
 * 误判方向(延续甲-4):判不准宁可「不能用」——403 无法自证非地区拒绝时一律拒,代价只是多接管一次;
 * 唯一放宽是带 challenge 标记的 403 判可用(依据 Cloudflare 官方判别法),不放宽则所有能用的客户
 * 一律被接管、「复用客户现成网络」作废。残余风险:若某地区的拒绝也以 challenge 形态下发(无证据),
 * chatgpt 单点会判可用,但两地址 AND 下 api.anthropic.com 的 403 判据仍把整条路判不可用,报告场景
 * 兜得住。其他主机(通用探测点/隧道复验)不进本判据,维持 <500 语义。
 */
export function aiProbeResponseAcceptable(target, statusCode, headers) {
  if (typeof statusCode !== 'number' || statusCode < 200 || statusCode >= 500) return false
  if (statusCode !== 403) return true
  const host = String(target?.hostname ?? '').toLowerCase()
  if (host === 'api.anthropic.com') return false // 支持地区从不 403(实测 404);403 即地区拒绝
  if (host === 'chatgpt.com') {
    const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'cf-mitigated')
    const mitigated = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1]
    return String(mitigated ?? '').trim().toLowerCase() === 'challenge'
  }
  return true
}

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
  try {
    if (target.protocol === 'https:') transport = tlsConnect({ socket, servername: isIP(targetHost) ? undefined : targetHost, host: targetHost, rejectUnauthorized: true })
    // 判据与两个复用探测同一处:真发一次轻量请求,拿到 <500 的 HTTP 响应才算通(甲-4)。
    await httpResponseOverSocket(transport, target, timeoutMs)
  } finally {
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
 * 甲-4:连上+握手能过还不算数——真发一次轻量 HTTP 请求并校验响应,掐数据的管控网络才不会误判成「能用」。
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
      let transport = socket
      if (target.protocol === 'https:') transport = await tlsSession(socket, host, timeoutMs)
      // 握手能过不算数(甲-4):管控网络放行握手、按域名掐数据——真发一次轻量请求,拿到响应才算通。
      // 403 地区拒绝也不算数(甲-4 补强):判据按探测地址的真实响应特征分形(aiProbeResponseAcceptable)。
      await httpResponseOverSocket(transport, target, timeoutMs, (res) => aiProbeResponseAcceptable(target, res.statusCode, res.headers))
    } finally { socket.destroy() }
  }
  return { direct: true }
}

/**
 * 「已有可用外网就复用」(创始人 09-13 晚):客户电脑上已经开着别的代理时,先看它能不能出外网——
 * 经它对探测点做 CONNECT/SOCKS5 + TLS 握手。PAC 没法在这里求值,调用方按「不可判定」处理。
 *
 * 甲-4 判据升级两处:①探测点缺省就是 AI 服务(公司网络常放行 Google 却拦 AI,通用 204 点探通了
 * 也不代表客户要的能用);②握手能过不算数——经隧道对每个探测点真发一次轻量 HTTP 请求并校验响应,
 * **全部通过才算这条路能用**(与直连同一判据:一个通可能只是运气);任一不过即抛错,调用方接管
 * (误判代价不对称:判错成「不能用」只是多接管一次)。甲-4 补强再加③:响应合格与否按探测地址的
 * 真实响应特征判(aiProbeResponseAcceptable)——两家服务对不支持地区回 403,⛔ 再当「能用」。
 */
export async function probeExistingProxy(existing, urls = AI_SERVICE_PROBE_URLS, timeoutMs = 5_000) {
  if (!existing || !['http', 'socks'].includes(existing.kind) || typeof existing.host !== 'string' || !Number.isInteger(existing.port)) {
    throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '现有代理无法探测')
  }
  for (const url of urls) {
    const target = new URL(url)
    const targetHost = target.hostname.replace(/^\[|\]$/g, '')
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const socket = existing.kind === 'socks'
      ? await socks5Connect({ host: existing.host, port: existing.port, targetHost, targetPort, timeoutMs })
      : await httpConnectTunnel(existing.host, existing.port, targetHost, targetPort, timeoutMs)
    try {
      let transport = socket
      if (target.protocol === 'https:') transport = await tlsSession(socket, targetHost, timeoutMs)
      // 判据同直连(甲-4 真请求 + 甲-4 补强 403 地区拒绝按地址分形):两个探测点都合格才算复用。
      await httpResponseOverSocket(transport, target, timeoutMs, (res) => aiProbeResponseAcceptable(target, res.statusCode, res.headers))
    } finally { socket.destroy() }
  }
  return { url: urls[0] }
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

function tlsSession(socket, servername, timeoutMs) {
  // 与旧 tlsHandshake 同判据,但握上后**不拆** TLS 会话——甲-4 要在这条会话上真发一次请求。
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: isIP(servername) ? undefined : servername, host: servername, rejectUnauthorized: true })
    const timer = setTimeout(() => { tls.destroy(); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '探测 TLS 握手超时')) }, timeoutMs)
    tls.once('secureConnect', () => { clearTimeout(timer); resolve(tls) })
    tls.once('error', (error) => { clearTimeout(timer); reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, `探测 TLS 握手失败:${error.message}`)) })
  })
}

/**
 * 甲-4 判据核心:握手能过 ⛔ 等于数据能走——「放行握手、按域名掐数据」的管控网络(公司/校园
 * 防火墙)会让只握手的探测永远判通,客户看到已连接而 AI 用不了、永不自愈。在已建好的传输上
 * 真发一次轻量 GET:拿到合格响应才算这条路真能走。默认判据与 reachThroughProxy 同(<500);
 * AI 复用探测注入 aiProbeResponseAcceptable——403 地区拒绝⛔算通(甲-4 补强,按地址分形)。
 */
async function httpResponseOverSocket(transport, target, timeoutMs, isAcceptable = (res) => typeof res.statusCode === 'number' && res.statusCode < 500) {
  const agent = new Agent({ keepAlive: false })
  try {
    agent.createConnection = () => transport
    await new Promise((resolve, reject) => {
      const fail = () => reject(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '探测请求无有效响应'))
      const req = request({ host: target.hostname, port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
        path: target.pathname + target.search, headers: { Host: target.host }, agent }, (res) => {
        res.resume()
        if (isAcceptable(res)) resolve(undefined)
        else fail()
      })
      const timer = setTimeout(() => req.destroy(new Error('PROBE_TIMEOUT')), timeoutMs)
      req.on('error', fail)
      req.on('close', () => clearTimeout(timer))
      req.end()
    })
  } finally {
    agent.destroy()
  }
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
