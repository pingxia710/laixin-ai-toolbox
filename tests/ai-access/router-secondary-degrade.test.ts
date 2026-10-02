import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AiAccessState } from '../../app/main/ai-access/service'
import { AiRouterGateway } from '../../app/main/ai-access/router-gateway'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

function occupy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('foreign'))
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function release(occupied: { server: Server }): Promise<void> {
  return new Promise((resolve) => occupied.server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const { server, port } = await occupy()
  await release({ server })
  return port
}

function stateFixture(multiPort: number, relayPort: number): AiAccessState {
  return { version: 1, selected: {},
    codexMultiRelay: { port: multiPort },
    relay: { port: relayPort, token: 'r'.repeat(64) } } as AiAccessState
}

// API-13 把单模型监听搬进独立路由进程后,relay 端口被外部程序占用时旧实现会让整个进程退出
// (常驻 KeepAlive 再无限拉起,多模型接入被连坐)。期望:降级不退出、多模型监听仍活、
// 快照如实可见单模型缺失、端口释放后下一次 refresh 自愈补起。
describe('independent router secondary listener degrade', () => {
  it('relay 端口被占:start 不抛、primary 存活、快照报单模型缺失;端口释放后 refresh 自愈', async () => {
    const blocker = await occupy()
    disposals.push(async () => { await release(blocker) })
    const multiPort = await freePort()
    const router = new AiRouterGateway({ fetch: async () => new Response('{}', { status: 200 }) })
    disposals.push(async () => { await router.stop(0).catch(() => undefined) })
    const state = stateFixture(multiPort, blocker.port)

    await router.start(state, 'c'.repeat(64))

    expect(router.primary.baseUrl).toBeTruthy()
    expect(router.snapshot().secondaryMissing).toBe(true)

    await release(blocker)
    await router.refresh(state)
    expect(router.snapshot().secondaryMissing).toBeUndefined()
  })
})
