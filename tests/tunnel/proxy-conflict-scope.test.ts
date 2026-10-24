// D5(0.4.9 网络组):系统代理的冲突、写入范围与退出恢复。
// 客户最怕的三件事:①装了 Clash 还连工具箱,两套代理互相打架;②公司 VPN 一上一下,
// 代理写到一半、还原不回来;③自己改了系统设置,工具箱又给改回去。
// kill -9 之后的还原已由 daemon-process.test.ts(判据 3①/3③)在真实进程上验过,此处不重复。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon as macDaemon } from '../../sidecar/mac/daemon-core.mjs'
import { createDaemon as winDaemon } from '../../sidecar/win/daemon-core.mjs'
import { loadLedger as macLoadLedger } from '../../sidecar/mac/ledger.mjs'
import { loadLedger as winLoadLedger } from '../../sidecar/win/ledger.mjs'
import { connectionMessage } from '../../app/main/tunnel/status-service'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, readFakeStore, readJsonFile, removeTempDir, writeIntentFile } from './helpers'

const dirs: string[] = []
function temp() { const dir = makeTempDir('proxy-scope-'); dirs.push(dir); return dir }
afterEach(() => { dirs.splice(0).forEach(removeTempDir) })

const OUR = { enabled: true, host: '127.0.0.1', port: 18080 }

describe.each([
  ['macOS', macDaemon, macLoadLedger],
  ['Windows', winDaemon, winLoadLedger]
] as const)('%s 系统代理冲突与范围', (_platform, createDaemon, loadLedger) => {
  function harness(services = 'Wi-Fi', probeProxy: () => Promise<unknown> = async () => { throw new Error('existing proxy unusable') }) {
    const dir = temp()
    const storePath = join(dir, 'fake-system.json')
    const servicesPath = join(dir, 'services.txt')
    writeFileSync(servicesPath, services)
    const clock = new FakeClock()
    const adapter = createAdapter({ FAKE_ADAPTER_STORE: storePath, FAKE_ADAPTER_SERVICES_FILE: servicesPath,
      FAKE_ADAPTER_FAILURES: '{"write":[]}' } as NodeJS.ProcessEnv)
    const intent = { desired: 'connected', sessionToken: 'first', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } }
    writeIntentFile(dir, intent)
    const daemon = createDaemon({ random: () => 0, dataDir: dir, clock, adapter, parentAlive: () => true, onExit: vi.fn(), probeProxy,
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => {}, stop: async () => {}, localProxyPort: () => 1,
        onLost: () => {}, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => {}, close: async () => {} }) })
    return { dir, clock, daemon, storePath, intent,
      setServices: (next: string) => writeFileSync(servicesPath, next),
      store: () => readFakeStore(storePath),
      setStore: (value: Record<string, unknown>) => writeFileSync(storePath, JSON.stringify(value)),
      state: () => readJsonFile<{ state: string; code: string; message: string }>(join(dir, 'state.json')),
      ledger: () => loadLedger(dir) as Array<{ kind: string; service: string; status: string; note: string }> }
  }

  it('D5 一 · 别的代理软件正开着但出不了外网:接管建来信连接,它的设置记成原值、退出时还给它(⛔ 报冲突停下)', async () => {
    const h = harness()
    const theirs = { enabled: true, host: '127.0.0.1', port: 7890 } // Clash 之类,但已经不通
    h.setStore({ 'Wi-Fi/socks-proxy': theirs })

    await h.daemon.run()

    expect(h.state().state).toBe('connected')
    expect(h.store()['Wi-Fi/socks-proxy']).toEqual(OUR)
    const socksEntry = h.ledger().find((entry) => entry.kind === 'setting' && entry.service === 'Wi-Fi' && (entry as { item?: string }).item === 'socks-proxy') as { originalValue?: unknown } | undefined
    expect(socksEntry?.originalValue).toEqual(theirs)
    h.daemon.requestShutdown(); await flushMicrotasks()
    expect(h.store()['Wi-Fi/socks-proxy']).toEqual(theirs)
  })

  // 上线检查 §4-2:守护写进 state.json 的是**受控码**(message 就是 code),
  // 而状态映射此前用的 key 是 '冲突:已有代理控制' —— 那个字面只在 Windows 适配器抛错时出现过,
  // 从来没进过 state.json。结果两个平台的客户看到的都是裸码「已有代理控制」。
  it('D5 一 · 别的代理软件正开着且能出外网:复用它、一个字节不改,状态说清复用了谁(创始人 09-13 晚:有可用外网就复用、不抢)', async () => {
    const h = harness('Wi-Fi', async () => undefined)
    const theirs = { enabled: true, host: '127.0.0.1', port: 7890 }
    h.setStore({ 'Wi-Fi/socks-proxy': theirs })

    await h.daemon.run()

    const state = h.state()
    expect(state).toMatchObject({ state: 'connected', code: 'TUNNEL_REUSED_EXISTING' })
    expect(state.message).toContain('检测到电脑上的其他代理（127.0.0.1:7890）可联网')
    expect(connectionMessage(state)).toBe(state.message)
    expect(h.store()).toEqual({ 'Wi-Fi/socks-proxy': theirs })
    expect(h.ledger().filter((entry) => entry.kind === 'setting')).toEqual([])
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D5 一 · 我们自己写的那份不算冲突:同地址同端口照常连', async () => {
    const h = harness()
    h.setStore({ 'Wi-Fi/socks-proxy': OUR })

    await h.daemon.run()

    expect(h.state().state).toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D5 二 · 连接中出现新网卡:下一次复验把它一并纳管,账本随之补上(⛔ 新网卡不吃代理)', async () => {
    const h = harness('Wi-Fi')
    await h.daemon.run()
    expect(Object.keys(h.store())).toEqual(['Wi-Fi/socks-proxy'])

    h.setServices('Wi-Fi,公司VPN') // VPN 拨上来了
    h.clock.advance(30_000); await flushMicrotasks() // 复验 tick

    expect(Object.keys(h.store()).sort()).toEqual(['Wi-Fi/socks-proxy', '公司VPN/socks-proxy'])
    const managed = h.ledger().filter((entry) => entry.kind === 'setting').map((entry) => entry.service)
    expect(managed.sort()).toEqual(['Wi-Fi', '公司VPN']) // 写入范围 = 记账范围 = 将来的恢复范围
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D5 二 · 纳管后网卡消失:退出恢复不因为它卡住,如实记「已不存在」', async () => {
    const h = harness('Wi-Fi,公司VPN')
    await h.daemon.run()
    expect(Object.keys(h.store()).sort()).toEqual(['Wi-Fi/socks-proxy', '公司VPN/socks-proxy'])

    h.setServices('Wi-Fi') // VPN 断开,那条网络服务从系统里消失
    writeIntentFile(h.dir, { desired: 'user-disconnected', sessionToken: 'stop' })
    h.clock.advance(500); await flushMicrotasks()

    expect(h.state().state).toBe('stopped-restored') // ⛔ 卡在「原设置尚未恢复」
    expect(h.store()['Wi-Fi/socks-proxy']).toBeUndefined()
    const vpn = h.ledger().find((entry) => entry.service === '公司VPN')
    expect(vpn).toMatchObject({ status: 'restored', note: '该网络服务已不存在,无需恢复' })
    h.daemon.requestShutdown(); await flushMicrotasks()
  })

  it('D5 三 · 客户自己改了系统代理:工具箱 ⛔ 改回去,如实报状态', async () => {
    const h = harness()
    await h.daemon.run()
    expect(h.state().state).toBe('connected')

    const byCustomer = { enabled: true, host: '127.0.0.1', port: 1080 }
    h.setStore({ 'Wi-Fi/socks-proxy': byCustomer }) // 客户在系统设置里改了
    h.clock.advance(30_000); await flushMicrotasks() // 复验 tick

    expect(h.store()).toEqual({ 'Wi-Fi/socks-proxy': byCustomer }) // 原样保留,没被写回
    expect(h.state().state).not.toBe('connected')
    h.daemon.requestShutdown(); await flushMicrotasks()
  })
})
