import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AiAccessState } from '../../app/main/ai-access/service'
import { AiAccessService, aiAccessShells } from '../../app/main/ai-access/service'
import type { AiRouterController } from '../../app/main/ai-access/router-controller'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const bootstrap = resolve('tests/ai-access/fixtures/router-electron-bootstrap.cjs')
const built = existsSync(resolve('out/main/index.js'))
const run = process.platform === 'darwin' && built ? describe : describe.skip
const keyA = 'sk-fixture-key-old-0123456789'
const keyB = 'sk-fixture-key-new-0123456789'
const model = 'laixin.deepseek.deepseek-flash'
const roots: string[] = []
const routers: number[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const pid of routers.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  while (Date.now() < deadline)
  throw new Error('fixture timeout')
}
async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('port unavailable')
  return address.port
}
function state(routerPort: number, key = keyA): AiAccessState {
  return { version: 1, selected: {}, codexMode: 'multi',
    relay: { port: 43123, token: 'c'.repeat(64) },
    codexMultiRelay: { port: routerPort, identitySecret: 'b'.repeat(64) },
    shellKeys: { codex: { deepseek: key } },
    codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: model }] }
}
function env(root: string, upstream: number): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env, TOOLBOX_API15R_TEST_ROOT: root, TOOLBOX_API15R_UPSTREAM_PORT: String(upstream),
    TOOLBOX_API15R_STATE_FILE: join(root, 'fixture-state.json'), TOOLBOX_API15R_FIXTURE: '1' }
  delete result.ELECTRON_RUN_AS_NODE
  return result
}
async function child(root: string, upstream: number, args: string[], timeoutMs = 9000): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly pid: number }> {
  const processChild = spawn(electron, [bootstrap, ...args], { env: env(root, upstream), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  processChild.stdout?.on('data', chunk => { stdout += String(chunk) })
  processChild.stderr?.on('data', chunk => { stderr += String(chunk) })
  const timer = setTimeout(() => processChild.kill('SIGKILL'), timeoutMs)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      processChild.once('exit', resolve)
      processChild.once('error', reject)
    })
    return { code, stdout, stderr, pid: processChild.pid! }
  } finally { clearTimeout(timer) }
}
function runtime(root: string): { pid: number; bootId: string; port: number; token: string } | undefined {
  try { return JSON.parse(readFileSync(join(root, 'ai-access', 'ai-router.runtime.json'), 'utf8')) } catch { return undefined }
}
async function fixture(upstream: number, routerPort = 0, initial?: AiAccessState): Promise<{ root: string; routerPort: number; routerPid: number }> {
  const root = await mkdtemp(join(tmpdir(), 'laixin-api15r-b-'))
  roots.push(root)
  const selectedPort = routerPort || await port()
  writeFileSync(join(root, 'fixture-state.json'), JSON.stringify(initial ?? state(selectedPort)), { mode: 0o600 })
  const gui = await child(root, upstream, ['--fixture-setup'])
  expect(gui.code, gui.stderr).toBe(0)
  const lifecycle = JSON.parse(readFileSync(join(root, 'fixture-setup.json'), 'utf8')) as { guiPid: number; windowCount: number; trayPresent: boolean }
  expect(lifecycle).toMatchObject({ guiPid: gui.pid, windowCount: 1, trayPresent: true })
  expect(alive(gui.pid)).toBe(false)
  const active = await until(() => runtime(root))
  expect(active.port).toBe(selectedPort)
  routers.push(active.pid)
  expect(alive(active.pid)).toBe(true)
  return { root, routerPort: selectedPort, routerPid: active.pid }
}
async function request(root: string, token: string, body: object = { model, input: 'fresh request' }): Promise<Response> {
  const active = runtime(root)!
  return fetch(`http://127.0.0.1:${String(active.port)}/codex/multi/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  })
}
async function upstreamServer(onCall: (call: { provider: string; key: string; body: string }) => Promise<void> | void): Promise<number> {
  const server = createServer((req, res) => { void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    await onCall({ provider: (req.url ?? '').slice(1), key: String(req.headers.authorization ?? ''), body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture answer' }] }] }))
  })().catch(() => { res.writeHead(500); res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('upstream unavailable')
  return address.port
}

run('API-15R-B real Electron children', () => {
  it('GUI 窗口和托盘退出后，headless PID 继续接新请求；重开不换监听者；Key 更新保留在飞快照', async () => {
    const calls: { provider: string; key: string; body: string }[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const upstream = await upstreamServer(async call => { calls.push(call); if (call.body.includes('hold-request')) await held })
    const f = await fixture(upstream)
    const firstToken = runtime(f.root)!.token
    // The GUI shutdown hook invokes service.stop(); a regression that also stops the shared
    // router makes the very next real child-process request fail.
    const guiService = new AiAccessService({ read: async () => state(f.routerPort), write: async () => undefined },
      aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })), undefined, {},
      { stop: async () => { process.kill(f.routerPid, 'SIGTERM'); return true } } as unknown as AiRouterController)
    await guiService.stop()
    expect((await request(f.root, firstToken)).status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ provider: 'deepseek', key: `Bearer ${keyA}` })
    const second = await child(f.root, upstream, ['--laixin-ai-router'])
    expect(second.code).toBe(0)
    expect(runtime(f.root)!.pid).toBe(f.routerPid)
    const reopened = await child(f.root, upstream, ['--fixture-reopen'])
    expect(reopened.code, reopened.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(f.root, 'fixture-reopen.json'), 'utf8'))).toMatchObject({ ok: true, pid: f.routerPid, windowCount: 1, trayPresent: true })
    expect(runtime(f.root)!.pid).toBe(f.routerPid)
    const inFlight = request(f.root, firstToken, { model, input: 'hold-request' })
    await until(() => calls.length === 2 ? true : undefined)
    writeFileSync(join(f.root, 'fixture-state.json'), JSON.stringify(state(f.routerPort, keyB)), { mode: 0o600 })
    const updated = await child(f.root, upstream, ['--fixture-update'])
    expect(updated.code, updated.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(f.root, 'fixture-update.json'), 'utf8'))).toMatchObject({ ok: true, pid: f.routerPid })
    release()
    expect((await inFlight).status).toBe(200)
    expect((await request(f.root, firstToken)).status).toBe(200)
    expect(calls.map(call => call.key)).toEqual([`Bearer ${keyA}`, `Bearer ${keyA}`, `Bearer ${keyB}`])
    const control = readFileSync(join(f.root, 'fixture-update.json'), 'utf8')
    expect(control).not.toContain(keyA)
    expect(control).not.toContain(keyB)
    expect(control).not.toContain('hold-request')
  }, 30_000)

  it('崩溃后常驻控制夹具拉回新 PID 和新 token；认证命令在停机时按需唤醒', async () => {
    const calls: string[] = []
    const upstream = await upstreamServer(call => { calls.push(call.key) })
    const f = await fixture(upstream)
    const old = runtime(f.root)!
    process.kill(old.pid, 'SIGKILL')
    await until(() => !alive(old.pid) ? true : undefined)
    // Supervisor fixture: relaunch exactly the same packaged-entry mode after a crash.
    const supervisor: ChildProcess = spawn(electron, [bootstrap, '--laixin-ai-router'], { env: env(f.root, upstream), stdio: 'ignore', detached: true })
    supervisor.unref()
    const recovered = await until(() => { const value = runtime(f.root); return value?.pid !== old.pid ? value : undefined })
    routers.push(recovered.pid)
    expect(recovered.token).not.toBe(old.token)
    expect((await request(f.root, old.token)).status).toBe(401)
    expect((await request(f.root, recovered.token)).status).toBe(200)
    process.kill(recovered.pid, 'SIGKILL')
    await until(() => !alive(recovered.pid) ? true : undefined)
    const auth = await child(f.root, upstream, ['--laixin-codex-provider-key', 'multi'], 12_000)
    expect(auth.code, auth.stderr).toBe(0)
    expect(auth.stdout).toMatch(/^[a-f0-9]{64}$/)
    expect(auth.stdout).not.toBe(old.token)
    const woken = runtime(f.root)!
    routers.push(woken.pid)
    expect(woken.pid).not.toBe(recovered.pid)
    expect((await request(f.root, auth.stdout)).status).toBe(200)
    expect(calls).toEqual([`Bearer ${keyA}`, `Bearer ${keyA}`])
  }, 35_000)

  it('刷新后移除模型，新请求关闭失败，保留模型仍精确命中原 Key', async () => {
    const seen: string[] = []
    const upstream = await upstreamServer(call => { seen.push(`${call.provider}:${call.key}`) })
    const selectedPort = await port()
    const original: AiAccessState = { ...state(selectedPort),
      shellKeys: { codex: { deepseek: keyA, 'zhipu-api': 'sk-fixture-zhipu-key-0123456789' } },
      codexMultiModelPool: [state(selectedPort).codexMultiModelPool![0],
        { provider: 'zhipu-api', model: 'glm-5.3-flash', internalModelId: 'laixin.zhipu-api.glm-5.3-flash' }] }
    const f = await fixture(upstream, selectedPort, original)
    const token = runtime(f.root)!.token
    expect((await request(f.root, token, { model, input: 'before removal' })).status).toBe(200)
    const retained = { model: 'laixin.zhipu-api.glm-5.3-flash', input: 'after removal' }
    writeFileSync(join(f.root, 'fixture-state.json'), JSON.stringify({ ...original, codexMultiModelPool: original.codexMultiModelPool!.slice(1) }), { mode: 0o600 })
    const updated = await child(f.root, upstream, ['--fixture-update'])
    expect(updated.code, updated.stderr).toBe(0)
    expect((await request(f.root, token, { model, input: 'removed' })).status).toBe(409)
    expect((await request(f.root, token, retained)).status).toBe(200)
    expect(seen).toEqual([`deepseek:Bearer ${keyA}`, 'zhipu-api:Bearer sk-fixture-zhipu-key-0123456789'])
  }, 20_000)

  it('无关进程占端口时认证关闭失败，不输出 token 或调用上游', async () => {
    let calls = 0, stolenToken = false
    const upstream = await upstreamServer(() => { calls += 1 })
    const f = await fixture(upstream)
    process.kill(f.routerPid, 'SIGKILL')
    await until(() => !alive(f.routerPid) ? true : undefined)
    const occupant = createServer((req, res) => {
      if (req.headers.authorization || req.headers['x-api-key']) stolenToken = true
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bootId: '0'.repeat(32), proof: '0'.repeat(64), pid: 999 }))
    })
    await new Promise<void>(resolve => occupant.listen(f.routerPort, '127.0.0.1', resolve))
    servers.push(occupant)
    const blockedRouter = await child(f.root, upstream, ['--laixin-ai-router'])
    expect(blockedRouter.code).toBe(1)
    expect(blockedRouter.stdout).toBe('')
    const auth = await child(f.root, upstream, ['--laixin-codex-provider-key', 'multi'], 12_000)
    expect(auth.code).toBe(1)
    expect(auth.stdout).toBe('')
    expect(stolenToken).toBe(false)
    expect(calls).toBe(0)
  }, 20_000)
})
