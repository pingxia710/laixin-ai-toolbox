// 守护常驻模式（--resident 1）：由系统的每用户机制看着，界面关了/崩了也不断网。
// 这里起真守护进程验四件事——脱父存活、第二个让位、关机信号仍完整还原、⛔ 与父进程 IPC 同时用。
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instanceLockPath, readInstanceLock } from '../../sidecar/win/instance-lock.mjs'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir, startFakeUpstream } from './helpers'

const daemonPath = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
const adapterPath = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs
  while (!check()) { if (Date.now() > deadline) throw new Error(`等待超时：${label}`); await sleep(50) }
}

async function stage() {
  const root = makeTempDir('resident-daemon-')
  cleanups.push(() => removeTempDir(root))
  const upstream = await startFakeUpstream()
  cleanups.push(() => upstream.killAll())
  const storePath = join(root, 'fake-system.json')
  writeFileSync(join(root, 'intent.json'), JSON.stringify({
    desired: 'connected', sessionToken: 'resident', updatedAt: Date.now(),
    authorization: { id: 'resident-fixture', expiresAt: Date.now() + 300_000 },
    connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.9' },
    routes: { directSuffixes: [], protectedDirectSuffixes: [] }
  }))
  const children: ChildProcess[] = []
  const launch = (args: string[], runId: string) => {
    const child = spawn(process.execPath, [daemonPath, 'start', '--data-dir', root, '--adapter', adapterPath,
      '--intent-poll-ms', '100', '--parent-poll-ms', '100', '--verify-interval-ms', '60000', '--run-id', runId, ...args],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    children.push(child)
    return { child, stderr: () => stderr }
  }
  cleanups.push(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGKILL')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000, '收尾').catch(() => undefined)
    }
  })
  const state = () => { try { return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { state: string } } catch { return undefined } }
  return { root, storePath, launch, state, upstream }
}

describe('守护常驻模式', () => {
  it('脱开父进程照样连上并留下来（界面关了/崩了不断网），席位记着自己', async () => {
    const s = await stage()
    const first = s.launch(['--resident', '1'], 'resident-a')
    await waitFor(() => s.state()?.state === 'connected', 15_000, `连上；stderr=${first.stderr()}`)
    // 本进程就是它的父进程；杀不掉父进程时改看：守护不依赖 IPC，父进程没有 IPC 通道它也活着
    expect(first.child.exitCode).toBeNull()
    expect(readInstanceLock(s.root)?.holder).toMatchObject({ pid: first.child.pid, runId: 'resident-a' })
    await sleep(600)
    expect(s.state()?.state).toBe('connected') // 没有 IPC 也没有心跳,守护 ⛔ 自己退出
    expect(readFakeStore(s.storePath)['Wi-Fi/socks-proxy']).toBeDefined()
  }, 30_000)

  it('第二个常驻守护安静让位（退出 0），⛔ 踢掉在跑的那个、⛔ 动它的系统设置', async () => {
    const s = await stage()
    const first = s.launch(['--resident', '1'], 'resident-a')
    await waitFor(() => s.state()?.state === 'connected', 15_000, `第一个连上；stderr=${first.stderr()}`)
    const proxyBefore = readFakeStore(s.storePath)['Wi-Fi/socks-proxy']
    const seatBefore = readInstanceLock(s.root)

    const second = s.launch(['--resident', '1'], 'resident-b')
    await waitFor(() => second.child.exitCode !== null, 10_000, '第二个让位')
    expect(second.child.exitCode).toBe(0) // ⛔ 非零码：会被 KeepAlive 反复拉起打转
    expect(second.stderr()).toContain('让位')
    // 第一个原封不动
    expect(first.child.exitCode).toBeNull()
    expect(s.state()?.state).toBe('connected')
    expect(readFakeStore(s.storePath)['Wi-Fi/socks-proxy']).toEqual(proxyBefore)
    expect(readInstanceLock(s.root)?.holder).toEqual(seatBefore?.holder)
  }, 40_000)

  it('关机信号（SIGTERM）仍走完整还原：「常驻」⛔ 等于「关机也不还」', async () => {
    const s = await stage()
    const first = s.launch(['--resident', '1'], 'resident-a')
    await waitFor(() => s.state()?.state === 'connected', 15_000, `连上；stderr=${first.stderr()}`)
    expect(readFakeStore(s.storePath)['Wi-Fi/socks-proxy']).toBeDefined()

    first.child.kill('SIGTERM')
    await waitFor(() => first.child.exitCode !== null, 15_000, 'SIGTERM 后退出')
    expect(first.child.exitCode).toBe(0)
    expect(s.state()?.state).toBe('stopped-restored')
    expect(readFakeStore(s.storePath)).toEqual({}) // 系统设置还干净了
    expect(existsSync(instanceLockPath(s.root))).toBe(false) // 席位让出来了
  }, 40_000)

  it('⛔ 常驻与父进程 IPC 同时用（两套去留规则会打架）', async () => {
    const s = await stage()
    const both = s.launch(['--resident', '1', '--parent-ipc', '1'], 'resident-x')
    await waitFor(() => both.child.exitCode !== null, 10_000, '拒绝启动')
    expect(both.child.exitCode).not.toBe(0)
    expect(both.stderr()).toContain('RESIDENT_WITH_PARENT_IPC')
  }, 20_000)
})

describe('常驻守护的自检接线（程序被删）', () => {
  it('程序还在时不触发自愈；连续探不到才算数（⛔ 更新原地换 bundle 的一瞬被误判）', async () => {
    const s = await stage()
    const first = s.launch(['--resident', '1'], 'resident-a')
    await waitFor(() => s.state()?.state === 'connected', 15_000, `连上；stderr=${first.stderr()}`)
    // 程序好端端在，自检节拍跑了很多轮也不该动客户的设置
    await sleep(1500)
    expect(s.state()?.state).toBe('connected')
    expect(readFakeStore(s.storePath)['Wi-Fi/socks-proxy']).toBeDefined()
    expect(first.child.exitCode).toBeNull()
  }, 30_000)
})
