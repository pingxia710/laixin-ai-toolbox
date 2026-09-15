import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as tlsServer } from 'node:tls'
import { join } from 'node:path'
import { xrayExecutable } from '../../../sidecar/mac/local-bridge.mjs'

export async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

// 一整段连续空端口。给「客户端口区」这类需要一段而不是一个端口的场合用。
// ⛔ 拿 freePort() 的返回值当段首:那只验了段首一个,而且落在临时端口区(本机 49152 起)
// ——段里其余端口随时被本机别的连接抢走,全量串行跑时就成了偶发红。
// 这里段首挑在临时端口区之下,整段逐个试绑确认真空着再整段释放;游标只前进,同一进程里段与段不重叠。
const PORT_BLOCK_FIRST = 20_000
const PORT_BLOCK_LAST = 40_000
let portBlockCursor = PORT_BLOCK_FIRST + Math.floor(Math.random() * 4_000)

export async function freePortBlock(count: number): Promise<number> {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    if (portBlockCursor + count > PORT_BLOCK_LAST) portBlockCursor = PORT_BLOCK_FIRST
    const first = portBlockCursor
    portBlockCursor += count
    const held: Server[] = []
    let taken = false
    for (let offset = 0; offset < count && !taken; offset += 1) {
      try { held.push(await bind(first + offset)) } catch { taken = true }
    }
    await Promise.all(held.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    if (!taken) return first
  }
  throw new Error('TEST_PORT_BLOCK_UNAVAILABLE')
}

async function bind(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return server
}

// 独立新建的本地 TLS 站点、REALITY 服务端与 HTTP 出口回显；无外部连接或真实凭据。
export async function startRealityNode(root: string) {
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt'), '-subj', '/CN=reality.test.invalid', '-days', '1'], { stdio: 'pipe', timeout: 10_000 })
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
  const tls = tlsServer({ key: readFileSync(join(root, 'tls.key')), cert: readFileSync(join(root, 'tls.crt')), minVersion: 'TLSv1.3', ecdhCurve: 'X25519', ALPNProtocols: ['h2', 'http/1.1'] })
  tls.on('connection', track)
  const tlsPort = await listen(tls)
  let requests = 0
  let response = '203.0.113.42'
  let statusCode = 200
  const echo = httpServer((_req, res) => { requests += 1; res.writeHead(statusCode); res.end(response) })
  echo.on('connection', track)
  const echoPort = await listen(echo)
  const port = await freePort()
  const pair = generateKeyPairSync('x25519')
  const credential = { uuid: randomUUID(), publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), shortId: '0123456789abcdef', serverName: 'reality.test.invalid' }
  const configFile = join(root, 'server.json')
  writeFileSync(configFile, JSON.stringify({
    log: { loglevel: 'none', access: 'none', error: 'none' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [{ id: credential.uuid, flow: 'xtls-rprx-vision' }], decryption: 'none' }, streamSettings: { network: 'tcp', security: 'reality', realitySettings: { dest: `127.0.0.1:${tlsPort}`, serverNames: [credential.serverName], privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url'), shortIds: [credential.shortId] } } }],
    // 此内核服务端默认禁私网；测试只放行本回显端口，不放开其他本地服务。
    outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', network: 'tcp', ip: ['127.0.0.1'], port: echoPort }] } }]
  }), { mode: 0o600 })
  let child: ChildProcess | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child!.once('close', () => resolve()))
    child.kill('SIGTERM')
    await exited
  }
  const start = async () => {
    child = spawn(xrayExecutable(), ['run', '-config', configFile], { stdio: 'ignore' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })
      if (ready) return
      if (child.exitCode !== null) throw new Error('LOCAL_REALITY_SERVER_EXITED')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('LOCAL_REALITY_SERVER_TIMEOUT')
  }
  try { await start() } catch (error) {
    await stop(); sockets.forEach((socket) => socket.destroy()); tls.close(); echo.close(); throw error
  }
  return {
    node: { host: '127.0.0.1', port }, credential, verifyUrl: `http://127.0.0.1:${echoPort}/toolbox-exit-ip`,
    requests: () => requests, setResponse: (body: string, code = 200) => { response = body; statusCode = code },
    stop, start,
    close: async () => { await stop(); sockets.forEach((socket) => socket.destroy()); await Promise.all([tls, echo].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) }
  }
}
