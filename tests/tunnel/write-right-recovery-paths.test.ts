// 一次性恢复路径的写入权覆盖(审查第二轮 P1-1)。
//
// 守护的连接路径由 DaemonCore 自己持权,但**这些入口不经过它**:
// restore 子命令(主进程 recoverOnBoot / runRecoveryOnce 派发)、损坏账本恢复、崩溃兜底、常驻自愈。
// 它们都会直接写 WinINET,两份安装都会走到——不纳进同一把权,前面修的等于漏了一半。
//
// 这里走**真实子进程入口**,⛔ 直接构造 DaemonCore:上一轮的用例就是因为只测 DaemonCore,
// 才没能发现这些路径根本没被覆盖。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCrashBailout } from '../../sidecar/win/daemon-core.mjs'
import { guardedResidentSelfHeal } from '../../sidecar/win/write-right-owner.mjs'
import { appendSettingEntry } from '../../sidecar/win/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const daemonPath = fileURLToPath(new URL('../../sidecar/win/tunnel-daemon.mjs', import.meta.url))
const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))

describe('一次性恢复路径必须持有写入权', () => {
  let dataDir: string
  let store: string
  beforeEach(() => {
    dataDir = makeTempDir('wr-recovery-')
    store = join(dataDir, 'store.json')
    // 系统里现在是「我们上次写进去的值」,还原会真的发生写入。
    writeFileSync(store, JSON.stringify({ 'WinINET/ProxyServer': { type: 'REG_SZ', data: '127.0.0.1:18080' } }))
    appendSettingEntry(dataDir, { service: 'WinINET', item: 'ProxyServer',
      originalValue: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'prev', time: 1 })
  })
  afterEach(() => removeTempDir(dataDir))

  function runDaemon(args: string[], extraEnv: Record<string, string>): Promise<{ code: number | null; output: string }> {
    const outPath = join(dataDir, 'daemon.out.log')
    const fd = openSync(outPath, 'a')
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(process.execPath, [daemonPath, ...args, '--data-dir', dataDir, '--adapter', fakeAdapter], {
        env: { ...process.env, FAKE_ADAPTER_STORE: store, ...extraEnv },
        stdio: ['ignore', fd, fd]
      })
      closeSync(fd)
      const guard = setTimeout(() => child.kill('SIGKILL'), 15_000)
      child.once('error', (error) => { clearTimeout(guard); reject(error) })
      child.once('close', (code) => {
        clearTimeout(guard)
        let output = ''
        try { output = readFileSync(outPath, 'utf8') } catch { /* 无输出 */ }
        resolve({ code, output })
      })
    })
  }

  const registry = () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, { data: string }>

  it('restore 子命令:持权方存在时一个字节都不写,并如实报未完成(⛔ 让主进程以为已还干净)', async () => {
    const { code, output } = await runDaemon(['restore'], { FAKE_WRITE_RIGHT: 'held' })
    // 客户的现值原样停着,⛔ 被越权还原成 7890。
    expect(registry()['WinINET/ProxyServer'].data).toBe('127.0.0.1:18080')
    // 退出码必须是「未完成」,否则主进程会当成恢复成功。
    expect(code).toBe(65)
    expect(output).toContain('写入权不在本进程')
    const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { state: string; code: string }
    expect(state).toMatchObject({ state: 'error', code: 'TUNNEL_WRITE_RIGHT_HELD' })
  })

  it('restore 子命令:持权在自己手上时照常还原(正向证据,⛔ 只证明「不写」)', async () => {
    const { code } = await runDaemon(['restore'], { FAKE_WRITE_RIGHT: 'free' })
    expect(registry()['WinINET/ProxyServer'].data).toBe('127.0.0.1:7890')
    expect(code).toBe(0)
  })

  // 残留清理只在**空账本**时开火(账本里有设置条目就轮不到它)。上面几条用例每次都写账本,
  // 正好把这条路径整个绕开了——它曾经跑在写入权之外。
  function emptyLedgerWithOurProxy() {
    writeFileSync(join(dataDir, 'ledger.json'), '[]')
    writeFileSync(store, JSON.stringify({
      'WinINET/ProxyEnable': { type: 'REG_DWORD', data: '1' },
      'WinINET/ProxyServer': { type: 'REG_SZ', data: '127.0.0.1:18080' }
    }))
  }

  it('空账本 + 代理指向来信端口 + 权被占用:残留清理也不许写 ProxyEnable', async () => {
    emptyLedgerWithOurProxy()
    const { output } = await runDaemon(['restore'], { FAKE_WRITE_RIGHT: 'held' })
    // 系统代理此刻归持权那一方管:⛔ 被我们顺手关掉。
    expect(registry()['WinINET/ProxyEnable'].data).toBe('1')
    expect(output).toContain('写入权不在本进程')
  })

  it('空账本 + 代理指向来信端口 + 权在自己手上:残留照常清理(正向证据)', async () => {
    emptyLedgerWithOurProxy()
    await runDaemon(['restore'], { FAKE_WRITE_RIGHT: 'free' })
    // ⛔ 只断言上一条「没写」——那在清理功能整个坏掉时也成立。
    expect(registry()['WinINET/ProxyEnable'].data).toBe('0')
  })

  it('损坏账本恢复:持权方存在时不写系统设置', async () => {
    // account 标记 + 坏账本 → 走 recoverLedger 分支
    writeFileSync(join(dataDir, 'ledger.json'), '{ 这不是 JSON')
    const { output } = await runDaemon(['restore'], { FAKE_WRITE_RIGHT: 'held' })
    expect(registry()['WinINET/ProxyServer'].data).toBe('127.0.0.1:18080')
    expect(output).toContain('写入权不在本进程')
  })

  it('常驻自愈:持权方存在时不执行,报「这轮先不做」而 ⛔ 谎称已还干净退出', () => {
    let ran = false
    const held = { acquireWriteRight: () => ({ acquired: false as const, reason: 'held' as const }) }
    const outcome = guardedResidentSelfHeal(held, () => { ran = true; return { shouldExit: true } as never })
    expect(ran).toBe(false)
    expect(outcome).toMatchObject({ settingsBusy: true, shouldExit: false, reason: 'write-right-held' })
    // 正向证据:权在自己手上时它照常执行(⛔ 只证明「不执行」——那在函数坏掉时也成立)
    const free = { acquireWriteRight: () => ({ acquired: true as const, abandoned: false, release: () => undefined }) }
    const ok = guardedResidentSelfHeal(free, () => ({ shouldExit: true, restored: 3 } as never))
    expect(ok).toMatchObject({ shouldExit: true, restored: 3 })
  })

  it('崩溃兜底:持权方存在时不碰系统设置,状态说明归属', () => {
    const adapter = {
      read: () => ({ type: 'REG_SZ', data: '127.0.0.1:18080' }),
      write: () => { throw new Error('崩溃兜底不该写') },
      managedItems: () => [],
      acquireWriteRight: () => ({ acquired: false as const, reason: 'held' as const })
    }
    const exits: number[] = []
    // installCrashBailout 把 handler 挂在 process 上、只返回 dispose;取刚注册的那个直接触发,
    // ⛔ 真的抛未捕获异常(会打死测试进程)。
    const bailout = installCrashBailout({ dataDir, adapterOf: () => adapter, runId: 'crash-test',
      exit: (code: number) => { exits.push(code) }, log: () => undefined })
    try {
      const listeners = process.listeners('uncaughtException')
      const ours = listeners[listeners.length - 1] as (reason: unknown) => void
      ours(new Error('boom'))
    } finally { bailout.dispose() }
    expect(exits).toEqual([70])
    const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { message: string }
    expect(state.message).toContain('另一个来信后台管理')
  })
})
