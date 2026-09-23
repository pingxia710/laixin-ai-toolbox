// 甲-4 补强:AI 服务回「地区不支持」(403)时⛔再判「可直连/现成路可用」——基线任何 <500 都算通,
// 香港等境外出口的公司网络下两家服务对不支持地区都回 403 → 判可用 → 不接管 → 显示已连接、AI 用不了、永不自愈。
// 判据按每个探测地址的真实响应特征分形(⛔ 一刀切),样本与官方依据见 sidecar/shared/vless-connector.mjs:
//   api.anthropic.com  支持地区 GET / = 404(ASCII 招牌);不支持地区 = 403 "Request not allowed"。
//   chatgpt.com        非浏览器请求在支持地区也吃 Cloudflare 挑战 403 + `cf-mitigated: challenge`
//                      (Cloudflare 官方:该头是判别挑战页的可靠方法);地区拦截的 403 不带该头。
// 误判方向延续甲-4:判不准宁可「不能用」(多接管一次);唯一放宽是挑战 403 判可用——不放宽则所有
// 能用的客户一律被接管,「复用客户现成网络」作废。全部走回环假服务器,⛔ 真外网。
import { afterEach, describe, expect, it } from 'vitest'
import { createServer as netServer, type Server as NetServer, type Socket } from 'node:net'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { aiProbeResponseAcceptable, probeDirectReachability, probeExistingProxy } from '../../sidecar/win/vless-connector.mjs'

const servers: Array<NetServer | HttpServer> = []
const openSockets = new Set<Socket>()
const track = (socket: Socket) => { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)) }
afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()) })
})

const listen = (server: NetServer | HttpServer) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
})

const freePort = () => new Promise<number>((resolve) => {
  const probe = netServer()
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)) })
})

/** 真实样本形状(2026-09-17 经出口 23.106.156.30/LAX 采样 + 甲-4 验收线,原始记录 evidence/jia4b-region403/)。 */
const SAMPLES = {
  anthropicDenied: { // 不支持地区(验收线实测形状)
    status: 403, headers: { 'content-type': 'application/json' },
    body: '{"error":{"type":"forbidden","message":"Request not allowed"}}'
  },
  anthropicSupported: { // 支持地区实测:404 + ASCII 招牌
    status: 404, headers: { 'content-type': 'text/plain', 'server': 'cloudflare' },
    body: ' ▐▛███▜▌   Anthropic API\n▝▜█████▛▘  POST /v1/messages\n  ▘▘ ▝▝    https://docs.anthropic.com'
  },
  chatgptChallenge: { // 支持地区实测:403 + cf-mitigated: challenge(任何 UA 都吃,Cloudflare 挑战页)
    status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare', 'cf-mitigated': 'challenge' },
    body: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><style global>body{font-family:Arial,Helvetica,sans-serif}</style></head><body>Just a moment...</body></html>'
  },
  chatgptRegionBlocked: { // 地区拦截形状:同为 403 但没有挑战头(拦截页 ⛔ 挑战页)
    status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare' },
    body: '<html><body>You do not have access to chatgpt.com.</body></html>'
  },
  chatgptWafBlocked: { // cf-mitigated 是 block(拦截动作;官方:challenge 是唯一合法挑战值)
    status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare', 'cf-mitigated': 'block' },
    body: '<html><body>blocked</body></html>'
  },
  anthropicServerError: { status: 500, headers: {}, body: 'oops' }
}

type Canned = { status: number; headers?: Record<string, string>; body?: string }

/**
 * 假 CONNECT 代理:隧道照常建立,隧道内按 CONNECT 目标端口回预置的原始 HTTP 响应。
 * 探测地址用 http://api.anthropic.com:<端口>/ 形态——主机名进分类器,连接却全在回环,⛔ 碰真外网。
 */
async function cannedProxyStub(canned: Record<number, Canned>, targets: string[]): Promise<number> {
  const server = netServer((socket: Socket) => {
    track(socket)
    socket.on('error', () => undefined)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(buffer.split('\r\n')[0])
      if (match === null) { socket.destroy(); return }
      targets.push(match[1])
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      buffer = buffer.slice(end + 4)
      socket.removeAllListeners('data')
      const port = Number(match[1].split(':')[1])
      const shape = canned[port]
      socket.on('data', () => {
        if (!shape) { socket.destroy(); return }
        const headers = Object.entries(shape.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        const body = shape.body ?? ''
        socket.write(`HTTP/1.1 ${shape.status} X\r\n${headers}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      })
    })
  })
  servers.push(server)
  return listen(server)
}

describe('AI 探测按每个地址的真实响应特征判,⛔ 一刀切(甲-4 补强)', () => {
  it('api.anthropic.com 403 "Request not allowed"(不支持地区,验收线形状)→ 判不可用,接管(基线红:判可用)', async () => {
    const port = await freePort()
    const targets: string[] = []
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.anthropicDenied }, targets)
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://api.anthropic.com:${port}/`], 1500)).rejects.toThrow()
    expect(targets).toEqual([`api.anthropic.com:${port}`]) // 真的经这条路探过,不是没探就拒
  })

  it('api.anthropic.com 404 + 招牌(支持地区真实形状)→ 判可用,复用保留', async () => {
    const port = await freePort()
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.anthropicSupported }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://api.anthropic.com:${port}/`], 1500)).resolves.toMatchObject({ url: `http://api.anthropic.com:${port}/` })
  })

  it('chatgpt.com 403 + cf-mitigated: challenge(支持地区真实形状,Cloudflare 挑战)→ 判可用,复用保留', async () => {
    const port = await freePort()
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.chatgptChallenge }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://chatgpt.com:${port}/`], 1500)).resolves.toMatchObject({ url: `http://chatgpt.com:${port}/` })
  })

  it('chatgpt.com 403 无 cf-mitigated(地区拦截页形状)→ 判不可用(基线红:判可用)', async () => {
    const port = await freePort()
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.chatgptRegionBlocked }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://chatgpt.com:${port}/`], 1500)).rejects.toThrow()
  })

  it('chatgpt.com 403 + cf-mitigated: block(拦截动作)→ 判不可用(基线红:判可用)', async () => {
    const port = await freePort()
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.chatgptWafBlocked }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://chatgpt.com:${port}/`], 1500)).rejects.toThrow()
  })

  it('AI 服务 5xx 仍判不可用(甲-4 状态判据的不变部分)', async () => {
    const port = await freePort()
    const proxyPort = await cannedProxyStub({ [port]: SAMPLES.anthropicServerError }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://api.anthropic.com:${port}/`], 1500)).rejects.toThrow()
  })
})

describe('两地址 AND 端到端(报告场景与保留场景)', () => {
  it('香港出口场景兜底:chatgpt 挑战 403(可用)+ anthropic 403(不可用)→ 整体判不可用,接管', async () => {
    const chatgpt = await freePort()
    const anthropic = await freePort()
    const targets: string[] = []
    const proxyPort = await cannedProxyStub({
      [chatgpt]: SAMPLES.chatgptChallenge,
      [anthropic]: SAMPLES.anthropicDenied
    }, targets)
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://chatgpt.com:${chatgpt}/`, `http://api.anthropic.com:${anthropic}/`], 1500)).rejects.toThrow()
    expect(targets).toEqual([`chatgpt.com:${chatgpt}`, `api.anthropic.com:${anthropic}`]) // 两个都真探过
  })

  it('支持地区完整场景:chatgpt 挑战 403 + anthropic 404 → 复用保留', async () => {
    const chatgpt = await freePort()
    const anthropic = await freePort()
    const proxyPort = await cannedProxyStub({
      [chatgpt]: SAMPLES.chatgptChallenge,
      [anthropic]: SAMPLES.anthropicSupported
    }, [])
    await expect(probeExistingProxy({ kind: 'http', host: '127.0.0.1', port: proxyPort },
      [`http://chatgpt.com:${chatgpt}/`, `http://api.anthropic.com:${anthropic}/`], 1500)).resolves.toMatchObject({ url: `http://chatgpt.com:${chatgpt}/` })
  })
})

describe('⛔ 越界回归:通用探测点不进 AI 判据(甲-4 语义不回退)', () => {
  it('直连探测对 127.0.0.1 的 403 仍判可用(隧道复验与通用点行为不变)', async () => {
    const forbidding = httpServer((req, res) => { res.writeHead(403); res.end('no') })
    forbidding.on('connection', track)
    servers.push(forbidding)
    const port = await listen(forbidding)
    await expect(probeDirectReachability([`http://127.0.0.1:${port}/`], 800)).resolves.toMatchObject({ direct: true })
  })
})

describe('判据纯函数:真实样本形态逐一钉住', () => {
  const url = (host: string) => new URL(`http://${host}/`)
  it('api.anthropic.com:403 拒、404 通、其他 <500 通、>=500 拒', () => {
    expect(aiProbeResponseAcceptable(url('api.anthropic.com'), 403, { 'content-type': 'application/json' })).toBe(false)
    expect(aiProbeResponseAcceptable(url('api.anthropic.com'), 404, { 'content-type': 'text/plain' })).toBe(true)
    expect(aiProbeResponseAcceptable(url('api.anthropic.com'), 429, {})).toBe(true)
    expect(aiProbeResponseAcceptable(url('api.anthropic.com'), 503, {})).toBe(false)
  })
  it('chatgpt.com:403 只有带 cf-mitigated: challenge 才通,无头/block 都拒;200 通', () => {
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 403, { 'cf-mitigated': 'challenge' })).toBe(true)
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 403, { 'CF-Mitigated': 'CHALLENGE' })).toBe(true) // 大小写防御
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 403, {})).toBe(false)
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 403, { 'cf-mitigated': 'block' })).toBe(false)
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 200, {})).toBe(true)
    expect(aiProbeResponseAcceptable(url('chatgpt.com'), 500, {})).toBe(false)
  })
  it('其他主机(通用探测点/隧道复验)维持甲-4 语义:<500 一律通,含 403', () => {
    expect(aiProbeResponseAcceptable(url('www.gstatic.com'), 204, {})).toBe(true)
    expect(aiProbeResponseAcceptable(url('www.gstatic.com'), 403, {})).toBe(true)
    expect(aiProbeResponseAcceptable(url('www.gstatic.com'), 500, {})).toBe(false)
    expect(aiProbeResponseAcceptable(url('cp.cloudflare.com'), 200, { 'cf-mitigated': 'challenge' })).toBe(true)
  })
})
