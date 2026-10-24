// 通道已应用设置但写后复验迟迟不返回 → 修复超时。超时那一刻守护正在恢复原设置：结论必须等守护确认，
// ⛔ 拿恢复中的账本说「原设置仍未恢复：其他软件改动或权限限制」（独立验收打回项，慢适配器下稳定复现）。
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { layout } from '../../app/main/tunnel/paths'
import { xrayExecutable } from '../../sidecar/mac/local-bridge.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, forceTunnelPathForTest, makeTempDir, readFakeStore, removeTempDir, startFakeUpstream, waitFor, reapDaemons } from './helpers'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(timeoutMs: number, pollFlag: string[], adapterFile = './fixtures/fake-adapter.mjs') {
  const root = realpathSync(makeTempDir('laixin-repair-timeout-'))
  cleanups.push(() => removeTempDir(root))
  const upstream = await startFakeUpstream()
  cleanups.push(() => upstream.killAll())
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const localSidecar = join(root, 'sidecar')
  cpSync(sidecarDir, localSidecar, { recursive: true })
  const entry = join(localSidecar, 'tunnel-daemon.mjs')
  const source = readFileSync(entry, 'utf8')
  const factory = 'bridgeFactory: (options) => createLocalBridge(options),'
  expect(source).toContain(factory)
  // 首次复验通过后真实写假系统设置；第二次复验挂起到修复预算外。
  // 不能再用空出口 IP 模拟失败：N-67 已证实后备探测可达时空 IP 是正常成功。
  writeFileSync(entry, source.replace(factory, `bridgeFactory: (options) => {
    const bridge = createLocalBridge({ ...options, executablePath: ${JSON.stringify(xrayExecutable())} })
    let checks = 0
    return { ...bridge, verify: async () => {
      if (++checks > 1) await new Promise((resolve) => setTimeout(resolve, 4000))
      return { exitIp: '203.0.113.7' }
    } }
  },`))
  const adapter = fileURLToPath(new URL(adapterFile, import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const children: ChildProcess[] = []
  const launch = (command: string, runId = '') => {
    const child = spawn(process.execPath, [entry, command, '--data-dir', dataDir,
      '--adapter', adapter, '--run-id', runId, ...pollFlag, '--verify-interval-ms', '60000'],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: 'ignore' })
    children.push(child); return child
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (dir, runId) => { forceTunnelPathForTest(dir); return launch('start', runId) }, spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'), repairTimeoutMs: timeoutMs,
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.7' } })
  cleanups.push(async () => {
    await service.stop()
    // ⛔ 自己写回收:这里原来是「SIGTERM → 等 3 秒」,超时会抛异常把整个 cleanup 打断,
    // **排在后面的守护一个都收不掉**。今天真跑飞过一个,占着中继候选端口害得另一轮全量红成「恢复错了」。
    expect(await reapDaemons(children)).toEqual([])
  })
  await service.importConfig(); await service.applyPending()
  return { service, dataDir, storePath }
}

for (const [label, pollFlag, adapterFile] of [['守护意图轮询 30ms', ['--intent-poll-ms', '30'], undefined], ['守护意图轮询默认 500ms', [], undefined],
  ['系统设置写入每项 250ms（贴近真实 networksetup）', ['--intent-poll-ms', '30'], './fixtures/slow-adapter.mjs']] as const) {
  it(`超时结论 vs 真实恢复（${label}）`, async () => {
    const f = await setup(2000, [...pollFlag], adapterFile)
    f.service.repair()
    await waitFor(() => {
      const proxy = readFakeStore(f.storePath)['Wi-Fi/socks-proxy'] as { enabled?: boolean } | undefined
      return proxy?.enabled === true
    }, 8000)
    // 入口端口按候选表走(18080 被占就换 18180…),所以 ⛔ 把 18080 写死在断言里——
    // 那会让这条用例耦合一个全局资源:另一棵树在跑测试、或者客户机上真跑着别的代理占了 18080,它就红。
    // 接管阶段已回报本次监听端口，写后复验尚未完成也可以核对。
    const appliedStore = readFakeStore(f.storePath)['Wi-Fi/socks-proxy']
    const bridgePort = JSON.parse(readFileSync(layout.state(f.dataDir), 'utf8')).bridgePort as number
    await waitFor(() => !f.service.repairStatus().running, 15_000)
    const verdict = f.service.repairStatus()
    await new Promise((resolve) => setTimeout(resolve, 3500))
    const statusLater = f.service.status()
    expect(bridgePort).toBeGreaterThan(0)
    expect(appliedStore).toMatchObject({ enabled: true, host: '127.0.0.1', port: bridgePort })
    expect(verdict.outcome).not.toBe('recovered')
    // 2.5 秒后原设置已经恢复：若结论说「原设置仍未恢复」，那句话对客户是错的。
    expect(statusLater.unrestored).toBe('')
    expect(statusLater.state).toBe('已停止并恢复原设置')
    expect(verdict.code).toBe('TUNNEL_REPAIR_TIMEOUT')
    // 守护已确认恢复 → 结论就要照实说「已恢复原设置」，而不是「仍在恢复」或「未恢复」。
    expect(verdict.message).toContain('已停止连接并恢复原设置')
    expect(verdict.message).not.toContain('其他软件改动')
  }, 30_000)
}
