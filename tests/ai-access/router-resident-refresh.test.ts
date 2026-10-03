import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AiRouterController } from '../../app/main/ai-access/router-controller'
import { removeAiRouterRuntime, writeAiRouterRuntime } from '../../app/main/ai-access/router-runtime'
import { routerProof } from '../../app/main/ai-access/router-protocol'
import { installAiRouterResident } from '../../app/main/ai-access/router-resident'
import { aiAccessShells, AiAccessService, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'

vi.mock('../../app/main/ai-access/router-resident', () => ({
  AI_ROUTER_ARGUMENT: '--laixin-ai-router', installAiRouterResident: vi.fn(async () => undefined),
  removeAiRouterResident: vi.fn(async () => undefined), wakeAiRouterResident: vi.fn(async () => undefined)
}))
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.mocked(installAiRouterResident).mockReset().mockResolvedValue(undefined)
})
async function fixture() {
  let bootId = 'a'.repeat(32), valid = true, refreshes = 0
  const root = await mkdtemp(join(tmpdir(), 'router-refresh-'))
  roots.push(root)
  await mkdir(join(root, 'ai-access'))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.split('/').at(-1)!
    const nonce = action === 'ready' ? url.searchParams.get('nonce')! : String(req.headers['x-laixin-nonce'])
    const port = req.socket.localPort!
    if (req.headers['x-laixin-proof'] !== routerProof('b'.repeat(64), action, nonce, bootId, port)) {
      res.writeHead(401).end(); return
    }
    if (action === 'refresh') refreshes++
    res.end(JSON.stringify({ protocol: 1, pid: process.pid, bootId, models: 1,
      proof: valid ? routerProof('b'.repeat(64), `${action}-ack`, nonce, bootId, port) : '0'.repeat(64) }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  const port = address.port
  const state: AiAccessState = { version: 1, selected: {}, relay: { port, token: 'c'.repeat(64) },
    codexMultiRelay: { port, identitySecret: 'b'.repeat(64) } }
  const writeRuntime = () => writeAiRouterRuntime(join(root, 'ai-access'), { pid: process.pid, bootId, port, token: 'c'.repeat(64) })
  await writeRuntime()
  const spec = { executable: process.execPath, logDir: join(root, 'logs') }
  return { state, controller: new AiRouterController(root, spec), newController: () => new AiRouterController(root, spec),
    restart: async () => { bootId = 'd'.repeat(32); await writeRuntime() },
    pause: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await removeAiRouterRuntime(join(root, 'ai-access'), bootId)
    },
    resume: async () => { await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)); await writeRuntime() },
    setValid: (value: boolean) => { valid = value }, refreshes: () => refreshes }
}

describe('路由刷新复用已校准常驻定义', () => {
  it('恢复已有单模型接入只经过一次 ensureReady', async () => {
    const f = await fixture()
    const state: AiAccessState = { ...f.state, migrations: { api15rD: 1 }, selected: { codex: 'deepseek' },
      relayShells: ['codex'], shellKeys: { codex: { deepseek: 'sk-fixture-0123456789012345' } } }
    const ensureReady = vi.spyOn(f.controller, 'ensureReady')
    const service = new AiAccessService({ read: async () => state, write: async () => undefined },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), new AiGateway(), { independentRouting: true }, f.controller)
    await service.initialize()
    expect(f.refreshes()).toBe(1)
    expect(ensureReady).toHaveBeenCalledTimes(1)
  })

  it('Windows 后台任务被系统拒绝时保留明确故障码，不压成笼统的本机服务失败', async () => {
    const f = await fixture()
    const state: AiAccessState = { ...f.state, migrations: { api15rD: 1 }, selected: { codex: 'deepseek' },
      relayShells: ['codex'], shellKeys: { codex: { deepseek: 'sk-fixture-0123456789012345' } } }
    vi.mocked(installAiRouterResident).mockRejectedValueOnce(new Error('AI_ROUTER_RESIDENT_TASK_PERMISSION_DENIED'))
    const service = new AiAccessService({ read: async () => state, write: async () => undefined },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), new AiGateway(), { independentRouting: true }, f.controller)

    await service.initialize()

    expect(await service.serviceStatus()).toMatchObject({ running: false, startupError: 'local_service_permission_denied' })
  })

  it('Windows 多模型路由在同一任务权限失败时也保留明确故障码', async () => {
    const f = await fixture()
    const state: AiAccessState = { ...f.state, migrations: { api15rD: 1 }, codexMode: 'multi',
      codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }],
      shellKeys: { codex: { deepseek: 'sk-fixture-0123456789012345' } } }
    vi.mocked(installAiRouterResident).mockRejectedValueOnce(new Error('AI_ROUTER_RESIDENT_TASK_PERMISSION_DENIED'))
    const service = new AiAccessService({ read: async () => state, write: async () => undefined },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), new AiGateway(), { independentRouting: true }, f.controller)

    await service.initialize()

    expect(await service.serviceStatus()).toMatchObject({ running: false, startupError: 'local_service_permission_denied' })
  })

  it('同一可信路由重复刷新只安装一次，仍逐次发送签名刷新', async () => {
    const f = await fixture()
    for (let index = 0; index < 3; index++) expect(await f.controller.refresh(f.state)).toBe(true)
    expect(installAiRouterResident).toHaveBeenCalledTimes(1)
    expect(f.refreshes()).toBe(3)
  })

  it('并发首次刷新共享一次安装，失败后不留下成功缓存', async () => {
    const f = await fixture()
    let release!: () => void
    vi.mocked(installAiRouterResident).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const requests = [f.controller.refresh(f.state), f.controller.refresh(f.state)]
    await vi.waitFor(() => expect(installAiRouterResident).toHaveBeenCalled())
    release()
    expect(await Promise.all(requests)).toEqual([true, true])
    expect(installAiRouterResident).toHaveBeenCalledTimes(1)
    const reopened = f.newController()
    vi.mocked(installAiRouterResident).mockRejectedValueOnce(new Error('fixture install failure'))
    expect(await reopened.refresh(f.state)).toBe(false)
    expect(await reopened.refresh(f.state)).toBe(true)
    expect(installAiRouterResident).toHaveBeenCalledTimes(3)
  })

  it('进程身份变化与重开 GUI 都重新校准常驻任务', async () => {
    const f = await fixture()
    expect(await f.controller.refresh(f.state)).toBe(true)
    await f.restart()
    expect(await f.controller.refresh(f.state)).toBe(true)
    expect(await f.newController().refresh(f.state)).toBe(true)
    expect(installAiRouterResident).toHaveBeenCalledTimes(3)
  })

  it('更新常驻定义换掉进程时，刷新使用新身份', async () => {
    const f = await fixture()
    vi.mocked(installAiRouterResident).mockImplementationOnce(() => f.restart())
    expect(await f.controller.refresh(f.state)).toBe(true)
    expect(f.refreshes()).toBe(1)
    expect(await f.controller.refresh(f.state)).toBe(true)
    expect(installAiRouterResident).toHaveBeenCalledTimes(1)
  })

  it('缓存不能替代 HMAC，伪造响应不得刷新', async () => {
    const f = await fixture()
    expect(await f.controller.refresh(f.state)).toBe(true)
    f.setValid(false)
    expect(await f.controller.refresh(f.state)).toBe(false)
    expect(f.refreshes()).toBe(1)
  })

  it('停止清除安装记录，即使同一进程恢复也重新安装', async () => {
    const f = await fixture()
    expect(await f.controller.refresh(f.state)).toBe(true)
    await f.pause()
    expect(await f.controller.stop(f.state)).toBe(true)
    await f.resume()
    expect(await f.controller.refresh(f.state)).toBe(true)
    expect(installAiRouterResident).toHaveBeenCalledTimes(2)
  })
})
