// 收敛包3·件1:主进程对守护非预期退出做有限退避重启(2s/10s/30s),
// 超过则停止重启、派发系统代理恢复,并让状态显示「网络守护已停止,点连接重试」。
import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonSupervisor, DAEMON_RESTART_BACKOFF_MS } from '../../app/main/tunnel/supervisor'
import { computeStatus } from '../../app/main/tunnel/status-service'
import { fakeAdapterEnv, makeTempDir, readJsonFile, startFakeUpstream, waitFor, writeIntentFile, type FakeUpstream } from './helpers'

interface FakeChild {
  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): void
}

function makeChild() {
  const listeners: Array<(code: number | null, signal: string | null) => void> = []
  return {
    child: { on: (event: string, callback: (code: number | null, signal: string | null) => void) => { if (event === 'exit') listeners.push(callback) } } as unknown as FakeChild,
    die: (code: number | null = null, signal: string | null = 'SIGKILL') => { for (const listener of listeners.splice(0)) listener(code, signal) }
  }
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-restart-'))
  const scheduled: Array<{ delayMs: number; fire: () => void }> = []
  const children: Array<{ child: FakeChild; die: () => void }> = []
  let restoreSpawned = 0
  const supervisor = new DaemonSupervisor({
    dataDir: root,
    spawnDaemon: () => {
      const made = makeChild()
      children.push(made)
      return made.child
    },
    spawnRestore: () => { restoreSpawned += 1; return undefined },
    scheduleRestart: (fire, delayMs) => { scheduled.push({ delayMs, fire }); return scheduled.length },
    cancelRestart: () => undefined
  })
  return {
    supervisor, scheduled, children, root,
    restoreSpawned: () => restoreSpawned,
    dieLast: () => { children[children.length - 1].die() },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

describe('守护退避重启与放弃恢复(收敛包3·件1)', () => {
  it('退避序列为 2s/10s/30s,最多重启 3 次', () => {
    expect(DAEMON_RESTART_BACKOFF_MS).toEqual([2_000, 10_000, 30_000])
  })

  it('非预期退出在退避时限内拉起守护;三次都失败后停止重启并派发系统代理恢复', () => {
    const h = makeHarness()
    h.supervisor.ensureRunning()
    expect(h.children.length).toBe(1)
    // 三轮:每次重启的守护再次非预期退出 → 按下一档退避排程
    for (const expectedDelay of DAEMON_RESTART_BACKOFF_MS) {
      h.dieLast()
      const scheduled = h.scheduled.splice(0)
      expect(scheduled.length).toBe(1)
      expect(scheduled[0].delayMs).toBe(expectedDelay)
      scheduled[0].fire()
    }
    expect(h.children.length).toBe(4)
    // 第 3 次重启后的退出:不再排程重启,转而派发恢复、置放弃位
    h.dieLast()
    expect(h.scheduled.length).toBe(0)
    expect(h.restoreSpawned()).toBe(1)
    expect(h.supervisor.surrendered).toBe(true)
    expect(h.supervisor.isRunning()).toBe(false)
    h.cleanup()
  })

  it('放弃后状态显示「网络守护已停止,点连接重试」', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'supervisor-status-'))
    try {
    const status = computeStatus({
      dataDir,
      daemonState: undefined,
      daemonUnexpectedExitAt: 1,
      daemonSurrendered: true,
      componentMissing: [],
      sshBinary: ''
    })
    expect(status.state).toBe('异常')
    expect(status.message).toContain('网络守护已停止，点连接重试')
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })

  it('用户点连接(ensureRunning)重置放弃状态,重新拉起守护', () => {
    const h = makeHarness()
    h.supervisor.ensureRunning()
    for (const _delay of DAEMON_RESTART_BACKOFF_MS) {
      void _delay
      h.dieLast()
      const scheduled = h.scheduled.splice(0)
      scheduled[0].fire()
    }
    h.dieLast()
    expect(h.supervisor.surrendered).toBe(true)
    h.supervisor.ensureRunning()
    expect(h.supervisor.surrendered).toBe(false)
    expect(h.children.length).toBe(5) // 初次 + 3 次重启 + 用户重试
    expect(h.supervisor.isRunning()).toBe(true)
    h.cleanup()
  })

  it('计划内退出(prepareForShutdown)不触发重启也不放弃', () => {
    const h = makeHarness()
    h.supervisor.ensureRunning()
    h.supervisor.prepareForShutdown()
    h.dieLast()
    expect(h.scheduled.length).toBe(0)
    expect(h.supervisor.surrendered).toBe(false)
    h.cleanup()
  })

  it('真实守护被 kill -9:supervisor 在退避时限内拉起并重连一次(全链路)', async () => {
    const upstream: FakeUpstream = await startFakeUpstream()
    const dataDir = makeTempDir('supervisor-kill9-')
    const storePath = join(dataDir, 'fake-system.json')
    const daemonPath = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
    const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
    const children: ChildProcess[] = []
    try {
      const supervisor = new DaemonSupervisor({
        dataDir,
        spawnRestore: () => undefined,
        spawnDaemon: (runId) => {
          const child = spawn(process.execPath, [
            daemonPath, 'start', '--data-dir', dataDir, '--run-id', runId,
            '--adapter', fakeAdapter, '--intent-poll-ms', '50', '--parent-poll-ms', '50', '--verify-interval-ms', '60000'
          ], { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: ['ignore', 'ignore', 'ignore'] })
          children.push(child)
          return child
        }
      })
      // 桥端口占用预登记,与 daemon-process 同款,防并发冲突
      const { createServer } = await import('node:net')
      const reservation = createServer()
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      const bridgePort = (reservation.address() as { port: number }).port
      await new Promise<void>((resolve) => reservation.close(() => resolve()))

      supervisor.ensureRunning()
      writeIntentFile(dataDir, {
        desired: 'connected',
        sessionToken: 'kill9-proc-test',
        bridgePort,
        connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: '203.0.113.7' }
      })
      await waitFor(() => existsSync(join(dataDir, 'state.json')) &&
        readJsonFile<{ state: string; runId: string }>(join(dataDir, 'state.json')).state === 'connected', 15_000)
      const firstRunId = readJsonFile<{ runId: string }>(join(dataDir, 'state.json')).runId

      // 真实故障:kill -9 杀死守护
      const daemonPid = children[0].pid
      expect(daemonPid).toBeDefined()
      process.kill(daemonPid as number, 'SIGKILL')

      // 退避(2s)内主进程拉起新守护;新守护读账本先恢复再按意图重连 → connected 且换 runId
      await waitFor(() => existsSync(join(dataDir, 'state.json')) &&
        readJsonFile<{ state: string; runId: string }>(join(dataDir, 'state.json')).state === 'connected' &&
        readJsonFile<{ runId: string }>(join(dataDir, 'state.json')).runId !== firstRunId, 15_000)
      expect(children.length).toBe(2)
      expect(supervisor.surrendered).toBe(false)
    } finally {
      for (const child of children.splice(0)) child.kill('SIGKILL')
      await upstream.killAll()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 40_000)
})
