import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import { layout } from '../../app/main/tunnel/paths'
import { xrayExecutable } from '../../sidecar/mac/local-bridge.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, forceTunnelPathForTest, makeTempDir, readFakeStore, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, waitFor } from './helpers'

it.each(['invalid-ip', 'http-101'])('真实回显 %s、后备可达：修复完成且保留已通连接，IPC 如实传递证据', async (echoMode) => {
  // Node 的入口 URL 使用真实路径，避免 macOS /var → /private/var 别名绕过入口判断。
  const root = realpathSync(makeTempDir('repair-no-exit-ip-'))
  const target = await startFakeHttpMarker('reachable-without-ip')
  const echo = createServer((_, response) => {
    if (echoMode === 'http-101') response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'websocket' })
    response.end('reachable-without-ip')
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const echoPort = (echo.address() as { port: number }).port
  const upstream = await startFakeSocks5Server({
    'echo.invalid:80': ['127.0.0.1', echoPort], 'probe.invalid:80': ['127.0.0.1', target.port]
  })
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const localSidecar = join(root, 'sidecar')
  cpSync(sidecarDir, localSidecar, { recursive: true })
  const entry = join(localSidecar, 'tunnel-daemon.mjs')
  const source = readFileSync(entry, 'utf8')
  const factory = 'bridgeFactory: (options) => createLocalBridge(options),'
  expect(source).toContain(factory)
  // 只替换依赖注入点的探测地址和内核位置；守护、修复流程和设置逻辑使用实际源码。
  writeFileSync(entry, source.replace(factory, `bridgeFactory: (options) => createLocalBridge({ ...options,
    verifyUrl: 'http://echo.invalid/ip', probeUrls: ['http://probe.invalid/'],
    executablePath: ${JSON.stringify(xrayExecutable())}, verifyTimeoutMs: 500 }),`))
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
    repairTimeoutMs: 3_000, repairRestoreGraceMs: 800,
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '' } })
  try {
    const registry = new BridgeRegistry(); registerActions(registry, { service })
    await service.importConfig(); await service.applyPending()
    service.repair()
    await waitFor(() => !service.repairStatus().running, 10_000)
    expect(service.repairStatus(), JSON.stringify({ status: service.status(), requests: target.requestCount(), daemonErrors })).toMatchObject({ outcome: 'recovered', phase: 'finished' })
    expect(service.repairStatus().message).toContain('出口地址暂未取得')
    expect(await registry.execute('tunnel.status', undefined)).toMatchObject({ state: '已连', exitIp: '', pathVerified: true })
    expect(JSON.parse(readFileSync(layout.intent(dataDir), 'utf8')).desired).toBe('connected')
    expect(readFakeStore(storePath)['Wi-Fi/socks-proxy']).toMatchObject({ enabled: true })
    expect(upstream.hits().some((hit) => hit.host === 'echo.invalid')).toBe(true)
    expect(upstream.hits().some((hit) => hit.host === 'probe.invalid')).toBe(true)
    expect(target.requestCount()).toBeGreaterThanOrEqual(2)
  } finally {
    await service.stop()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGTERM')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000)
    }
    await upstream.close(); await target.close()
    echo.closeAllConnections()
    await new Promise<void>((resolve) => echo.close(() => resolve()))
    removeTempDir(root)
  }
}, 15_000)
