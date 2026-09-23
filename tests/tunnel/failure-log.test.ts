// Phase 1 ④:静默失败日志＋UNKNOWN 归因。基线三处静默:wake 抛错/被拒被吞(「叫不动就靠下一轮」)、
// 开机校准失败 .catch(()=>undefined) 无声、恢复子进程失败只有 state.json 码没有一行日志说「当时谁挡的」。
// FB-1 的 UNKNOWN(9/45,TOP2)多数来自「意外退出/叫醒耗尽」这类现件丢失路径——现在起每一处都落
// 结构化事件(进 <userData>/logs/tunnel-daemon.log,诊断包既有通道收录),UNKNOWN 从此可归因。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFailureLog } from '../../app/main/tunnel/failure-log'
import { DaemonSupervisor, type ResidentBridge, type SpawnedDaemon } from '../../app/main/tunnel/supervisor'
import { makeResidentRuntime } from '../../app/main/tunnel/resident-bridge'

describe('createFailureLog(结构化失败日志)', () => {
  it('事件落一行:前缀+ISO 时刻+事件名+细节;目录不存在自动建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-log-'))
    try {
      const log = createFailureLog(join(dir, 'logs', 'tunnel-daemon.log'))
      log('wake-exhausted', '三轮叫醒后席位仍空')
      log('restore-failed', 'TUNNEL_RESTORE_TIMEOUT')
      const text = readFileSync(join(dir, 'logs', 'tunnel-daemon.log'), 'utf8')
      const lines = text.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('[tunnel-supervisor]')
      expect(lines[0]).toContain('wake-exhausted 三轮叫醒后席位仍空')
      expect(lines[1]).toContain('restore-failed TUNNEL_RESTORE_TIMEOUT')
      // 单行:诊断包按行收,⛔ 事件里带回车把一行撕成两行
      expect(lines.every((line) => !line.includes('\r'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('写不进去不炸调用方(日志是旁路,⛔ 挡主流程)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-log-'))
    try {
      const log = createFailureLog(join(dir, 'not-a-dir', 'file', 'tunnel-daemon.log'))
      expect(() => log('wake-error', 'x')).not.toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('监管器的失败留痕(UNKNOWN 归因的第一现场)', () => {
  function harness(resident?: ResidentBridge) {
    const root = mkdtempSync(join(tmpdir(), 'failure-log-sup-'))
    const logged: Array<{ event: string; detail: string }> = []
    const listeners: Array<(code: number | null, signal: string | null) => void> = []
    const child: SpawnedDaemon = {
      pid: 1,
      on: (event, callback) => { if (event === 'exit') listeners.push(callback) },
      kill: () => { for (const listener of listeners.splice(0)) listener(null, 'SIGKILL') }
    }
    let restoreSpawned = 0
    const supervisor = new DaemonSupervisor({
      dataDir: root,
      spawnDaemon: () => child,
      spawnRestore: () => { restoreSpawned += 1; return { pid: 2, on: () => {}, kill: () => {} } },
      resident,
      wait: async () => {},
      restoreDeadlineMs: 15,
      logFailure: (event: string, detail?: string) => logged.push({ event, detail: detail ?? '' })
    } as unknown as ConstructorParameters<typeof DaemonSupervisor>[0])
    return {
      supervisor, logged, root,
      die: () => { for (const listener of listeners.splice(0)) listener(null, 'SIGKILL') },
      restoreSpawned: () => restoreSpawned,
      cleanup: () => rmSync(root, { recursive: true, force: true })
    }
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 200; i += 1) await Promise.resolve()
  }

  it('守护意外退出:留痕 daemon-unexpected-exit(FB-1 里那笔 UNKNOWN 的第一现场)', () => {
    const h = harness()
    h.supervisor.ensureRunning()
    expect(h.logged).toEqual([]) // 正常 spawn 不留痕
    h.die()
    expect(h.logged.some((line) => line.event === 'daemon-unexpected-exit')).toBe(true)
    h.cleanup()
  })

  it('叫醒被拒/三轮耗尽:每次拒有 wake-miss,耗尽有 wake-exhausted,放弃位有代理恢复随行', async () => {
    const resident: ResidentBridge = { armed: () => true, alive: () => false, wake: async () => false }
    const h = harness(resident)
    h.supervisor.ensureRunning()
    await settle()
    expect(h.supervisor.surrendered).toBe(true) // 行为不变:耗尽仍放弃
    expect(h.logged.filter((line) => line.event === 'wake-miss')).toHaveLength(3)
    expect(h.logged.some((line) => line.event === 'wake-exhausted')).toBe(true)
    h.cleanup()
  })

  it('恢复子进程超时被杀:留痕 restore-failed 带码(处置有据,⛔ 只剩界面一句话)', async () => {
    // 走生产同一链条触发恢复:叫醒三轮耗尽 → 放弃位 → surrenderAndRestore 派恢复子进程 → deadline 杀。
    const resident: ResidentBridge = { armed: () => true, alive: () => false, wake: async () => false }
    const h = harness(resident)
    h.supervisor.ensureRunning()
    await settle()
    expect(h.restoreSpawned()).toBe(1) // 放弃位确实派了恢复子进程
    await new Promise((r) => setTimeout(r, 80)) // deadline 15ms 到点杀
    expect(h.logged.some((line) => line.event === 'restore-failed' && line.detail.includes('TUNNEL_RESTORE_TIMEOUT'))).toBe(true)
    h.cleanup()
  })
})

describe('常驻接线的失败留痕(校准/叫醒不再无声)', () => {
  function runtime(deps: {
    wake?: () => Promise<{ readonly woken: boolean }>
    install?: () => Promise<{ installed: boolean; reason?: string }>
    logFailure?: (event: string, detail?: string) => void
  }) {
    const runtime = makeResidentRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'failure-log-bridge-')),
      platform: 'macos', supported: true,
      spec: () => ({ executable: 'x', args: [], env: {}, logDir: '/tmp' }),
      install: deps.install ?? (async () => ({ installed: true })),
      uninstall: async () => {},
      ...(deps.wake !== undefined ? { wake: deps.wake } : {}),
      ...(deps.logFailure !== undefined ? { logFailure: deps.logFailure } : {})
    } as unknown as Parameters<typeof makeResidentRuntime>[0])
    return { runtime }
  }
  it('叫醒被拒:原因留痕(基线 .woken 一抛,reason 直接丢掉)', async () => {
    const logged: Array<{ event: string; detail: string }> = []
    const r = runtime({ wake: async () => ({ woken: false, reason: '拒绝访问' }),
      logFailure: (event, detail) => logged.push({ event, detail: detail ?? '' }) })
    expect(await r.runtime.bridge.wake()).toBe(false)
    expect(logged.some((line) => line.event === 'wake-refused' && line.detail.includes('拒绝访问'))).toBe(true)
  })

  it('校准抛错:留痕后照旧抛给调用方(行为不变,现场留下)', async () => {
    const logged: Array<{ event: string; detail: string }> = []
    const r = runtime({ install: async () => { throw new Error('bootstrap 挂了') },
      logFailure: (event, detail) => logged.push({ event, detail: detail ?? '' }) })
    await expect(r.runtime.calibrate(true)).rejects.toThrow('bootstrap 挂了')
    expect(logged.some((line) => line.event === 'calibrate-failed' && line.detail.includes('bootstrap 挂了'))).toBe(true)
  })

  it('校准装不上:留痕原因(客户侧「常驻没装上」从此查得到为什么)', async () => {
    const logged: Array<{ event: string; detail: string }> = []
    const r = runtime({ install: async () => ({ installed: false, reason: '权限不足' }),
      logFailure: (event, detail) => logged.push({ event, detail: detail ?? '' }) })
    const outcome = await r.runtime.calibrate(true)
    expect(outcome.installed).toBe(false)
    expect(logged.some((line) => line.event === 'calibrate-not-installed' && line.detail.includes('权限不足'))).toBe(true)
  })
})
