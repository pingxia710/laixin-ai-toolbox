import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { BridgeError } from '../../app/main/bridge/action-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import { layout } from '../../app/main/tunnel/paths'
import { readTunnelSnapshot } from '../../app/main/tunnel/runtime'
import { initializeTunnelRuntime } from '../../app/main/tunnel/runtime-owner'
import { DEFAULT_BRIDGE_PORT, TunnelService, type TunnelServiceDeps } from '../../app/main/tunnel/tunnel-service'
import type { TunnelStatusView } from '../../app/preload/api/tunnel'
import { lastIntent } from '../../sidecar/mac/ledger.mjs'
import { buildPackageEntries, writePackageDir, type BuiltPackage } from './fixtures/package-builder'
import {
  fakeAdapterEnv,
  makeTempDir,
  readFakeStore,
  readJsonFile,
  removeTempDir,
  startFakeUpstream,
  waitFor,
  type FakeUpstream
} from './helpers'

const DAEMON_PATH = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
const FAKE_ADAPTER = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
const SIDECAR_DIR = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
const NOW = Date.parse('2026-10-01T00:00:00Z')
const EXIT_IP = '203.0.113.7'

describe('五动作与桥注册(判据 3②③主进程侧、6 IPC 负向、12 状态行、17 服务级互斥)', () => {
  let dataDir: string
  let packageDir: string
  let storePath: string
  let upstream: FakeUpstream
  const spawnedChildren: ChildProcess[] = []

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-ipc-')
    packageDir = makeTempDir('laixin-ipcpkg-')
    storePath = join(dataDir, 'fake-system.json')
    upstream = await startFakeUpstream()
  })

  afterEach(async () => {
    for (const child of spawnedChildren.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      try { child.kill('SIGTERM') } catch { continue }
      try {
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000)
      } catch {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000)
      }
    }
    await upstream.killAll()
    await expect.poll(() => portOpen(DEFAULT_BRIDGE_PORT), { interval: 50, timeout: 3_000 }).toBe(false)
    removeTempDir(dataDir)
    removeTempDir(packageDir)
  })

  function makeDeps(picker: TunnelServiceDeps['picker'], trustDigests: string[] = []): TunnelServiceDeps {
    return {
      dataDir,
      sidecarDir: SIDECAR_DIR,
      picker,
      trust: { whitelistDigests: trustDigests, signingPublicKeys: [] },
      now: () => NOW,
      spawnDaemon: (dir: string) => {
        const child = spawn(
          process.execPath,
          [
            DAEMON_PATH,
            'start',
            '--data-dir',
            dir,
            '--adapter',
            FAKE_ADAPTER,
            '--intent-poll-ms',
            '50',
            '--parent-poll-ms',
            '50',
            '--verify-interval-ms',
            '60000'
          ],
          { env: { ...process.env, ...fakeAdapterEnv(storePath) } }
        )
        spawnedChildren.push(child)
        return child
      },
      spawnRestore: (dir: string) => {
        const child = spawn(
          process.execPath,
          [DAEMON_PATH, 'restore', '--data-dir', dir, '--adapter', FAKE_ADAPTER],
          { env: { ...process.env, ...fakeAdapterEnv(storePath) } }
        )
        spawnedChildren.push(child)
      },
      routesFile: join(SIDECAR_DIR, 'routes.default.json'),
      reuseDirect: false,
      connectorOverride: {
        kind: 'loopback-probe',
        host: '127.0.0.1',
        port: upstream.port,
        exitIp: EXIT_IP
      }
    }
  }

  function wire(service: TunnelService): BridgeRegistry {
    const registry = new BridgeRegistry()
    registerActions(registry, { service })
    return registry
  }

  function writeFixturePackage(built: BuiltPackage, name: string): string {
    return writePackageDir(join(packageDir, name), built)
  }

  it('桥注册:五个动作在注册表内;未暴露方法与非法参数被拒(判据 6 IPC 负向)', async () => {
    const registry = wire(new TunnelService(makeDeps(() => Promise.resolve(undefined))))
    const status = (await registry.execute('tunnel.status', undefined)) as TunnelStatusView
    expect(status.state).toBe('未配置')
    expect(status.authorization).toBe('')
    await expect(registry.execute('tunnel.exec', undefined)).rejects.toThrowError(BridgeError)
    await expect(registry.execute('tunnel.start', { path: '/etc/passwd' })).rejects.toThrowError(BridgeError)
  })

  it('路由解释只接收域名输入，并使用已应用配置的同一套规则', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'route-explain')
    const registry = wire(new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest])))
    await registry.execute('tunnel.importConfig', undefined)
    await registry.execute('tunnel.applyPending', undefined)
    expect(await registry.execute('tunnel.explainRoute', { host: 'api.deepseek.com' })).toMatchObject({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT' })
    expect(await registry.execute('tunnel.explainRoute', { host: 'unlisted.example' })).toMatchObject({ outcome: 'kernel-check', reasonCode: 'XRAY_GEOSITE_OR_DEFAULT' })
    await expect(registry.execute('tunnel.explainRoute', { host: 'api.deepseek.com', path: '/etc/passwd' })).rejects.toThrowError(BridgeError)
  })

  it('status 脱敏与判据 12 状态行(逐字);摘要 grep 不到凭据路径与内容(判据 6)', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'pkg')
    const registry = wire(new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest])))

    const imported = (await registry.execute('tunnel.importConfig', undefined)) as { outcome: string }
    expect(imported.outcome).toBe('imported')
    const status = (await registry.execute('tunnel.status', undefined)) as TunnelStatusView
    expect(status.source).toBe('来源:未签名(内部测试包)')
    expect(status.authorization).toBe('授权:本地包载明,未经后台确认')
    expect(status.backend).toBe('后台:未接入')
    expect(status.nodeLabel).toBe('node-a.test.invalid:22')
    expect(status.pendingAvailable).toBe(true)

    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('credentials/')
    expect(serialized).not.toContain('FAKE-TEST-PRIVATE-KEY')
    expect(serialized).not.toContain('id_ed25519')
  })

  it('完整链路:导入 → 应用 → 起 → 已连(出口 IP) → 已连时应用被拒 → 守护 kill -9 → 异常 + 未恢复项 → 重启先恢复(判据 3②③)', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'pkg')
    const service = new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest]))
    const registry = wire(service)

    expect(((await registry.execute('tunnel.importConfig', undefined)) as { outcome: string }).outcome).toBe('imported')
    expect(((await registry.execute('tunnel.applyPending', undefined)) as { outcome: string }).outcome).toBe('applied')
    expect(((await registry.execute('tunnel.start', undefined)) as { outcome: string }).outcome).toBe('started')
    await waitFor(() => service.status().state === '已连' && service.status().exitIp === EXIT_IP, 10_000)
    expect(service.status().exitIp).toBe(EXIT_IP)

    const appliedWhileConnected = (await registry.execute('tunnel.applyPending', undefined)) as {
      code: string
      message: string
    }
    expect(appliedWhileConnected.code).toBe('TUNNEL_STATE_NOT_ALLOWED')
    expect(appliedWhileConnected.message).toContain('断开后应用')

    const daemonPid = spawnedChildren.at(-1)?.pid
    expect(daemonPid).toBeDefined()
    process.kill(daemonPid ?? 0, 'SIGKILL')
    await waitFor(() => service.status().state === '异常', 10_000)
    const afterCrash = service.status()
    expect(afterCrash.message).toContain('守护进程意外退出')
    expect(afterCrash.unrestored).toContain('Wi-Fi/socks-proxy')
    process.stdout.write(`\n[判据3② 守护 kill -9 后 status]\n${JSON.stringify(afterCrash, null, 2)}\n`)

    // 判据 3③ 主进程侧:新 service 实例构造即恢复未恢复项
    const service2 = new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest]))
    await waitFor(() => readFakeStore(storePath)['Wi-Fi/socks-proxy'] === undefined, 10_000)
    expect(readFakeStore(storePath)).toEqual({})
    void service2
  }, 30_000)

  it('关窗口即停:退出钩子 → 意图落盘 shutdown → 守护恢复并退出(定稿第 4 轮 12)', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'pkg')
    const service = new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest]))
    const registry = wire(service)

    await registry.execute('tunnel.importConfig', undefined)
    await registry.execute('tunnel.applyPending', undefined)
    await registry.execute('tunnel.start', undefined)
    await waitFor(() => service.status().state === '已连', 10_000)

    await service.requestShutdown()
    await waitFor(
      () => readJsonFile<{ state: string }>(join(dataDir, 'state.json')).state === 'stopped-restored',
      10_000
    )
    expect(readFakeStore(storePath)).toEqual({})
    expect(lastIntent(dataDir)).toBe('shutdown')
    expect(service.status().state).not.toBe('异常')
  }, 30_000)

  it('组件缺失(判据 10 反证的端侧部分):sidecar 目录缺失 → status 报「组件缺失」且 start 拒绝 ⛔ 静默', async () => {
    const service = new TunnelService({
      ...makeDeps(() => Promise.resolve(undefined)),
      sidecarDir: '/nonexistent-sidecar'
    })
    const registry = wire(service)
    const status = (await registry.execute('tunnel.status', undefined)) as TunnelStatusView
    expect(status.componentMissing).toContain('组件缺失')
    expect(status.componentMissing).toContain('tunnel-daemon.mjs')
    const started = (await registry.execute('tunnel.start', undefined)) as { code: string; message: string }
    expect(started.code).toBe('TUNNEL_COMPONENT_MISSING')
    expect(started.message).toContain('组件缺失')
  })

  it('判据 17 服务级:导入持锁时并发 start → 后者 TUNNEL_BUSY,指针与账本无交错写入', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'pkg')
    let releasePicker: (() => void) | undefined
    const slowPicker = () =>
      new Promise<string | undefined>((resolvePromise) => {
        releasePicker = () => resolvePromise(dir)
      })
    const service = new TunnelService(makeDeps(slowPicker, [built.digest]))
    const registry = wire(service)

    const importPromise = registry.execute('tunnel.importConfig', undefined)
    await waitFor(() => releasePicker !== undefined)
    const startResult = (await registry.execute('tunnel.start', undefined)) as { code: string }
    expect(startResult.code).toBe('TUNNEL_BUSY')
    expect(existsSync(layout.currentPointer(dataDir))).toBe(false)
    expect(existsSync(layout.pendingPointer(dataDir))).toBe(false)

    releasePicker?.()
    const importResult = (await importPromise) as { outcome: string }
    expect(importResult.outcome).toBe('imported')
  }, 20_000)

  it('运行时取用面:五动作与其他主进程模块读取同一动态通道状态', async () => {
    const built = buildPackageEntries({ configVersion: 1 })
    const dir = writeFixturePackage(built, 'runtime-pkg')
    let created = 0
    initializeTunnelRuntime(() => {
      created += 1
      return new TunnelService(makeDeps(() => Promise.resolve(dir), [built.digest]))
    })
    const actions = new BridgeRegistry()
    const anotherMainModule = new BridgeRegistry()

    registerActions(actions)
    registerActions(anotherMainModule)
    expect(created).toBe(1)
    expect(readTunnelSnapshot()).toEqual({ state: 'stopped', localProxyUrl: undefined })

    expect(((await actions.execute('tunnel.importConfig', undefined)) as { outcome: string }).outcome).toBe('imported')
    expect(((await actions.execute('tunnel.applyPending', undefined)) as { outcome: string }).outcome).toBe('applied')
    expect(((await actions.execute('tunnel.start', undefined)) as { outcome: string }).outcome).toBe('started')
    await waitFor(() => {
      const snapshot = readTunnelSnapshot()
      return snapshot.state === 'connected' && snapshot.localProxyUrl !== undefined
    }, 10_000)
    const bridgePort = readJsonFile<{ bridgePort: number }>(layout.state(dataDir)).bridgePort
    expect(bridgePort).toBeGreaterThan(0)
    expect(readTunnelSnapshot()).toEqual({ state: 'connected', localProxyUrl: `http://127.0.0.1:${bridgePort}` })
    expect(((await anotherMainModule.execute('tunnel.status', undefined)) as { state: string }).state).toBe('已连')

    expect(((await anotherMainModule.execute('tunnel.stop', undefined)) as { outcome: string }).outcome).toBe('stopped')
    await waitFor(() => readTunnelSnapshot().state === 'stopped', 10_000)
    expect(readTunnelSnapshot()).toEqual({ state: 'stopped', localProxyUrl: undefined })
  }, 30_000)
})

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open: boolean) => { socket.destroy(); resolve(open) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(200, () => finish(false))
  })
}
