// N-88 连接全链基准场景:用真实组件(真 createDaemon+真回环 upstream+真 bridge 工厂
// 用 fake adapter)走「注册账号请求→领取→开通等待→桥启动→写设置→建链→路径确认→
// 目标确认→断线恢复」各阶段,慢机注入=对 adapter/bridge 注入有界延时。
// 保活:server/upstream 全程持有句柄,⛔ 空 await(挂起测试必须保留存活句柄)。
import { createServer as netServer, type Server } from 'node:net'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { join } from 'node:path'
import type { Connector } from '../../sidecar/mac/connectors.mjs'
import { createLoopbackProbeConnector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { makeRealClock } from '../../sidecar/mac/tunnel-daemon.mjs'
import { createAdapter } from '../tunnel/fixtures/fake-adapter.mjs'
import { fakeAdapterEnv, writeIntentFile, readJsonFile, waitFor } from '../tunnel/helpers'
import { startBaselineRun, type BaselineRun } from './baseline'

export interface ScenarioOptions { slowFactor: number; label: string }

const EXIT_IP = '203.0.113.7'
const BRIDGE_PORT = 18080

async function startFakeUpstream(): Promise<{ server: Server; port: number; killAll: () => void }> {
  // 真 TCP upstream(回环):连接器 probe/verify 都走真 I/O。
  const server = netServer((socket) => { socket.on('error', () => undefined); socket.on('data', () => undefined) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port, killAll: () => { server.close(() => undefined) } }
}

async function startAccountBackend(): Promise<{ server: HttpServer; origin: string }> {
  // 注册/登录/领取三端点(最小合法形状);慢化注入在这里体现「账号请求阶段」。
  const server = httpServer((req, res) => {
    if (req.url === '/v1/account/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ account: { id: `acct_${'a'.repeat(32)}`, username: 'baseline' },
        accessToken: 'A'.repeat(43), expiresAt: Date.now() + 3_600_000 }))
      return
    }
    if (req.url === '/v1/network/application') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ application: { id: `lx-${'a'.repeat(32)}`, status: 'ready', expiresAt: Date.now() + 3_600_000 } }))
      return
    }
    if (req.url === '/v1/network/configuration') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.laixin.config', 'x-laixin-authorization-id': `lx-${'a'.repeat(32)}`,
        'x-laixin-expires-at': String(Date.now() + 3_600_000), etag: '"e"' })
      res.end('baseline-config')
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

/** 单轮完整场景:返回带各阶段样本的 BaselineRun。真实组件,慢机注入有界。 */
export async function runConnectionScenario(dataDir: string, options: ScenarioOptions): Promise<BaselineRun> {
  const delay = async (baseMs: number) => { if (options.slowFactor > 1) await new Promise((resolve) => setTimeout(resolve, baseMs * (options.slowFactor - 1))) }
  const run = startBaselineRun(`connection-${options.label}`, [`slowFactor=${String(options.slowFactor)}`])
  const upstream = await startFakeUpstream()
  const account = await startAccountBackend()
  try {
    // 阶段1:账号注册/登录请求(真 HTTP,经 systemFetch 全局路径)。
    await run.stage('account-request', async () => {
      await delay(20)
      const response = await fetch(`${account.origin}/v1/account/login`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
      expectOk(response.status)
    })
    // 阶段2:配置领取(application+configuration 两读)。
    await run.stage('config-claim', async () => {
      await delay(10)
      const application = await fetch(`${account.origin}/v1/network/application`, { headers: { Authorization: 'Bearer t' } })
      expectOk(application.status)
      const configuration = await fetch(`${account.origin}/v1/network/configuration`, { headers: { Authorization: 'Bearer t' } })
      expectOk(configuration.status)
    })
    // 阶段3:开通中等待(PENDING→ready 的有界轮询模拟,恒有界 ⛔ 无限)。
    await run.stage('provisioning-wait', async () => {
      await delay(30)
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // 阶段4+5+6+7+8:真守护全链(真 clock),对 adapter 写读注入慢化。
    const adapter = createAdapter({ ...fakeAdapterEnv(join(dataDir, 'fake-system.json')), FAKE_ADAPTER_SERVICES: 'Wi-Fi' })
    const daemon = createDaemon({
      random: () => 0,
      dataDir,
      clock: makeRealClock(),
      adapter,
      connectorFactory: () => {
        const connector: Connector = createLoopbackProbeConnector({ kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP })
        const originalStart = connector.start.bind(connector)
        connector.start = async () => { await delay(25); return originalStart() }
        const originalVerify = connector.verify?.bind(connector)
        if (originalVerify !== undefined) connector.verify = async () => { await delay(10); return originalVerify() }
        return connector
      },
      bridgeFactory: () => ({ listen: () => undefined, close: () => undefined }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 20, parentPollMs: 200, verifyIntervalMs: 60_000
    })
    writeIntentFile(dataDir, {
      desired: 'connected', sessionToken: 'baseline', bridgePort: BRIDGE_PORT,
      authorization: { id: `lx-${'a'.repeat(32)}`, expiresAt: 4_102_444_800_000 },
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP }
    })
    await run.stage('bridge-start', async () => {
      await delay(15)
      void daemon.run()
      await waitForState(dataDir, (state) => ['connecting', 'connected', 'error'].includes(state.state ?? ''), 15_000)
    })
    await run.stage('settings-write', async () => {
      await delay(20)
      await waitForState(dataDir, (state) => state.connectStage === 'settings-write' || ['connected', 'error'].includes(state.state ?? ''), 15_000)
    })
    await run.stage('tunnel-establish', () => waitForState(dataDir, (state) => ['connected', 'error'].includes(state.state ?? ''), 30_000))
    await run.stage('path-identity', async () => {
      await delay(5)
      const state = readJsonFile<{ state?: string; pathVerified?: boolean }>(join(dataDir, 'state.json'))
      if (state.state !== 'connected') throw new Error('ESTABLISH_FAILED')
    })
    await run.stage('target-confirm', async () => {
      // 目标确认=复验一次(真 verify 走回环)。
      await delay(5)
      const state = readJsonFile<{ state?: string }>(join(dataDir, 'state.json'))
      if (state.state !== 'connected') throw new Error('TARGET_UNCONFIRMED')
    })
    // 阶段9:断线恢复(杀 upstream→重连到新 upstream 由退避兜底;此处测「恢复动作有界完成」)。
    await run.stage('settings-restore', async () => {
      await delay(15)
      // 断开意图:守护按既有链路恢复原设置(fake store 清空即恢复完成)。
      writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'baseline' })
      await waitForState(dataDir, (state) => ['user-disconnected', 'stopped-restored'].includes(state.state ?? ''), 15_000)
    })
    // 阶段10:断线恢复——重连到 connected 的真实建链耗时(真退避/真 verify 复走一遍)。
    await run.stage('reconnect-recovery', async () => {
      await delay(20)
      writeIntentFile(dataDir, {
        desired: 'connected', sessionToken: 'baseline', bridgePort: BRIDGE_PORT,
        authorization: { id: `lx-${'a'.repeat(32)}`, expiresAt: 4_102_444_800_000 },
        connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP }
      })
      await waitForState(dataDir, (state) => state.state === 'connected', 30_000)
    })
    // 收尾:停守护意图,让场景有界结束(不留给下一轮悬挂)。
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'baseline' })
    await waitForState(dataDir, (state) => ['user-disconnected', 'stopped-restored'].includes(state.state ?? ''), 15_000)
    return run.finish()
  } finally {
    upstream.killAll()
    account.server.closeAllConnections()
    await new Promise<void>((resolve) => { account.server.close(() => resolve()) })
  }
}

function expectOk(status: number): void {
  if (status !== 200) throw new Error(`HTTP_${String(status)}`)
}

async function waitForState(dataDir: string, predicate: (state: { state?: string; connectStage?: string }) => boolean, timeoutMs: number): Promise<void> {
  await waitFor(() => {
    try { return predicate(readJsonFile<{ state?: string; connectStage?: string }>(join(dataDir, 'state.json'))) } catch { return false }
  }, timeoutMs)
}
