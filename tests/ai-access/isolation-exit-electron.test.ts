import { afterEach, describe, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:https'
import type { ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { createAdapter } from '../tunnel/fixtures/fake-adapter.mjs'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir, waitFor, writeIntentFile } from '../tunnel/helpers'
import { chooseAiRouterPort } from '../../app/main/ai-access/router-controller'
import { probeApiNetwork } from '../../sidecar/shared/api-network-continuation.mjs'
import type { AiAccessState } from '../../app/main/ai-access/service'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const run = process.platform === 'darwin' ? describe : describe.skip
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

run('真实 Electron 隔离接入退出延续', () => {
  it('三壳经实际 CONNECT 通道，GUI 真退出后继续在途和新请求，重开不改原绑定', async () => {
    const root = makeTempDir('api-exit-native-'), networkDir = join(root, 'network')
    mkdirSync(networkDir); mkdirSync(join(root, 'ai-access'))
    cleanup.push(() => removeTempDir(root))
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), 'utf8')) as T
    const bundle = join(root, 'fixture.cjs')
    const { buildSync } = require('esbuild') as { buildSync(options: Record<string, unknown>): void }
    buildSync({ entryPoints: [resolve('tests/ai-access/fixtures/api-exit-gui.ts')], outfile: bundle,
      platform: 'node', format: 'cjs', bundle: true, external: ['electron'], define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) } })
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
      '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
    let held: ServerResponse | undefined, upstreamCalls = 0
    const upstream: Server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, (req, res) => {
      void (async () => {
        let body = ''
        for await (const chunk of req) body += String(chunk)
        upstreamCalls++
        if (body.includes('hold-answer')) {
          held = res; res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"before GUI exit"},"finish_reason":null}]}\n\n')
        } else res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }))
      })().catch(() => res.destroy())
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const upstreamPort = (upstream.address() as { port: number }).port
    const port = await chooseAiRouterPort(), bridgePort = await chooseAiRouterPort(), token = 'a'.repeat(64)
    const business: AiAccessState = { version: 1, selected: { codex: 'deepseek', claude: 'deepseek', hermes: 'deepseek' },
      relay: { port, token }, codexMultiRelay: { port, identitySecret: 'b'.repeat(64) }, relayShells: ['codex', 'claude', 'hermes'],
      shellKeys: Object.fromEntries(['codex', 'claude', 'hermes'].map(shell => [shell, { deepseek: `sk-fixture-${shell}-0123456789` }])) }
    writeFileSync(join(root, 'business.json'), JSON.stringify(business), { mode: 0o600 })
    let exited = false, guiPid: number | undefined, bridge: ReturnType<typeof createLocalBridge> | undefined, starts = 0
    const daemon = createDaemon({ dataDir: networkDir, adapter: createAdapter(fakeAdapterEnv(join(root, 'system.json'))),
      clock: { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number, clearTimer: id => clearTimeout(id as unknown as NodeJS.Timeout) },
      parentAlive: () => guiPid === undefined || alive(guiPid), onExit: () => { exited = true }, intentPollMs: 50, parentPollMs: 100,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { starts++ }, stop: async () => undefined,
        localProxyPort: () => 0, xrayOutbound: () => ({ protocol: 'freedom' }), onLost: () => undefined,
        verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: options => { bridge = createLocalBridge(options); return bridge } })
    cleanup.push(async () => { daemon.requestShutdown(); await waitFor(() => exited, 8_000); await bridge?.close() })
    writeIntentFile(networkDir, { desired: 'connected', sessionToken: 'native-api-session', bridgePort, updatedAt: Date.now(),
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
    await daemon.run()
    expect(read<{ state: string }>('network/state.json').state, JSON.stringify(read('network/state.json'))).toBe('connected')
    const env: NodeJS.ProcessEnv = { ...process.env, TOOLBOX_EXIT_ROOT: root, TOOLBOX_EXIT_UPSTREAM: String(upstreamPort), TOOLBOX_EXIT_BUNDLE: bundle }
    delete env.ELECTRON_RUN_AS_NODE
    const launch = (reopen = false) => {
      const child: ChildProcess = spawn(electron, [bundle, ...(reopen ? ['--reopen'] : [])], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      guiPid = child.pid
      let errors = ''
      child.stderr!.on('data', chunk => { errors += String(chunk) })
      cleanup.push(() => { child.kill('SIGKILL') })
      const exit = new Promise<number | null>(resolve => child.once('exit', resolve))
      return { child, exit, errors: () => errors }
    }
    const ready = async () => {
      await waitFor(() => existsSync(join(root, 'gui-ready.json')) || existsSync(join(root, 'fixture-error.json')), 15_000)
      if (existsSync(join(root, 'fixture-error.json'))) throw new Error(JSON.stringify(read('fixture-error.json')))
      expect(read('gui-ready.json')).toMatchObject({ pid: guiPid, available: [true, true, true] })
    }
    cleanup.push(() => {
      try { process.kill(read<{ pid: number }>('ai-access/ai-router.runtime.json').pid, 'SIGKILL') } catch { /* fixture already stopped */ }
    })
    const gui = launch(); await ready()
    const runtime = read<{ pid: number; bootId: string; port: number }>('ai-access/ai-router.runtime.json')
    cleanup.push(() => { try { process.kill(runtime.pid, 'SIGKILL') } catch { /* fixture already stopped */ } })
    const binding = { ...runtime, identitySecret: business.codexMultiRelay!.identitySecret, bridgePort }
    expect(await probeApiNetwork(binding)).toEqual({ targets: [`127.0.0.1:${upstreamPort}`] })
    expect(await probeApiNetwork({ ...binding, identitySecret: 'c'.repeat(64) })).toBeUndefined()
    expect(await probeApiNetwork({ ...binding, pid: runtime.pid + 1 })).toBeUndefined()
    expect(await probeApiNetwork({ ...binding, bridgePort: bridgePort + 1 })).toBeUndefined()
    const configBefore = ['codex', 'claude', 'hermes'].map(shell => readFileSync(join(root, `${shell}-config.json`), 'utf8'))
    const request = (shell: string, input = 'new request') => fetch(`http://127.0.0.1:${port}/${shell}/deepseek/v1/${shell === 'codex' ? 'responses' : shell === 'claude' ? 'messages' : 'chat/completions'}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'deepseek-flash', input, messages: [{ role: 'user', content: input }], stream: input === 'hold-answer' }), signal: AbortSignal.timeout(15_000)
    })
    const stream = await request('codex', 'hold-answer'), answer = stream.text()
    await waitFor(() => held !== undefined)
    writeFileSync(join(root, 'quit-gui'), '')
    expect(await gui.exit, gui.errors()).toBe(0)
    expect(read('shutdown-result.json')).toEqual({ order: ['tunnel', 'gateway', 'hermes', 'claude', 'codex'], diagnostics: [] })
    expect(alive(gui.child.pid!)).toBe(false); expect(alive(runtime.pid)).toBe(true)
    await waitFor(() => read<{ apiOnly: boolean }>('network/state.json').apiOnly)
    expect(readFakeStore(join(root, 'system.json'))).toEqual({})
    held!.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    expect(await answer).toContain('before GUI exit')
    for (const shell of ['codex', 'claude', 'hermes']) {
      const response = await request(shell)
      expect(response.status).toBe(200); expect(await response.text()).toContain('OK')
    }
    const denied = await new Promise<string>(resolve => {
      const socket = connect(bridgePort, '127.0.0.1', () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`))
      let data = ''; socket.on('data', chunk => { data += String(chunk) }); socket.on('error', () => undefined)
      socket.on('close', () => resolve(data)); socket.setTimeout(2_000, () => socket.destroy())
    })
    expect(denied).not.toContain('200')
    expect(starts).toBe(1); expect(bridge!.traffic().downloadBytes).toBeGreaterThan(100)
    unlinkSync(join(root, 'quit-gui')); unlinkSync(join(root, 'gui-ready.json'))
    const reopened = launch(true); await ready()
    expect(read<{ pid: number }>('ai-access/ai-router.runtime.json').pid).toBe(runtime.pid)
    expect(['codex', 'claude', 'hermes'].map(shell => readFileSync(join(root, `${shell}-config.json`), 'utf8'))).toEqual(configBefore)
    for (const shell of ['codex', 'claude', 'hermes']) expect((await request(shell)).status).toBe(200)
    writeFileSync(join(root, 'change-hermes-key'), '')
    await waitFor(() => existsSync(join(root, 'hermes-key-changed.json')), 3_000)
    expect(read<{ restores: number }>('hermes-config.json').restores).toBe(1)
    writeFileSync(join(root, 'quit-gui'), ''); expect(await reopened.exit, reopened.errors()).toBe(0)
    expect(read('shutdown-result.json')).toEqual({ order: ['tunnel', 'gateway', 'hermes', 'claude', 'codex'], diagnostics: [] })
    process.kill(runtime.pid, 'SIGTERM')
    await waitFor(() => exited, 6_000)
    expect(readFakeStore(join(root, 'system.json'))).toEqual({})
    const evidence = process.env.TOOLBOX_EXIT_EVIDENCE
    if (evidence) writeFileSync(evidence, JSON.stringify({ guiExited: true, routerPid: runtime.pid, routerReused: true,
      unchangedConfigs: true, shells: 3, realConnect: true, fakeSystemAdapter: true, upstreamCalls, connectorStarts: starts,
      nonApiTargetDenied: true, resumedLeaseReleasedOnKeyChange: true, productionShutdownOrder: true,
      routerExitStoppedNetwork: exited, traffic: bridge!.traffic() }, null, 2))
  }, 45_000)
})
