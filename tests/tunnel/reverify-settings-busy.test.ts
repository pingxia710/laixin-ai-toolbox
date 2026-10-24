// 甲-5 返工:复查(例行 + 确认)撞设置锁 ⛔ 当连接问题处理(验收 2026-09-17)。
// ①占锁 3/12/22 秒:连接器停止 0 次、重启 0 次,state 全程不出现 error/锁忙码,锁放开后补做真的跑了
//   (state 的 lastVerifiedAt 前进);②正向:占锁期间系统代理被人改了,锁放开后补做发现、按原有争抢
//   规则改回(TUNNEL_SETTINGS_CONTESTED)。真跨进程锁 + 真 createDaemon(只有连接器/桥是假的),
//   节奏与审计线 audit-j5-reverify-busy 同形:例行复查 30 秒一拍,确认复查 1 秒后。
// 两条都做过「改坏会红」自证:删掉 reverify catch 里的锁忙顺延分支 → ①全红(第 10 秒 error:SETTINGS_LOCK_BUSY、
// 连接器停 1 次);把顺延改成吞掉(deferReverifyForSettingsLock 直接 return)→ ②红(代理改不回来)。
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const ledgerUrl = pathToFileURL(join(__dirname, '../../sidecar/win/ledger.mjs')).href
const waitFor = async (check: () => boolean, ms = 60_000) => {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('waitFor 超时'); await new Promise((r) => setTimeout(r, 10)) }
}

interface Harness {
  root: string
  adapter: ReturnType<typeof createAdapter>
  clock: FakeClock
  states: string[]
  starts: () => number
  stops: () => number
  holder: ReturnType<typeof spawn>
  verifiedBefore: number | undefined
}

/** 已连接、系统代理已是我们的,然后另一进程拿走设置锁占 HOLD_MS。 */
async function connectedThenRivalHolds(HOLD_MS: number): Promise<Harness> {
  const root = makeTempDir('j5-reverify-')
  const adapter = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  writeIntentFile(root, { desired: 'connected', sessionToken: 'j5-reverify', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  let starts = 0
  let stops = 0
  const states: string[] = []
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    probeProxy: async () => { throw new Error('rival cannot reach internet') },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { starts += 1 }, stop: async () => { stops += 1 },
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }) })
  await daemon.run()
  await flushMicrotasks()
  const snap = (tag: string) => {
    const s = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string; code?: string; lastVerifiedAt?: number }
    states.push(`${tag}=${s.state}${s.code ? `:${s.code}` : ''}`)
    return s
  }
  const connected = snap('连上')
  expect(connected.state).toBe('connected')
  expect((adapter.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data).toContain('18080')
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withSettingsLock } from ${JSON.stringify(ledgerUrl)}
    import { writeFileSync } from 'node:fs'
    withSettingsLock(${JSON.stringify(root)}, () => {
      writeFileSync(${JSON.stringify(join(root, 'held'))}, String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${JSON.stringify(HOLD_MS)})
    }, { owner: 'slow-restore', timeoutMs: 60_000 })
  `], { stdio: 'ignore' })
  await waitFor(() => existsSync(join(root, 'held')))
  return { root, adapter, clock, states, starts: () => starts, stops: () => stops, holder, verifiedBefore: connected.lastVerifiedAt }
}

const releaseClock = async (harness: Harness) => {
  await waitFor(() => harness.holder.exitCode !== null)
  for (let i = 0; i < 10; i += 1) { harness.clock.advance(2_000); await flushMicrotasks(); await flushMicrotasks() }
}

it.each([3_000, 12_000, 22_000])('复查撞锁 %s 毫秒:不降级不拆连接,锁放开后补做(lastVerifiedAt 前进)', async HOLD_MS => {
  const harness = await connectedThenRivalHolds(HOLD_MS)
  try {
    harness.clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    const afterRoutine = JSON.parse(readFileSync(join(harness.root, 'state.json'), 'utf8'))
    harness.clock.advance(1_000); await flushMicrotasks(); await flushMicrotasks()
    const afterConfirm = JSON.parse(readFileSync(join(harness.root, 'state.json'), 'utf8'))
    await releaseClock(harness)
    const afterRelease = JSON.parse(readFileSync(join(harness.root, 'state.json'), 'utf8')) as { state: string; code?: string; lastVerifiedAt?: number }
    expect(afterRoutine.state).toBe('connected')
    expect(afterConfirm.state).toBe('connected')
    expect(afterRelease.state).toBe('connected')
    for (const line of harness.states) expect(line).not.toMatch(/error|SETTINGS_LOCK_BUSY|TUNNEL_SETTINGS_BUSY|TUNNEL_VERIFY_UNCONFIRMED/)
    expect(harness.stops()).toBe(0)
    expect(harness.starts()).toBe(1)
    expect(afterRelease.lastVerifiedAt).toBeGreaterThan(harness.verifiedBefore ?? 0)
  } finally {
    if (harness.holder.exitCode === null) harness.holder.kill('SIGKILL')
    removeTempDir(harness.root)
  }
}, 120_000)

it('正向:占锁期间系统代理被人改了,锁放开后补做发现并按争抢规则改回', async () => {
  const harness = await connectedThenRivalHolds(12_000)
  try {
    // 对手趁占锁改系统代理(锁在我们的数据目录上,系统设置的注册表不归它管)
    harness.adapter.write({ service: 'WinINET', item: 'ProxyServer' }, { type: 'REG_SZ', data: 'rival.example:8080' })
    expect((harness.adapter.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data).toContain('rival.example')
    harness.clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    harness.clock.advance(1_000); await flushMicrotasks(); await flushMicrotasks()
    await releaseClock(harness)
    const state = JSON.parse(readFileSync(join(harness.root, 'state.json'), 'utf8')) as { state: string; code?: string }
    // 补做发现被改 → 按原有争抢规则改回(记账 + 争抢标注),通道全程没拆
    expect((harness.adapter.read({ service: 'WinINET', item: 'ProxyServer' }) as { data?: string } | null)?.data).toContain('18080')
    expect(state.state).toBe('connected')
    expect(state.code).toBe('TUNNEL_SETTINGS_CONTESTED')
    expect(harness.states.join('\n')).not.toMatch(/error|SETTINGS_LOCK_BUSY|TUNNEL_SETTINGS_BUSY/)
    expect(harness.stops()).toBe(0)
  } finally {
    if (harness.holder.exitCode === null) harness.holder.kill('SIGKILL')
    removeTempDir(harness.root)
  }
}, 120_000)
