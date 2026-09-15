/** Local Xray load probe. No public endpoint or system proxy is touched. Run with an explicit compiled NodeControl module. */
/* global fetch, AbortSignal */
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { fork, execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { createServer, connect } from 'node:net'
import { tmpdir, cpus, totalmem, freemem, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer as tlsServer } from 'node:tls'
import { createLocalBridge, xrayExecutable } from '../../sidecar/mac/local-bridge.mjs'
import { buildVlessOutbound } from '../../sidecar/mac/vless-settings.mjs'

const require = createRequire(import.meta.url)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
const close = async (server) => new Promise((resolve) => server.close(() => resolve()))
const freePort = async () => { const server = createServer(); const port = await listen(server); await close(server); return port }
const percentile = (samples, p) => samples.length ? [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))] : null

if (process.argv[2] === '--service') {
  const { NodeControlService, nodeControlHandler } = require(resolve(process.argv[3]))
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  let service, server
  process.on('message', async (message) => {
    try {
      if (message.action === 'start') {
        service = await NodeControlService.open(message.config, { privateTargets: [message.target] })
        const handler = nodeControlHandler(service)
        server = httpServer((req, res) => { void handler(req, res) })
        const port = await listen(server); histogram.enable()
        process.send({ id: message.id, port })
      } else if (message.action === 'sample') {
        process.send({ id: message.id, eventLoopMs: { p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 }, rssBytes: process.memoryUsage().rss })
        histogram.reset()
      } else if (message.action === 'stop') {
        histogram.disable(); server.closeAllConnections(); await close(server); await service.close()
        process.send({ id: message.id }); process.disconnect()
      }
    } catch (error) { process.send({ id: message.id, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_PROBE_SERVICE_FAILED' }) }
  })
} else {
  const modulePath = resolve(process.argv[2] ?? '.operator-dist/node-control.cjs')
  const outputPath = resolve(process.argv[3] ?? 'release/network-scale-evidence/metering.json')
  const root = mkdtempSync(join(tmpdir(), 'laixin-metering-'))
  const cleanup = [], sockets = new Set()
  const track = (socket) => { sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)) }
  let child
  try {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt'), '-subj', '/CN=reality.test.invalid', '-days', '1'], { stdio: 'pipe' })
    const tls = tlsServer({ key: readFileSync(join(root, 'tls.key')), cert: readFileSync(join(root, 'tls.crt')), minVersion: 'TLSv1.3', ecdhCurve: 'X25519', ALPNProtocols: ['h2', 'http/1.1'] })
    tls.on('connection', track)
    const targetPort = await listen(tls)
    const echo = createServer((socket) => { track(socket); socket.on('data', (chunk) => { if (!socket.write(chunk)) { socket.pause(); socket.once('drain', () => socket.resume()) } }) })
    const echoPort = await listen(echo)
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([close(tls), close(echo)]) })
    const keys = generateKeyPairSync('x25519'), controlPort = await freePort(), first = await freePort()
    const config = { stateDir: join(root, 'state'), nodeId: 'local-load-probe', publicHost: '127.0.0.1', token: randomBytes(32).toString('base64url'),
      xrayPath: xrayExecutable(), controlPort, clientPortFirst: first, clientPortLast: Math.min(65535, first + 31),
      reality: { target: `127.0.0.1:${targetPort}`, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url'),
        publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), shortId: '1234', serverName: 'reality.test.invalid' } }
    child = fork(fileURLToPath(import.meta.url), ['--service', modulePath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    let nextId = 0
    const ipc = (body) => new Promise((resolve, reject) => {
      const id = ++nextId
      const done = () => { clearTimeout(timer); child.off('message', got); child.off('exit', failed) }
      const failed = () => { done(); reject(new Error('LOCAL_PROBE_CHILD_EXIT')) }
      const got = (message) => { if (message.id !== id) return; done(); if (message.error) reject(new Error(message.error)); else resolve(message) }
      const timer = setTimeout(() => { done(); reject(new Error('LOCAL_PROBE_IPC_TIMEOUT')) }, 30000)
      child.on('message', got); child.once('exit', failed); child.send({ ...body, id })
    })
    const { port } = await ipc({ action: 'start', config, target: { host: '127.0.0.1', port: echoPort } })
    cleanup.push(async () => { if (child.connected) await ipc({ action: 'stop' }) })
    const request = async (path, spec) => {
      const result = await fetch(`http://127.0.0.1:${port}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ spec }), signal: AbortSignal.timeout(10000) })
      const body = await result.json()
      if (!result.ok) throw new Error(body.code ?? 'LOCAL_PROBE_HTTP_FAILED')
      return body.result
    }
    const accounts = []
    for (let i = 0; i < 4; i++) {
      const spec = { inboundIds: [1], client: { email: `lx-${randomBytes(16).toString('hex')}`, id: randomUUID(), subId: randomBytes(24).toString('hex'), totalGB: 512 * 1024 * 1024,
        expiryTime: Date.now() + 300000, enable: true, flow: 'xtls-rprx-vision', limitIp: 0, reset: 0, resetDay: 0, trafficReset: 'never' } }
      await request('ensure', spec)
      const configuration = await request('configuration', spec)
      const bridge = createLocalBridge({ dataDir: join(root, `bridge-${i}`), executablePath: config.xrayPath, listenPort: 0,
        outbound: buildVlessOutbound(configuration.node, configuration.credential), verifyUrl: `http://127.0.0.1:${echoPort}/verify` })
      cleanup.push(() => bridge.close()); await bridge.listen(); accounts.push({ spec, bridge })
    }
    const read = (socket, size) => new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); socket.off('readable', attempt); socket.off('close', failed); socket.off('error', failed) }
      const failed = () => { done(); reject(new Error('LOCAL_PROBE_STREAM_CLOSED')) }
      const attempt = () => { const bytes = socket.read(size); if (bytes) { done(); resolve(bytes) } }
      const timer = setTimeout(() => { done(); reject(new Error('LOCAL_PROBE_STREAM_TIMEOUT')) }, 10000)
      socket.on('readable', attempt); socket.once('close', failed); socket.once('error', failed); attempt()
    })
    const stream = async (account) => {
      const socket = connect({ host: '127.0.0.1', port: account.bridge.port() }); track(socket); socket.setNoDelay(true)
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      socket.write(Buffer.from([5, 1, 0])); if ((await read(socket, 2))[1] !== 0) throw new Error('LOCAL_PROBE_SOCKS_FAILED')
      const bytes = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 0]); bytes.writeUInt16BE(echoPort, 8)
      socket.write(bytes); if ((await read(socket, 10))[1] !== 0) throw new Error('LOCAL_PROBE_SOCKS_FAILED')
      return socket
    }
    const measurements = []
    for (const scenario of [{ connections: 1, chunkBytes: 1024 }, { connections: 8, chunkBytes: 1024 }, { connections: 8, chunkBytes: 65536 }]) {
      const connections = await Promise.all(Array.from({ length: scenario.connections }, (_, i) => stream(accounts[i % accounts.length])))
      const before = await Promise.all(accounts.map(({ spec }) => request('usage', spec)))
      const payload = Buffer.alloc(scenario.chunkBytes, 77), counts = accounts.map(() => 0), responseMs = [], controlMs = []
      await ipc({ action: 'sample' })
      let probing = true
      const start = performance.now(), until = start + 3000
      const probe = (async () => { while (probing) { const t = performance.now(); await request('usage', accounts[0].spec); controlMs.push(performance.now() - t); await delay(50) } })()
      try {
        await Promise.all(connections.map(async (socket, index) => {
          while (performance.now() < until) {
            const t = performance.now(); socket.write(payload); const returned = await read(socket, payload.length)
            if (!returned.equals(payload)) throw new Error('LOCAL_PROBE_PAYLOAD_MISMATCH')
            responseMs.push(performance.now() - t); counts[index % accounts.length]++
          }
        }))
      } finally { probing = false; await probe; for (const socket of connections) socket.destroy() }
      const elapsedMs = performance.now() - start
      const sample = await ipc({ action: 'sample' })
      const after = await Promise.all(accounts.map(({ spec }) => request('usage', spec)))
      const expectedBytes = counts.reduce((sum, n) => sum + n, 0) * payload.length * 2
      const meteredBytes = after.reduce((sum, value, i) => sum + value.usage.upload + value.usage.download - before[i].usage.upload - before[i].usage.download, 0)
      const perAuthorizationMatched = after.every((value, i) => value.usage.upload - before[i].usage.upload === counts[i] * payload.length && value.usage.download - before[i].usage.download === counts[i] * payload.length)
      if (!perAuthorizationMatched || meteredBytes !== expectedBytes) throw new Error('LOCAL_PROBE_METER_MISMATCH')
      measurements.push({ ...scenario, authorizations: 4, elapsedMs, expectedBytes, meteredBytes, perAuthorizationMatched, mibPerSecondBidirectional: expectedBytes / 1048576 / (elapsedMs / 1000),
        responseMs: { p95: percentile(responseMs, .95), p99: percentile(responseMs, .99) }, control: { samples: controlMs.length, p95Ms: percentile(controlMs, .95), p99Ms: percentile(controlMs, .99) }, eventLoopMs: sample.eventLoopMs, companionRssBytes: sample.rssBytes })
      console.log(JSON.stringify(measurements.at(-1)))
    }
    mkdirSync(resolve(outputPath, '..'), { recursive: true })
    writeFileSync(outputPath, JSON.stringify({ date: new Date().toISOString(), modulePath, node: process.version, platform: process.platform, arch: process.arch,
      cpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAfter: freemem(), loadAverageAfter: loadavg(),
      scope: 'Local loopback official Xray + actual NodeControl durable meter; client and echo separate from companion process. 3 second rounds, stop-and-wait per stream; not a server sizing or customer-speed benchmark.', measurements }, null, 2))
  } finally {
    for (const run of cleanup.reverse()) { try { await run() } catch { process.exitCode = 1 } }
    if (child?.connected) { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }
    for (const socket of sockets) socket.destroy()
  }
}
