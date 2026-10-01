// P1(网络数据面优化):reverify 稳态扫描预算。连接已稳态(无待补写项)时,一个 30s 复验周期里
// 系统设置最多读两轮:第 1 轮 verifySettings(repair),第 2 轮 applySettings 内部的 settingsApplied 复验
// (其后写入路径自带逐项记账→写入→读回)。⛔ 第三轮显式 verifySettings(false):它与第 2 轮之间
// 零写入,读数必然一致,纯重复(Windows 每次读 = spawn reg.exe)。
// 变异自证:恢复第三次显式 verifySettings 调用 → 本用例红(读数轮数 2 → 3)。
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, readFakeOps, removeTempDir, writeIntentFile } from './helpers'

interface Harness {
  root: string
  adapter: ReturnType<typeof createAdapter>
  clock: FakeClock
  appliedItems: number
  readsAt: () => number
}

/** 已连接稳态(系统代理已是我们的,无任何待补写项)。 */
async function connectedSteady(): Promise<Harness> {
  const root = makeTempDir('netopt-reverify-')
  const adapter = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  writeIntentFile(root, { desired: 'connected', sessionToken: 'netopt-reverify', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    probeProxy: async () => { throw new Error('rival cannot reach internet') },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }) })
  await daemon.run()
  await flushMicrotasks()
  await flushMicrotasks()
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string }
  expect(state.state).toBe('connected')
  const readsAt = () => readFakeOps(join(root, 'registry.json')).filter((op) => op.op === 'read').length
  // 接管项数按账本 applied 设置条目算(夹具与真实 WinINET 适配器同形:Server/Enable/Override/AutoConfig…)。
  const ledger = JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8')) as Array<{ kind: string; status: string }>
  const appliedItems = ledger.filter((entry) => entry.kind === 'setting' && entry.status === 'applied').length
  expect(appliedItems).toBeGreaterThan(0)
  return { root, adapter, clock, appliedItems, readsAt }
}

it('稳态复验周期:系统设置读取 ≤ 两轮(第 1 轮 verify + applySettings 内一轮)', async () => {
  const harness = await connectedSteady()
  try {
    const before = harness.readsAt()
    harness.clock.advance(30_000)
    await flushMicrotasks()
    await flushMicrotasks()
    const delta = harness.readsAt() - before
    // 两轮 = verifySettings(repair) 一轮 + applySettings 内 settingsApplied 复验一轮;
    // 第三轮显式 verifySettings(false) 是纯重复,⛔ 回来。
    expect(delta).toBeLessThanOrEqual(harness.appliedItems * 2)
  } finally {
    removeTempDir(harness.root)
  }
}, 60_000)
