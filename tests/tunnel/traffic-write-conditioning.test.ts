// Phase 1 ②:traffic 写盘条件化。M5 长跑证实基线每 2s 无条件写盘(含零流量,≈4.3 万次/日),
// 杀软/同步盘被狂醒。改后:观察仍 2s 一档(速率精度、断线结算不变),落盘只在「内容有变化或
// 30s 心跳」;UI 契约不破——状态行速率的新鲜窗口同步放宽到 45s(必须盖过 30s 心跳),速率图
// 60s 窗口的样品由渲染层 2s 轮询自产,断档清史(6s)只看轮询不看写盘,不受本改动影响。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon as macDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { computeStatus, type DaemonStateView } from '../../app/main/tunnel/status-service'
import { FakeClock, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, writeIntentFile } from './helpers'

const dirs: string[] = []
function temp() { const dir = makeTempDir('traffic-write-'); dirs.push(dir); return dir }
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

describe.each([
  ['macOS', macDaemon],
  ['Windows', winDaemon]
] as const)('%s traffic 写盘条件化', (_platform, createDaemon) => {
  function harness() {
    const dir = temp()
    const clock = new FakeClock()
    const stats = { uploadBytes: 0, downloadBytes: 0, observedAt: 1_000_000 }
    let settingsValue: unknown = null
    const intent = { desired: 'connected', sessionToken: 't1', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
    writeIntentFile(dir, intent)
    const exit = vi.fn()
    const daemon = createDaemon({ random: () => 0, dataDir: dir, clock,
      adapter: { managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }],
        read: () => settingsValue, write: (_ref: unknown, next: unknown) => { settingsValue = next } },
      parentAlive: () => true, onExit: exit,
      connectorFactory: () => ({ kind: 'loopback-probe', start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
        localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => {}, close: async () => {},
        traffic: () => ({ ...stats, activeStreams: 0 }) }) })
    const trafficPath = join(dir, 'traffic.json')
    return { dir, clock, daemon, intent, stats, trafficPath,
      mtime: () => { try { return statSync(trafficPath).mtimeMs } catch { return -1 } },
      traffic: () => readJsonFile<Record<string, number>>(trafficPath),
      bump: (upload: number, observedAt: number) => { stats.uploadBytes += upload; stats.observedAt = observedAt } }
  }

  async function idleWrites(h: ReturnType<typeof harness>, steps: number, stepMs: number): Promise<number> {
    let last = h.mtime()
    let writes = 0
    for (let i = 0; i < steps; i += 1) {
      h.clock.advance(stepMs)
      await flushMicrotasks()
      const now = h.mtime()
      if (now !== last) { writes += 1; last = now }
    }
    return writes
  }

  it('空闲挂机:内容无变化不再每 2s 写盘(基线 10 秒 5 次,改后 0 次)', async () => {
    const h = harness()
    await h.daemon.run()
    expect(existsSync(h.trafficPath)).toBe(true) // 首次观察建立文件
    await new Promise((r) => setTimeout(r, 3)) // 与首次写盘隔开真实毫秒,mtime 可比
    expect(await idleWrites(h, 5, 2_000)).toBe(0)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('流量有变化:下一次观察即落盘,速率按观察窗照算(精度不丢)', async () => {
    const h = harness()
    await h.daemon.run()
    const before = h.mtime()
    h.bump(2_000, h.stats.observedAt + 2_000) // 2s 窗口内累计 +2000B
    h.clock.advance(2_000); await flushMicrotasks()
    expect(h.mtime()).not.toBe(before) // 变化必写(改前后都必须绿:守的是「变化不丢」)
    expect(h.traffic()?.uploadBytesPerSecond).toBe(1_000)
    expect(h.traffic()?.uploadBytes).toBe(2_000)
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('空闲 30s 心跳:内容无变化也保一次写盘,UI 速率行 45s 新鲜窗口不断粮', async () => {
    const h = harness()
    await h.daemon.run()
    await new Promise((r) => setTimeout(r, 3))
    expect(await idleWrites(h, 14, 2_000)).toBe(0) // 28s 内:一次都不写
    expect(await idleWrites(h, 3, 2_000)).toBe(1) // 30s 心跳到点:恰好补一笔
    h.daemon.requestShutdown(); await flushMicrotasks()
  })
})

describe('状态行速率的新鲜窗口(与守护 30s 心跳配套)', () => {
  function statusTrafficWith(trafficUpdatedAt: number): string {
    const dir = temp()
    try {
      const batchId = '20260919000000-a1b2c3d4'
      mkdirSync(join(dir, 'imports', batchId, 'credentials'), { recursive: true })
      writeFileSync(join(dir, 'imports', batchId, 'manifest.json'), JSON.stringify({
        protocol: 'vless-reality', verifyUrl: 'https://laixin.net.cn/exit-ip', configVersion: 1,
        authorizationId: 'lx-' + 'a'.repeat(32), node: { host: '198.51.100.7', port: 443 },
        expiresAt: '2099-01-01T00:00:00Z', files: { 'credentials/vless.json': 'x' }
      }))
      writeFileSync(join(dir, 'imports', batchId, 'credentials', 'vless.json'), '{}')
      writeFileSync(join(dir, 'current'), batchId)
      // 与守护真实落盘形状一致(torndownStreams 未初始化,stringify 略过,⛔ 手写进去会被 reader 白名单拒)
      writeFileSync(join(dir, 'traffic.json'), JSON.stringify({ source: 'local-proxy-entry',
        uploadBytes: 0, downloadBytes: 0, uploadBytesPerSecond: 0, downloadBytesPerSecond: 0,
        activeStreams: 0, interruptedStreams: 0, updatedAt: trafficUpdatedAt }) + '\n')
      const daemon: DaemonStateView = { state: 'connected', runId: 'r', sessionToken: 's', code: '', message: '',
        exitIp: '203.0.113.1', lastVerifiedAt: Date.now() }
      return computeStatus({ dataDir: dir, daemonState: daemon, componentMissing: [], sshBinary: '',
        daemonUnexpectedExitAt: undefined }).traffic
    } finally { /* dirs 在 afterEach 统一清 */ }
  }

  it('30s 心跳的内容(45s 内)仍展示;超过 45s 算陈货不展示,⛔ 回到 10s 闷掉空闲速率行', () => {
    expect(statusTrafficWith(Date.now() - 30_000)).toContain('上传')
    expect(statusTrafficWith(Date.now() - 44_000)).toContain('上传')
    expect(statusTrafficWith(Date.now() - 50_000)).toBe('')
  })
})
