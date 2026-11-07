import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { TunnelService, type TunnelServiceDeps } from '../../../app/main/tunnel/tunnel-service'
import { BackgroundNetworkController } from '../../../app/main/tunnel/background-controller'
import { acquireGuiNetworkController } from '../../../app/main/tunnel/controller-seat'
import { NetworkAccountClient } from '../../../app/main/tunnel/account-client'
import { probeApiNetwork, apiNetworkProof, type ApiNetworkBinding } from '../../../sidecar/shared/api-network-continuation.mjs'
import { readInstanceLock } from '../../../sidecar/shared/instance-lock.mjs'
import { lockHolderAlive } from '../../../sidecar/shared/ledger.mjs'
import { loadTrustContext, type IssuerRegistry } from '../../../app/main/tunnel/trust'

interface Config {
  dataDir: string; sidecarDir: string; adapter: string; storePath: string; backend: string
  accountId: string; accountToken: string; issuerRegistry: IssuerRegistry; targets: string[]
}
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Config
const mode = process.argv[3]
const access = { client: new NetworkAccountClient(`${config.backend}/v1/network/`),
  session: { accountId: config.accountId, accessToken: config.accountToken } }
const launch = (dir: string, mode: string, runId?: string) => {
  const child = spawn(process.execPath, [join(config.sidecarDir, 'tunnel-daemon.mjs'), mode, '--data-dir', dir,
    '--adapter', config.adapter, ...(mode === 'start' ? ['--resident', '1', '--intent-poll-ms', '50'] : []), ...(runId ? ['--run-id', runId] : [])],
  { env: { ...process.env, FAKE_ADAPTER_STORE: config.storePath }, stdio: 'ignore', detached: true })
  child.unref()
  return child
}
const deps = (): TunnelServiceDeps => ({ dataDir: config.dataDir, sidecarDir: config.sidecarDir, trust: loadTrustContext({}, { registry: config.issuerRegistry }),
  now: Date.now, allowLocalVerifyUrls: true, picker: async () => { throw new Error('fixture picker forbidden') },
  routesFile: join(config.sidecarDir, 'routes.default.json'),
  spawnDaemon: (dir, runId) => launch(dir, 'start', runId), spawnRestore: dir => launch(dir, 'restore'),
  logFailure: (event, code) => appendFileSync(join(config.dataDir, 'fixture-controller.log'), `${event}:${code ?? ''}\n`),
  resident: { armed: () => false, wake: async () => false,
    alive: () => lockHolderAlive(readInstanceLock(config.dataDir)?.holder),
    seatRunId: () => readInstanceLock(config.dataDir)?.holder?.runId } })

async function main() {
  if (mode === 'gui') {
    const release = await acquireGuiNetworkController(config.dataDir)
    process.once('exit', release)
    const binding = JSON.parse(process.argv[4]!) as ApiNetworkBinding
    const service = new TunnelService({ ...deps(), apiNetworkContinuation: async port =>
      port === binding.bridgePort && await probeApiNetwork(binding) ? binding : undefined })
    await service.setAccountAccess(access)
    process.send?.({ ready: true })
    process.on('message', async command => {
      if (command === 'quit') { await service.requestShutdown(); process.exit(0) }
      if (command === 'disconnect') { await service.stop(); process.send?.({ disconnected: true }) }
    })
    return
  }
  const server = createServer((req, res) => {
    const nonce = String(req.headers['x-laixin-nonce'])
    if (req.method !== 'POST' || req.url !== '/_laixin/router/network' ||
        req.headers['x-laixin-proof'] !== apiNetworkProof(binding, 'network', nonce)) { res.writeHead(403); res.end(); return }
    res.end(JSON.stringify({ protocol: 1, pid: process.pid, bootId: binding.bootId,
      proof: apiNetworkProof(binding, 'network-ack', nonce),
      network: [{ proxyUrl: `http://127.0.0.1:${binding.bridgePort}`, targets: config.targets }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const state = JSON.parse(readFileSync(join(config.dataDir, 'state.json'), 'utf8')) as { bridgePort: number }
  const binding: ApiNetworkBinding = { port: (server.address() as { port: number }).port, pid: process.pid, bootId: randomBytes(16).toString('hex'),
    identitySecret: randomBytes(32).toString('hex'), bridgePort: state.bridgePort }
  const controller = new BackgroundNetworkController({ dataDir: config.dataDir, router: binding, serviceDeps: deps,
    loadAccount: async () => ({ access, expiresAt: Date.now() + 60_000 }),
    onFailure: () => appendFileSync(join(config.dataDir, 'fixture-controller.log'), 'background failure\n') })
  controller.start()
  process.send?.({ ready: true, binding })
  process.on('message', async command => {
    if (command === 'stop') { await controller.stop(); server.close(); process.exit(0) }
  })
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'fixture failed'); process.exit(1) })
