import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiRouterController } from '../../app/main/ai-access/router-controller'
import { routerProof } from '../../app/main/ai-access/router-protocol'
import { writeAiRouterRuntime } from '../../app/main/ai-access/router-runtime'
import type { AiAccessState } from '../../app/main/ai-access/service'

vi.mock('../../app/main/ai-access/router-resident', () => ({
  AI_ROUTER_ARGUMENT: '--laixin-ai-router',
  installAiRouterResident: vi.fn(async () => undefined),
  removeAiRouterResident: vi.fn(async () => undefined),
  wakeAiRouterResident: vi.fn(async () => undefined)
}))

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function state(port: number): AiAccessState {
  return {
    version: 1, selected: {}, codexMode: 'multi',
    codexMultiRelay: { port, identitySecret: 'b'.repeat(64) },
    shellKeys: { codex: { deepseek: 'sk-fixture-deepseek-0123456789' } },
    codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }]
  }
}

async function fixtureServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
  return { server, port: address.port }
}

async function controller(port: number, bootId = 'a'.repeat(32)): Promise<{ root: string; controller: AiRouterController }> {
  const root = await mkdtemp(join(tmpdir(), 'ai-router-status-'))
  roots.push(root)
  await mkdir(join(root, 'ai-access'), { recursive: true })
  await writeAiRouterRuntime(join(root, 'ai-access'), { pid: process.pid, bootId, port, token: 'c'.repeat(64) })
  return { root, controller: new AiRouterController(root, { executable: process.execPath, logDir: join(root, 'logs') }) }
}

describe('headless 路由脱敏状态', () => {
  it('没有运行时明确返回未运行和当前池数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-router-status-'))
    roots.push(root)
    const value = await new AiRouterController(root, { executable: process.execPath, logDir: join(root, 'logs') }).status(state(43210))
    expect(value).toEqual({ running: false, modelCount: 1, error: 'not_running' })
  })

  it('端口冒充者不能伪造运行或最近模型，返回安全错误分类', async () => {
    const fake = await fixtureServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ pid: process.pid, bootId: 'a'.repeat(32), proof: '0'.repeat(64), models: 1,
        lastDesktopUse: { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', at: '2026-09-27T00:00:00.000Z' } }))
    })
    const f = await controller(fake.port)
    const value = await f.controller.status(state(fake.port))
    expect(value).toEqual({ running: false, modelCount: 1, error: 'port_conflict' })
    expect(JSON.stringify(value)).not.toContain('lastDesktopUse')
  })

  it('只接受当前 HMAC 路由返回的池数量和严格 Desktop 成功摘要', async () => {
    const bootId = 'a'.repeat(32)
    const trusted = await fixtureServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nonce = url.searchParams.get('nonce') ?? ''
      res.setHeader('content-type', 'application/json')
      const port = req.socket.localPort
      if (!port) throw new Error('fixture address missing')
      if (req.headers['x-laixin-proof'] !== routerProof('b'.repeat(64), 'ready', nonce, bootId, port)) {
        res.writeHead(403); res.end(); return
      }
      res.end(JSON.stringify({ protocol: 1, pid: process.pid, bootId,
        proof: routerProof('b'.repeat(64), 'ready-ack', nonce, bootId, port), models: 1,
        lastDesktopUse: { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', at: '2026-09-27T00:00:00.000Z' } }))
    })
    const f = await controller(trusted.port, bootId)
    await expect(f.controller.status(state(trusted.port))).resolves.toEqual({
      running: true, modelCount: 1,
      lastDesktopUse: { provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', at: '2026-09-27T00:00:00.000Z' }
    })
  })

  it('HMAC 正确但控制协议不兼容时要求工具箱修复，且不回传 PID', async () => {
    const bootId = 'a'.repeat(32)
    const incompatible = await fixtureServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nonce = url.searchParams.get('nonce') ?? ''
      const port = req.socket.localPort
      if (!port) throw new Error('fixture address missing')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 0, pid: process.pid, bootId,
        proof: routerProof('b'.repeat(64), 'ready-ack', nonce, bootId, port), models: 1 }))
    })
    const f = await controller(incompatible.port, bootId)
    const value = await f.controller.status(state(incompatible.port))
    expect(value).toEqual({ running: false, modelCount: 1, error: 'protocol_incompatible' })
    expect(JSON.stringify(value)).not.toContain('pid')
  })

  it('HMAC、runtime 和席位一致的旧协议路由可受控停止，释放端口后才完成交接', async () => {
    const bootId = 'a'.repeat(32)
    let stopped = false
    const legacy = await fixtureServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nonce = req.method === 'GET' ? url.searchParams.get('nonce') ?? '' : String(req.headers['x-laixin-nonce'] ?? '')
      const port = req.socket.localPort
      if (!port) throw new Error('fixture address missing')
      const action = url.pathname.endsWith('/stop') ? 'stop' : 'ready'
      if (action === 'stop') {
        expect(req.headers['x-laixin-proof']).toBe(routerProof('b'.repeat(64), 'stop', nonce, bootId, port))
        stopped = true
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 0, pid: process.pid, bootId,
        proof: routerProof('b'.repeat(64), `${action}-ack`, nonce, bootId, port), models: 1 }))
      if (action === 'stop') setImmediate(() => legacy.server.close())
    })
    const f = await controller(legacy.port, bootId)
    await writeFile(join(f.root, 'ai-access', 'ai-router.seat'), JSON.stringify({ pid: process.pid, bootId, startedAt: Date.now() }))

    await expect(f.controller.stop(state(legacy.port))).resolves.toBe(true)
    expect(stopped).toBe(true)
  })

  it('HMAC 不正确的旧协议端口不得收到停止请求', async () => {
    const bootId = 'a'.repeat(32)
    let stopRequests = 0
    const unrelated = await fixtureServer((req, res) => {
      if ((req.url ?? '').includes('/stop')) stopRequests += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 0, pid: process.pid, bootId, proof: '0'.repeat(64), models: 1 }))
    })
    const f = await controller(unrelated.port, bootId)

    await expect(f.controller.stop(state(unrelated.port))).resolves.toBe(false)
    expect(stopRequests).toBe(0)
  })

  it('runtime 缺失但配置端口仍被占用时不得假定旧路由已停止', async () => {
    let stopRequests = 0
    const occupied = await fixtureServer((req, res) => {
      if ((req.url ?? '').includes('/stop')) stopRequests += 1
      res.writeHead(404)
      res.end()
    })
    const root = await mkdtemp(join(tmpdir(), 'ai-router-status-no-runtime-'))
    roots.push(root)
    await mkdir(join(root, 'ai-access'), { recursive: true })
    const current = new AiRouterController(root, { executable: process.execPath, logDir: join(root, 'logs') })

    await expect(current.stop(state(occupied.port))).resolves.toBe(false)
    expect(stopRequests).toBe(0)
  })

  it('runtime 与 HMAC 响应 bootId 不一致时不得停止端口占用者', async () => {
    const runtimeBootId = 'a'.repeat(32)
    const otherBootId = 'd'.repeat(32)
    let stopRequests = 0
    const mismatch = await fixtureServer((req, res) => {
      if ((req.url ?? '').includes('/stop')) stopRequests += 1
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nonce = url.searchParams.get('nonce') ?? ''
      const port = req.socket.localPort!
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 0, pid: process.pid, bootId: otherBootId,
        proof: routerProof('b'.repeat(64), 'ready-ack', nonce, otherBootId, port), models: 1 }))
    })
    const f = await controller(mismatch.port, runtimeBootId)
    await writeFile(join(f.root, 'ai-access', 'ai-router.seat'), JSON.stringify({ pid: process.pid, bootId: runtimeBootId }))

    await expect(f.controller.stop(state(mismatch.port))).resolves.toBe(false)
    expect(stopRequests).toBe(0)
  })

  it('HMAC 正确但驻留路由池数量过期时不冒充正在服务当前池', async () => {
    const bootId = 'a'.repeat(32)
    const stale = await fixtureServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nonce = url.searchParams.get('nonce') ?? ''
      const port = req.socket.localPort
      if (!port) throw new Error('fixture address missing')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: 1, pid: process.pid, bootId,
        proof: routerProof('b'.repeat(64), 'ready-ack', nonce, bootId, port), models: 2 }))
    })
    const f = await controller(stale.port, bootId)
    await expect(f.controller.status(state(stale.port))).resolves.toEqual({ running: false, modelCount: 1, error: 'stale_route' })
  })
})
