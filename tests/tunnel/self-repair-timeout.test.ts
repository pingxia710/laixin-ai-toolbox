// 通道已应用设置但出口复验永远不达标 → 修复超时。超时那一刻守护正在恢复原设置：结论必须等守护确认，
// ⛔ 拿恢复中的账本说「原设置仍未恢复：其他软件改动或权限限制」（独立验收打回项，慢适配器下稳定复现）。
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { layout } from '../../app/main/tunnel/paths'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { fakeAdapterEnv, forceTunnelPathForTest, makeTempDir, readFakeStore, removeTempDir, startFakeUpstream, waitFor, reapDaemons } from './helpers'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(timeoutMs: number, pollFlag: string[], adapterFile = './fixtures/fake-adapter.mjs') {
  const root = makeTempDir('laixin-repair-timeout-')
  cleanups.push(() => removeTempDir(root))
  const upstream = await startFakeUpstream()
  cleanups.push(() => upstream.killAll())
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  const sidecarDir = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
  const adapter = fileURLToPath(new URL(adapterFile, import.meta.url))
  const built = buildPackageEntries({ configVersion: 1 })
  const packageDir = writePackageDir(join(root, 'package'), built)
  const children: ChildProcess[] = []
  const launch = (command: string, runId = '') => {
    const child = spawn(process.execPath, [join(sidecarDir, 'tunnel-daemon.mjs'), command, '--data-dir', dataDir,
      '--adapter', adapter, '--run-id', runId, ...pollFlag, '--verify-interval-ms', '60000'],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: 'ignore' })
    children.push(child); return child
  }
  const service = new TunnelService({ dataDir, sidecarDir, picker: async () => packageDir,
    trust: { whitelistDigests: [built.digest], signingPublicKeys: [] }, now: () => Date.parse('2026-10-01T00:00:00Z'),
    spawnDaemon: (dir, runId) => { forceTunnelPathForTest(dir); return launch('start', runId) }, spawnRestore: () => launch('restore'),
    routesFile: join(sidecarDir, 'routes.default.json'), repairTimeoutMs: timeoutMs,
    // 出口 IP 拿不到：通道与系统代理都已应用，但复验永远不达标（类似生产的「通道待确认」）。
    connectorOverride: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '' } })
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
    const daemonState = () => { try { return JSON.parse(readFileSync(layout.state(f.dataDir), 'utf8')).state as string } catch { return '' } }
    await waitFor(() => daemonState() === 'connected', 8000)
    // 入口端口按候选表走(18080 被占就换 18180…),所以 ⛔ 把 18080 写死在断言里——
    // 那会让这条用例耦合一个全局资源:另一棵树在跑测试、或者客户机上真跑着别的代理占了 18080,它就红。
    // 要验的本来就是「系统代理指向守护此刻实际用的那个入口口」,读 state.json 的 bridgePort 才是正解。
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
