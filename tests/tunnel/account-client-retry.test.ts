// Phase 1(AccountClient 重试):幂等 GET(connection/application/configuration)碰瞬时网络抖动
// (连接复位、DNS 瞬断)时,基线一次失败就把「服务不可用」怼到界面/接续流程上。改后:小梯子
// 重试(3 次尝试,250/750ms)吸收抖动;⛔ POST(回执/诊断)不重试——重复提交;服务器给过
// 答案的(401/404/409/410→各自精确码)不重试——那是结论不是抖动。
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { NetworkAccountClient } from '../../app/main/tunnel/account-client'

const session = { accountId: 'customer-a', accessToken: 'a'.repeat(40), deviceId: 'device-one' }

function start(behavior: (req: IncomingMessage, res: ServerResponse, call: number) => void): Promise<{ base: string; calls: () => number; close: () => Promise<void> }> {
  let count = 0
  const server: Server = createServer((req, res) => { count += 1; behavior(req, res, count) })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/network/`
      resolve({ base, calls: () => count, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }) })
    })
  })
}

const client = (base: string): { request: (...args: unknown[]) => Promise<unknown> } =>
  new NetworkAccountClient(base) as unknown as { request: (...args: unknown[]) => Promise<unknown> }

describe('AccountClient 幂等 GET 抖动重试', () => {
  it('第一发被掐断连接:重试后成功,上游看到 2 次', async () => {
    const s = await start((req, res, call) => {
      if (call === 1) { req.destroy(); return } // 瞬时抖动:连接被掐,fetch 抛网络错
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ application: { id: 'lx-' + 'a'.repeat(32), status: 'ready', expiresAt: 9999999999999 } }))
    })
    try {
      const c = client(s.base)
      const body = await c.request('application', session, new AbortController().signal, 16384, 'application/json') as { body: Buffer }
      expect(JSON.parse(body.body.toString('utf8')).application.status).toBe('ready')
      expect(s.calls()).toBe(2)
    } finally { await s.close() }
  }, 15_000)

  it('POST 不重试:掐断一次就如实「服务不可用」,⛔ 重复提交回执/诊断', async () => {
    const s = await start((_req, res, call) => {
      if (call <= 3) { res.destroy(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    try {
      const c = client(s.base)
      await expect(c.request('acknowledgement', session, new AbortController().signal, 2048, 'application/json', undefined, { ok: 1 }))
        .rejects.toMatchObject({ message: 'NETWORK_SERVICE_UNAVAILABLE' })
      expect(s.calls()).toBe(1)
    } finally { await s.close() }
  }, 15_000)

  it('重试用尽仍失败:照旧「服务不可用」,客户端契约不变', async () => {
    const s = await start((_req, res) => { res.destroy() })
    try {
      const c = client(s.base)
      await expect(c.request('application', session, new AbortController().signal, 16384, 'application/json'))
        .rejects.toMatchObject({ message: 'NETWORK_SERVICE_UNAVAILABLE' })
      expect(s.calls()).toBe(3)
    } finally { await s.close() }
  }, 15_000)
})
