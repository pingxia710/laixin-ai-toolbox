// Phase 1 ③:schtasks 僵尸。settleResidentTask 的 5s 超时只 resolve 不 kill——杀软锁住
// schtasks.exe 挂住时,守护照常退出,挂着的孩子变孤儿;Windows 每次干净收尾攒一只,老机器
// 被拖慢(0.5.11 真机形态,Windows 真机复测待跑,见交付报告)。修后:超时兜底连子进程一起收。
// 黑盒验证:PATH 里放一只假 schtasks.exe(挂住/秒退两种),真进程跑守护走到自禁路径,
// 断言守护退出后假进程已死。⛔ 依赖 POSIX PATH 解析,只在 mac 开发/CI 树跑;Windows 真机
// 走 prod-p0-soak-windows 观测(僵尸形态在那边复核)。
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const roots: string[] = []
const temp = () => { const dir = makeTempDir('settle-kill-'); roots.push(dir); return dir }

interface Cleanup { (): void }
const cleanups: Cleanup[] = []
function teardownAll() {
  cleanups.splice(0).forEach((fn) => { try { fn() } catch { /* 收尾尽力争,不遮断言 */ } })
  roots.splice(0).forEach(removeTempDir)
}
process.on('exit', () => { cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } }) })

function makeFakeSchtasks(dir: string, mode: 'hang' | 'exit'): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'schtasks.exe')
  const pidfile = join(dir, 'schtasks.pid')
  const body = mode === 'hang'
    ? `#!/bin/sh\necho $$ > '${pidfile}'\nexec sleep 300\n`
    : `#!/bin/sh\necho $$ > '${pidfile}'\nexit 0\n`
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return pidfile
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(poll: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (poll()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timeout waiting for ${what}`)
}

/** 真进程跑常驻守护到「干净收尾→自禁」路径,返回守护退出后假 schtasks 的存活判定。 */
async function runDaemonUntilSettled(dataDir: string, pidfile: string): Promise<{ exitedAfterMs: number; pidSeen: boolean }> {
  const repo = join(__dirname, '..', '..')
  const daemonPath = join(repo, 'sidecar', 'mac', 'tunnel-daemon.mjs')
  writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'settle-1', updatedAt: Date.now() })
  const child = spawn(process.execPath, [daemonPath, 'start', '--data-dir', dataDir,
    '--adapter', join(repo, 'tests', 'tunnel', 'fixtures', 'fake-adapter.mjs'),
    '--resident', '1', '--task-path', 'LAIXIN-TEST-RESIDENT'], {
    env: { ...process.env, FAKE_ADAPTER_STORE: join(dataDir, 'fake-settings.json'),
      PATH: `${join(dataDir, 'bin')}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += String(c) })
  cleanups.push(() => { try { child.kill('SIGKILL') } catch { /* 已退 */ } })
  const exited = new Promise<number>((resolve) => { child.once('exit', (code) => resolve(code ?? -1)) })
  // 关机意图 → 守护记账(shutdown)→ 干净退出 0 → onExit 进自禁路径
  await waitFor(() => existsSync(join(dataDir, 'state.json')), 15_000, 'daemon first state')
  writeIntentFile(dataDir, { desired: 'shutdown', sessionToken: 'settle-1', updatedAt: Date.now() })
  const start = Date.now()
  const code = await exited
  const exitedAfterMs = Date.now() - start
  expect(code).toBe(0) // 非 0 不进自禁路径,测的不是它
  await waitFor(() => existsSync(pidfile), 5_000, 'fake schtasks pidfile')
  const pidSeen = existsSync(pidfile)
  if (pidSeen) {
    const pid = Number(readPid(pidfile))
    await new Promise((r) => setTimeout(r, 300)) // 留出 kill 生效的空档
    if (alive(pid)) {
      // 给修复一条宽限:kill 需要在守护退出前发生;宽限窗口内再查一次
      await waitFor(() => !alive(pid), 3_000, `fake schtasks (pid ${String(pid)}) to die after daemon exit; stderr tail: ${stderr.slice(-300)}`)
    }
  }
  return { exitedAfterMs, pidSeen }
}

function readPid(pidfile: string): string {
  return readFileSync(pidfile, 'utf8').trim()
}

describe('常驻任务自禁的超时兜底(schtasks 僵尸)', () => {
  it('挂住的 schtasks:守护干净退出后孩子必须被收掉,⛔ 留孤儿(基线留;修后收)', async () => {
    const dir = temp()
    const pidfile = makeFakeSchtasks(dir, 'hang')
    try {
      const { pidSeen } = await runDaemonUntilSettled(dir, pidfile)
      expect(pidSeen).toBe(true) // 自禁确实调了 schtasks
      const pid = Number(readPid(pidfile))
      expect(alive(pid)).toBe(false) // 基线:挂着变孤儿,红;修后:超时 kill,绿
    } finally { teardownAll() }
  }, 30_000)

  it('秒退的 schtasks:正常路径不受影响(照调、守护照退)', async () => {
    const dir = temp()
    const pidfile = makeFakeSchtasks(dir, 'exit')
    try {
      const { pidSeen, exitedAfterMs } = await runDaemonUntilSettled(dir, pidfile)
      expect(pidSeen).toBe(true)
      expect(exitedAfterMs).toBeLessThan(20_000)
    } finally { teardownAll() }
  }, 30_000)
})
