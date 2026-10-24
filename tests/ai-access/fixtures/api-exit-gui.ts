import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../../app/main/ai-access/service'
import { AiGateway } from '../../../app/main/ai-access/gateway'
import { AiRouterController } from '../../../app/main/ai-access/router-controller'
import { AiRouterGateway } from '../../../app/main/ai-access/router-gateway'
import { createHeadlessRouterControl } from '../../../app/main/ai-access/headless-router'
import { readAiRouterRuntime, writeAiRouterRuntime } from '../../../app/main/ai-access/router-runtime'
import { ApplicationIsolationHttpConnectTransport } from '../../../app/main/ai-access/application-isolation-transport'
import { ApplicationIsolationLeaseController } from '../../../app/main/ai-access/application-isolation-lease'
import { TunnelService } from '../../../app/main/tunnel/tunnel-service'
import { ShutdownRegistry } from '../../../app/main/bridge/shutdown-registry'
import { probeApiNetwork } from '../../../sidecar/shared/api-network-continuation.mjs'

// Fixture-only store, shell files, resident registration and system adapter. No owner keychain,
// installed client settings, system proxy or paid provider is accessed by this lifecycle check.
const root = process.env.TOOLBOX_EXIT_ROOT!
if (!root) throw new Error('isolated root required')
app.setPath('userData', root)
const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), 'utf8')) as T
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 })
const store = { read: async () => read<AiAccessState>('business.json'), write: async (state: AiAccessState) => write('business.json', state) }
const resolveRoute = () => ({ endpoint: `https://127.0.0.1:${process.env.TOOLBOX_EXIT_UPSTREAM}/v1`, model: 'deepseek-flash' })
const transport = () => new ApplicationIsolationHttpConnectTransport({ create: () => {
  const value = session.fromPartition(`exit-fixture-${randomBytes(8).toString('hex')}`)
  value.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -2))
  return value
} })

class FixtureController extends AiRouterController {
  override ensureReady(state: AiAccessState) { return super.ensureReady(state, false) }
}

void app.whenReady().then(async () => {
  if (process.argv.includes('--laixin-ai-router')) {
    const initial = await store.read(), bootId = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex')
    const gateway: AiRouterGateway = new AiRouterGateway({
      routerControl: createHeadlessRouterControl({ binding: initial.codexMultiRelay!, bootId, initialModelCount: 0,
        readState: store.read, gateway: () => gateway.primary, refresh: state => gateway.refresh(state),
        snapshot: () => gateway.snapshot(), network: () => gateway.networkUse(),
        isolation: (command, state) => gateway.isolation(command, state),
        onStop: () => { void gateway.stop(5_000).then(() => app.exit(0)) } }),
      fetch: async () => { throw new Error('DIRECT_EGRESS_MUST_NOT_BE_USED') }
    }, resolveRoute, transport)
    await gateway.start(initial, token)
    await writeAiRouterRuntime(join(root, 'ai-access'), { pid: process.pid, bootId, port: initial.codexMultiRelay!.port, token })
    return
  }
  const window = new BrowserWindow({ show: false })
  const controller = new FixtureController(root, { executable: process.execPath, appPath: process.env.TOOLBOX_EXIT_BUNDLE!, logDir: join(root, 'logs') }, { preferSpawn: true })
  const transports = new Map(aiAccessShells.map(shell => [shell, transport()]))
  const adapters: AiAccessAdapter[] = aiAccessShells.map(shell => {
    const file = `${shell}-config.json`
    type Config = { fingerprint: string; writes: number; restores: number }
    if (!existsSync(join(root, file))) write(file, { fingerprint: 'before', writes: 0, restores: 0 })
    const restore = async () => { const config = read<Config>(file); write(file, { ...config, fingerprint: 'before', restores: config.restores + 1 }); return 'restored' as const }
    return { shell, applyDeepSeek: async () => undefined,
      configurationTargetIdentity: async () => `${shell}-target`, isolationTargetIdentity: async () => `${shell}-target`,
      configurationTargetStatus: async () => ({ shell, scope: 'user', override: 'none', writable: true }),
      readManagedFingerprint: async () => read<Config>(file).fingerprint,
      readIsolationFingerprint: async () => read<Config>(file).fingerprint,
      captureIsolation: async () => ({ beforeFingerprint: 'before', beforeIsolationFingerprint: 'before',
        configurationTargetIdentity: `${shell}-target`, leaseId: `${shell}-lease`, restoreIfOwned: restore }),
      applyIsolationConnection: async () => { const config = read<Config>(file); write(file, { ...config, fingerprint: 'isolated', writes: config.writes + 1 });
        return { outcome: 'applied' as const, managedFingerprint: 'isolated', isolationFingerprint: 'isolated' } },
      recoverIsolationLease: restore }
  })
  const gateway = new AiGateway({ fetch: (input, init, route) => {
    if (!route) throw new Error('fixture route missing')
    return transports.get(route.shell)!.fetch(String(input), init)
  } })
  let isolation: ApplicationIsolationLeaseController[] = []
  const service = new AiAccessService(store, adapters, gateway, { independentRouting: true, resolveRoute,
    beforeHermesRouteMutation: async () => { if (isolation[2]) await isolation[2].disable() } }, controller)
  await service.initialize()
  const network = read<{ bridgePort: number; runId: string }>('network/state.json')
  const isolationAdapters = { codex: service.createCodexIsolationAdapter(transports.get('codex')!),
    claude: service.createClaudeIsolationAdapter(transports.get('claude')!), hermes: service.createHermesIsolationAdapter(transports.get('hermes')!) }
  isolation = aiAccessShells.map(shell => new ApplicationIsolationLeaseController({ applicationId: shell,
    adapter: isolationAdapters[shell], system: { snapshot: async () => 'fixture-system' },
    entry: async () => ({ capability: 'http-connect', id: 'fixture-owned-bridge', proxyUrl: `http://127.0.0.1:${network.bridgePort}` }) }))
  for (const item of isolation) {
    const result = process.argv.includes('--reopen') ? await item.recover({ preserveIndependent: true }) : await item.enable()
    if (!result.available) throw new Error(`fixture isolation failed: ${JSON.stringify(result)}`)
  }
  const tunnel = new TunnelService({ dataDir: join(root, 'network'), sidecarDir: '', routesFile: '', now: Date.now,
    trust: { whitelistDigests: [], signingPublicKeys: [] }, picker: async () => undefined,
    spawnDaemon: () => { throw new Error('fixture must retain existing daemon') }, spawnRestore: () => { throw new Error('fixture must not restore from GUI') },
    resident: { armed: () => true, alive: () => true, wake: async () => true, seatRunId: () => network.runId },
    apiNetworkContinuation: async bridgePort => {
      const runtime = await readAiRouterRuntime(join(root, 'ai-access'))
      const state = await store.read()
      if (!runtime) return undefined
      const binding = { ...runtime, bridgePort, identitySecret: state.codexMultiRelay!.identitySecret }
      return await probeApiNetwork(binding) ? binding : undefined
    } })
  write('gui-ready.json', { pid: process.pid, available: isolation.map(item => item.status().available) })
  let exiting = false
  let changing = false
  const timer = setInterval(() => {
    if (!changing && existsSync(join(root, 'change-hermes-key'))) {
      changing = true
      void service.saveProviderKey('hermes', 'deepseek', 'sk-fixture-changed-0123456789')
        .then(() => write('hermes-key-changed.json', { status: isolation[2].status() }))
        .catch(error => write('fixture-error.json', { message: String(error) }))
    }
    if (exiting || !existsSync(join(root, 'quit-gui'))) return
    exiting = true; clearInterval(timer)
    void (async () => {
      // Match production registration: AI hooks register before tunnel; shutdown runs in reverse.
      const shutdown = new ShutdownRegistry(), order: string[] = [], diagnostics: string[] = []
      for (const [index, item] of isolation.entries()) shutdown.registerShutdownHook(`aiaccess.${aiAccessShells[index]}-isolation`, async () => {
        await item.recover({ preserveIndependent: true }); order.push(aiAccessShells[index])
      })
      shutdown.registerShutdownHook('aiaccess.gateway', async () => { await service.stop(); order.push('gateway') })
      shutdown.registerShutdownHook('tunnel', async () => { await tunnel.requestShutdown(); order.push('tunnel') })
      const result = await shutdown.run({ timeoutMs: 5_000, diagnostic: (code, module) => diagnostics.push(`${module}:${code}`) })
      write('shutdown-result.json', { ...result, order, diagnostics })
      if (result.timedOutHook || diagnostics.length) throw new Error('fixture shutdown did not complete')
      window.destroy(); app.exit(0)
    })().catch(error => { write('fixture-error.json', { message: String(error) }); app.exit(1) })
  }, 25)
}).catch(error => { mkdirSync(root, { recursive: true }); write('fixture-error.json', { message: String(error), stack: error.stack }); app.exit(1) })
