import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chooseAiRouterPort } from '../../app/main/ai-access/router-controller'
import type { AiAccessState } from '../../app/main/ai-access/service'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const run = process.platform === 'darwin' && existsSync(resolve('out/main/index.js')) ? describe : describe.skip
const roots: string[] = [], pids: number[] = [], servers: Server[] = []
const children: ChildProcess[] = []
const token = 'a'.repeat(64)
const keys = { codex: 'sk-fixture-codex-0123456789', claude: 'sk-fixture-claude-0123456789', hermes: 'sk-fixture-hermes-0123456789' }
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots) { const runtime = read<{ pid: number }>(join(root, 'ai-access', 'ai-router.runtime.json')); if (runtime) pids.push(runtime.pid) }
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
async function until<T>(read: () => T | undefined): Promise<T> {
  const until = Date.now() + 12_000
  do { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < until)
  throw new Error('native fixture timeout')
}
function read<T>(path: string): T | undefined { try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return undefined } }

run('API-13 real GUI service and independent Electron runtime', () => {
  it.each([false, true])('退出前在飞流继续，真退出后新请求可用，重开复用同 PID 和三壳配置（旧双端口 %s）', async separate => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-api13-'))
    roots.push(root)
    const guiBundle = join(root, 'gui.cjs')
    const { buildSync } = require('esbuild') as { buildSync(options: Record<string, unknown>): void }
    buildSync({ entryPoints: [resolve('tests/ai-access/fixtures/api13-gui.ts')], outfile: guiBundle,
      platform: 'node', format: 'cjs', bundle: true, external: ['electron'] })
    const calls: { path: string; key: string }[] = []
    let heldResponse: ServerResponse | undefined
    const upstream = createServer((req, res) => { void (async () => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      calls.push({ path: req.url!, key: String(req.headers.authorization ?? req.headers['x-api-key']) })
      if (body.includes('hold-answer')) {
        heldResponse = res
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"response.output_text.delta","delta":"before GUI exit"}\n\n')
      } else res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }))
    })().catch(() => { res.writeHead(500); res.end() }) })
    servers.push(upstream)
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    const port = await chooseAiRouterPort()
    const state: AiAccessState = { version: 1, selected: { codex: 'deepseek', claude: 'deepseek', hermes: 'deepseek' },
      relay: { port, token }, relayShells: ['codex', 'claude', 'hermes'],
      ...(separate ? { codexMultiRelay: { port: await chooseAiRouterPort(), identitySecret: 'b'.repeat(64) } } : {}),
      shellKeys: Object.fromEntries(Object.entries(keys).map(([shell, key]) => [shell, { deepseek: key }])) }
    writeFileSync(join(root, 'initial.json'), JSON.stringify(state), { mode: 0o600 })
    const bootstrap = resolve('tests/ai-access/fixtures/api13-electron-bootstrap.cjs')
    const env: NodeJS.ProcessEnv = { ...process.env, TOOLBOX_API13_ROOT: root, TOOLBOX_API13_GUI: guiBundle, TOOLBOX_API13_UPSTREAM: String(upstreamPort) }
    delete env.ELECTRON_RUN_AS_NODE
    const launch = (reopen = false) => {
      const child = spawn(electron, [bootstrap, ...(reopen ? ['--fixture-reopen'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let errors = ''
      child.stderr?.on('data', chunk => { errors += String(chunk) })
      const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      return { child, exit, errors: () => errors }
    }
    const gui = launch()
    type Report = { guiPid: number; running: boolean; routeCount: number; singlePort: number; windowCount: number; trayPresent: boolean }
    const ready = await until(() => read<Report>(join(root, 'gui-ready.json')))
    expect(ready, gui.errors()).toMatchObject({ guiPid: gui.child.pid, running: true, routeCount: 3, singlePort: port, windowCount: 1, trayPresent: true })
    const runtimePath = join(root, 'ai-access', 'ai-router.runtime.json')
    const runtime = await until(() => read<{ pid: number; port: number }>(runtimePath))
    pids.push(runtime.pid)
    expect(runtime.pid).not.toBe(gui.child.pid)
    const request = (shell: keyof typeof keys, input = 'new request') => fetch(`http://127.0.0.1:${port}/${shell}/deepseek/v1/${shell === 'codex' ? 'responses' : shell === 'claude' ? 'messages' : 'chat/completions'}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'deepseek-flash', input, messages: [{ role: 'user', content: input }], stream: input === 'hold-answer' })
    })
    const inFlight = await request('codex', 'hold-answer')
    const answer = inFlight.text()
    await until(() => heldResponse)
    writeFileSync(join(root, 'quit-gui'), '')
    expect(await gui.exit, gui.errors()).toBe(0)
    expect(alive(gui.child.pid!)).toBe(false)
    expect(alive(runtime.pid)).toBe(true)
    heldResponse!.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
    expect(await answer).toContain('before GUI exit')
    for (const shell of ['codex', 'claude', 'hermes'] as const) expect((await request(shell)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${runtime.port}/_laixin/router/snapshot`, { method: 'POST', headers: { 'x-laixin-nonce': 'c'.repeat(32) } })).status).toBe(403)
    await unlink(join(root, 'quit-gui'))
    await unlink(join(root, 'gui-ready.json'))
    const reopened = launch(true)
    await until(() => read<Report>(join(root, 'gui-ready.json')))
    expect(read<{ pid: number }>(runtimePath)!.pid).toBe(runtime.pid)
    expect((await request('hermes')).status).toBe(200)
    writeFileSync(join(root, 'quit-gui'), '')
    expect(await reopened.exit, reopened.errors()).toBe(0)
    expect(calls.map(call => call.key)).toEqual([`Bearer ${keys.codex}`, `Bearer ${keys.codex}`, `Bearer ${keys.claude}`, `Bearer ${keys.hermes}`, `Bearer ${keys.hermes}`])
    if (process.env.TOOLBOX_API13_EVIDENCE) writeFileSync(join(process.env.TOOLBOX_API13_EVIDENCE, `native-${separate ? 'separate' : 'shared'}.json`), JSON.stringify({
      platform: process.platform, guiPid: gui.child.pid, guiExited: !alive(gui.child.pid!), routerPid: runtime.pid,
      routerAliveAfterGuiExit: alive(runtime.pid), reopenedGuiPid: reopened.child.pid, reopenedGuiExited: !alive(reopened.child.pid!),
      reusedRouterPid: read<{ pid: number }>(runtimePath)!.pid, singlePort: port, controlPort: runtime.port,
      inFlightCompleted: true, freshRequestsAfterExit: ['codex', 'claude', 'hermes'], requestCount: calls.length,
      credentials: 'fixture-only; omitted', clientEvidence: 'HTTP requests in three client protocol formats; native client apps not launched'
    }, null, 2))
  }, 40_000)
})
