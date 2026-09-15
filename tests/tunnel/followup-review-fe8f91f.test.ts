// GPT-6 补核 fe8f91f R6:另一款代理软件先后把系统代理改成两个不同地址;
// 退出时必须把对方**最后**写的值还回去。fe8f91f 只记第一次的值 → 还回 7891(可能已停用),客户断网。
//
// 2026-09-15 更新(创始人定「两次连续被改即止损」):原用例里「每次都改回」是旧硬标准,已撤销——
// 第一次被改允许改回,同一连接周期内第二次又被改就停止自动写回、保留对方现值。
// R6 的原始意图(退出还给对方**最后**写的值)不受影响,仍然逐字保住:止损时账本同步更新到现值。
import { expect, it } from 'vitest'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir, writeIntentFile } from './helpers'

it('外部代理连续两次改成不同地址，退出应保留最后一次外部配置', async () => {
  const root = makeTempDir('review-external-latest-')
  const adapter = createAdapter({ FAKE_WININET_STORE: join(root, 'registry.json') })
  const clock = new FakeClock()
  const ref = { service: 'WinINET', item: 'ProxyServer' }
  const external = (port: number) => ({ type: 'REG_SZ' as const, data: `127.0.0.1:${port}` })
  adapter.write(ref, external(7890))
  adapter.write({ service: 'WinINET', item: 'ProxyEnable' }, { type: 'REG_DWORD', data: '1' })
  writeIntentFile(root, { desired: 'connected', sessionToken: 'review-latest-external', bridgePort: 18080,
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
  // 这条用例验的是「接管态下争抢」：必须钉死「对方出不了外网」，否则守护会按硬标准复用对方那条。
  // ⛔ 用默认的真探测——那会让结论取决于本机此刻装没装代理软件（本机 7890 上真有一个）。
  const daemon = createDaemon({ dataDir: root, adapter, clock, parentAlive: () => true, onExit: () => {},
    probeProxy: async () => { throw new Error('rival cannot reach internet') },
    connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {},
      localProxyPort: () => 1, onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
    bridgeFactory: () => ({ listen: async () => {}, close: async () => {}, isAlive: () => true, onLost: () => {} }) })
  try {
    await daemon.run()
    // 第一次被改:允许读取现状并改回(创始人 2026-09-15 第 2 条)
    adapter.write(ref, external(7891))
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(adapter.read(ref)).toEqual(external(18080))
    // 第二次又被改:止损,保留对方此刻的实际设置,⛔ 再改回去
    adapter.write(ref, external(7892))
    clock.advance(30_000); await flushMicrotasks(); await flushMicrotasks()
    expect(adapter.read(ref)).toEqual(external(7892))
    daemon.requestShutdown(); await flushMicrotasks()
    // 退出还原要还给对方最后写的 7892,⛔ 第一次被改回时记下的 7891(那个地址可能早已停用)
    expect(adapter.read(ref)).toEqual(external(7892))
  } finally {
    daemon.requestShutdown(); await flushMicrotasks()
    removeTempDir(root)
  }
})
