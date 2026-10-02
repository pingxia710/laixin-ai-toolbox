import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { xrayExecutable } from '../../sidecar/mac/local-bridge.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, forceTunnelPathForTest, makeTempDir, readFakeStore, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, waitFor } from './helpers'

it('双组回显都超时但通道可达，新增专用复验不能把原本够用的修复预算翻倍', async () => {
  const root = realpathSync(makeTempDir('repair-probe-budget-'))
  const target = await startFakeHttpMarker('reachable-without-ip')
  const sockets = new Set<Socket>()
  const silent = createServer((socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const silentPort = (silent.address() as { port: number }).port
  const upstream = await startFakeSocks5Server({
    'echo.invalid:80': ['127.0.0.1', silentPort], 'backup.invalid:443': ['127.0.0.1', silentPort],
    'probe.invalid:80': ['127.0.0.1', target.port]
  })
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const localSidecar = join(root, 'sidecar')
  cpSync(sidecarDir, localSidecar, { recursive: true })
  const entry = join(localSidecar, 'tunnel-daemon.mjs')
  const factory = 'bridgeFactory: (options) => createLocalBridge(options),'
  const source = readFileSync(entry, 'utf8')
  expect(source).toContain(factory)
  // 真守护和 Xray；仅注入两条回环上游、静默回显服务与可用探测点，按比例缩短超时。
  writeFileSync(entry, source.replace(factory, `bridgeFactory: (options) => createLocalBridge({ ...options,
    outbounds: [0, 1].map(() => ({ protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port: ${upstream.port} }] } })),
    verifyUrl: 'http://echo.invalid/ip', verifyFallbackUrl: 'https://backup.invalid/ip', probeUrls: ['http://probe.invalid/'],
    executablePath: ${JSON.stringify(xrayExecutable())}, verifyTimeoutMs: 600 }),`))
  const dataDir = join(root, 'device'), storePath = join(root, 'fake-system.json')
  const adapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const children: ChildProcess[] = []
  let daemonErrors = ''
  const launch = (command: string, runId = '') => {
    const child = spawn(process.execPath, [entry, command, '--data-dir', dataDir, '--adapter', adapter,
      '--run-id', runId, '--intent-poll-ms', '30', '--verify-interval-ms', '60000'],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', (chunk: Buffer) => { daemonErrors += chunk.toString() })
    children.push(child)
    return child
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (dir, runId) => { forceTunnelPathForTest(dir); return launch('start', runId) },
    spawnRestore: () => launch('restore'), routesFile: join(sidecarDir, 'routes.default.json'),
    repairTimeoutMs: 3_600, repairRestoreGraceMs: 800,
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '' } })
  try {
    await service.importConfig(); await service.applyPending()
    const started = Date.now()
    service.repair()
    await waitFor(() => !service.repairStatus().running, 12_000)
    const evidence = { elapsedMs: Date.now() - started, repair: service.repairStatus(), status: service.status(),
      hits: upstream.hits().map(({ host }) => host), requests: target.requestCount(), daemonErrors }
    expect(service.repairStatus(), JSON.stringify(evidence)).toMatchObject({ outcome: 'recovered', phase: 'finished' })
    expect(service.status()).toMatchObject({ state: '已连', exitIp: '', pathVerified: true })
    expect(readFakeStore(storePath)['Wi-Fi/socks-proxy']).toMatchObject({ enabled: true })
    expect(upstream.hits().filter(({ host }) => host === 'echo.invalid').length).toBeGreaterThanOrEqual(4)
    expect(upstream.hits().filter(({ host }) => host === 'backup.invalid').length).toBeGreaterThanOrEqual(4)
  } finally {
    await service.stop()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGTERM')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000)
    }
    await upstream.close(); await target.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
    removeTempDir(root)
  }
}, 20_000)
