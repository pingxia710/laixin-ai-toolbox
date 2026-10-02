import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { shellConfigFixture } from './fixtures/shell-config'
import { AiAccessService, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiRouterGateway } from '../../app/main/ai-access/router-gateway'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
async function fixture() {
  const f = shellConfigFixture()
  disposals.push(() => f.dispose())
  for (const shell of ['codex', 'claude', 'hermes'] as const) await f.service.configureProvider(shell, 'deepseek', `sk-fixture-${shell}-0123456789`, 'deepseek-v4-pro')
  await f.gateway.stop()
  const runtimes: AiRouterGateway[] = []
  let active: AiRouterGateway | undefined
  let reject = false
  const ensureReady = async (state: AiAccessState) => {
    if (!active?.primary.baseUrl) {
      active = new AiRouterGateway({ fetch: async (input, init) => reject ? Response.json({ error: { message: 'rate limited' } }, { status: 429 }) : f.fetcher(input, init) })
      runtimes.push(active)
      await active.start(state, 'c'.repeat(64))
    }
    return { baseUrl: active.primary.baseUrl!, runtime: { pid: process.pid, bootId: 'd'.repeat(32), token: 'c'.repeat(64), port: state.codexMultiRelay!.port } }
  }
  const controller = { ensureReady, refresh: async (state: AiAccessState) => { await ensureReady(state); await active!.refresh(state); return true },
    probe: async (state: AiAccessState) => active?.primary.baseUrl ? ensureReady(state) : undefined,
    gatewaySnapshot: async () => active?.primary.baseUrl ? active.snapshot() : undefined,
    isolation: async (state: AiAccessState, command: Parameters<AiRouterGateway['isolation']>[0]) => active!.isolation(command, state),
    stop: async () => { await active?.stop(0); return true } } as unknown as AiRouterController
  const service = new AiAccessService(f.store, f.adapters, new AiGateway({ fetch: f.fetcher }), { independentRouting: true }, controller)
  disposals.push(async () => { await service.stop(); for (const runtime of runtimes) await runtime.stop(0) })
  await service.initialize()
  return { ...f, service, runtime: () => active!, reject: (value: boolean) => { reject = value } }
}

describe('independent listener preserves existing recovery behavior', () => {
  it('原端口被外部程序占用时轮换地址和令牌，三壳配置及所选模型正确接续', async () => {
    const f = await fixture()
    const before = f.state().relay!
    await f.runtime().stop(0)
    const blocker: Server = createServer((_req, res) => res.end('foreign'))
    await new Promise<void>(resolve => blocker.listen(before.port, '127.0.0.1', resolve))
    disposals.push(async () => { blocker.closeAllConnections(); await new Promise<void>(resolve => blocker.close(() => resolve())) })
    const result = await f.service.recoverAccess('manual')
    expect(result).toMatchObject({ outcome: 'repaired', rewroteShells: ['codex', 'claude', 'hermes'] })
    expect(f.state().relay!.port).not.toBe(before.port)
    expect(f.state().relay!.token).not.toBe(before.token)
    expect(f.state().shellModels?.codex?.deepseek).toBe('deepseek-v4-pro')
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok', claude: 'ok', hermes: 'ok' })
    expect(f.runtime().snapshot().service.routes).toHaveLength(3)
    expect(f.data.get(f.codexPath)).toContain(`127.0.0.1:${f.state().relay!.port}`)
  })

  it('路由器在跑但单模型端口被外部占用:恢复链轮换单模型端口,不报配置中断', async () => {
    const f = await fixture()
    const before = f.state().relay!
    await f.runtime().stop(0)
    const blocker: Server = createServer((_req, res) => res.end('foreign'))
    await new Promise<void>(resolve => blocker.listen(before.port, '127.0.0.1', resolve))
    disposals.push(async () => { blocker.closeAllConnections(); await new Promise<void>(resolve => blocker.close(() => resolve())) })
    const result = await f.service.recoverAccess('manual')
    expect(result).toMatchObject({ outcome: 'repaired' })
    expect(f.state().relay!.port).not.toBe(before.port)
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok', claude: 'ok', hermes: 'ok' })
  })

  it('客户手动探测同一绑定成功后，独立客户端路由的旧错误缓存立即失效', async () => {
    const f = await fixture()
    const state = f.state()
    const call = () => fetch(`http://127.0.0.1:${state.relay!.port}/codex/deepseek/v1/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${state.relay!.token}` }, body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'fixture' }) })
    f.reject(true)
    expect((await call()).status).toBe(429)
    f.reject(false)
    await f.service.testProvider('codex', 'deepseek')
    expect((await call()).status).toBe(200)
  })
})
