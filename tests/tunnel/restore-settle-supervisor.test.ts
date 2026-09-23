// N-23:重启后卡「原设置尚未恢复」——一次性恢复子进程的三条静默分支与竞速编排。
//  · 席上有自家常驻守护时,恢复归它按意图结算(recoverOnBoot ⛔ 另派竞速子进程:0 秒抢写权失败即退,账本没机会被碰);
//  · 恢复子进程必须有 deadline+杀死路径(TUNNEL_RESTORE_TIMEOUT),spawn 失败必须落码(TUNNEL_RESTORE_SPAWN_FAILED)——
//    基线两条都静默:watchRestore 只等 exit,child.once('error') 吞进 done(null),不写任何状态。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DaemonSupervisor } from '../../app/main/tunnel/supervisor'
import { KNOWN_FAILURE_CODES } from '../../app/main/tunnel/failure-codes'
import { connectionMessage, readDaemonState } from '../../app/main/tunnel/status-service'
import { waitFor } from './helpers'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })

const directory = () => { const root = mkdtempSync(join(tmpdir(), 'restore-settle-')); roots.push(root); return root }

interface RestoreChildControl {
  child: unknown
  exit: (code: number | null) => void
  fail: () => void
  killCalls: string[]
}

function makeRestoreChild(): RestoreChildControl {
  const exitListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<() => void> = []
  const killCalls: string[] = []
  return {
    child: {
      on: (event: string, callback: (code: number | null) => void) => { if (event === 'exit') exitListeners.push(callback) },
      once: (event: string, callback: () => void) => { if (event === 'error') errorListeners.push(callback) },
      kill: (signal?: string) => { killCalls.push(signal ?? 'SIGTERM') }
    },
    exit: (code) => { for (const listener of exitListeners.splice(0)) listener(code) },
    fail: () => { for (const listener of errorListeners.splice(0)) listener() },
    killCalls
  }
}

/** 种子一条「连接中被硬重启」的账目(上次写下去还没还回,状态 applied=界面上的「未完成(进程中断)」)。 */
function seedInterruptedLedger(root: string): void {
  writeFileSync(join(root, 'ledger.json'), `${JSON.stringify([
    { id: 'n23-1', kind: 'setting', service: 'WinINET', item: 'ProxyServer',
      originalValue: null, writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' },
      sessionToken: 'previous-session', time: 1, status: 'applied', note: '' }
  ], null, 1)}\n`, { mode: 0o600 })
}

const readState = (root: string): { state?: string; code?: string; message?: string } | undefined => {
  try { return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) } catch { return undefined }
}

interface HarnessOptions {
  residentAlive?: boolean
  residentArmed?: boolean
  restoreDeadlineMs?: number
}

function makeHarness(options: HarnessOptions = {}) {
  const root = directory()
  const restoreChildren: RestoreChildControl[] = []
  const supervisor = new DaemonSupervisor({
    dataDir: root,
    spawnDaemon: () => makeRestoreChild().child as never,
    spawnRestore: () => {
      const made = makeRestoreChild()
      restoreChildren.push(made)
      return made.child as never
    },
    // 常驻接线:席位上有活人(硬重启后被计划任务拉起的守护)。
    resident: { armed: () => options.residentArmed ?? true, wake: async () => true, alive: () => options.residentAlive ?? true },
    ...(options.restoreDeadlineMs !== undefined ? { restoreDeadlineMs: options.restoreDeadlineMs } : {})
  })
  return { root, supervisor, restoreChildren }
}

it('席上有自家常驻守护时,recoverOnBoot ⛔ 另派竞速恢复子进程(基线:派了,0 秒抢写权失败即退,账本永远没机会结算)', () => {
  const h = makeHarness({ residentAlive: true })
  seedInterruptedLedger(h.root)
  expect(h.supervisor.isRunning()).toBe(true)
  h.supervisor.recoverOnBoot()
  expect(h.restoreChildren).toHaveLength(0) // 基线在这是 1:竞速子进程被派出
})

it('恢复子进程 spawn 失败:状态落 TUNNEL_RESTORE_SPAWN_FAILED、restoring 可清、等待者拿到 false(基线:done(null) 静默吞掉,不写任何状态)', async () => {
  const h = makeHarness({ residentAlive: false, restoreDeadlineMs: 5_000 })
  seedInterruptedLedger(h.root)
  h.supervisor.recoverOnBoot()
  expect(h.restoreChildren).toHaveLength(1)
  h.restoreChildren[0].fail()
  await waitFor(() => !h.supervisor.isRestoring(), 2_000)
  const state = readState(h.root)
  expect(state?.state).toBe('error')
  expect(state?.code).toBe('TUNNEL_RESTORE_SPAWN_FAILED')
  expect(typeof state?.message).toBe('string')
  expect((state?.message ?? '').length).toBeGreaterThan(0)
})

it('恢复子进程楔死:deadline 到点被杀、状态落 TUNNEL_RESTORE_TIMEOUT(基线:无 deadline、无杀死路径,restoring 永置位)', async () => {
  const h = makeHarness({ residentAlive: false, restoreDeadlineMs: 60 })
  seedInterruptedLedger(h.root)
  h.supervisor.recoverOnBoot()
  const child = h.restoreChildren[0]
  // 基线在这里永远等不到:waitFor 超时抛错即红
  await waitFor(() => !h.supervisor.isRestoring(), 2_000)
  expect(child.killCalls.length).toBeGreaterThan(0)
  const state = readState(h.root)
  expect(state?.state).toBe('error')
  expect(state?.code).toBe('TUNNEL_RESTORE_TIMEOUT')
})

it('deadline 杀死时席上有活守护:⛔ 盖掉守护写下的状态(恢复结论归席位守护,界面从账本与修复流程拿结论)', async () => {
  const h = makeHarness({ residentAlive: true, restoreDeadlineMs: 40 })
  // 守护在席且活着:recoverOnBoot 本来就不派子进程——这里直接走 watchRestore 的路径靠 runRecoveryOnce 触发不了,
  // 用「席位刚空出来前的窗口」形状:守护在但账本待结算,手动派发(surrenderAndRestore 同路)。
  seedInterruptedLedger(h.root)
  writeFileSync(join(h.root, 'state.json'), `${JSON.stringify({ state: 'connected', code: '', message: '', updatedAt: Date.now() })}\n`, { mode: 0o600 })
  // 直接收尾:让 supervisor 派一个子进程(spawnRestore 走内部路径),此时守护恰好又在席(竞速窗口):
  const control = makeRestoreChild()
  const privateWatch = (h.supervisor as unknown as { watchRestore: (child: unknown) => void }).watchRestore.bind(h.supervisor)
  privateWatch(control.child)
  await waitFor(() => !h.supervisor.isRestoring(), 2_000)
  expect(control.killCalls.length).toBeGreaterThan(0)
  // 状态文件没有被一次性恢复的失败结论覆盖
  expect(readState(h.root)?.state).toBe('connected')
  expect(readState(h.root)?.code).toBe('')
})

it('三类恢复失败码对客户说人话(connectionMessage 映射)且进 FB-1 白名单(⛔ 归 UNKNOWN)', async () => {
  for (const code of ['TUNNEL_RESTORE_TIMEOUT', 'TUNNEL_RESTORE_SPAWN_FAILED']) {
    expect(KNOWN_FAILURE_CODES.has(code), `${code} 应进 KNOWN_FAILURE_CODES(FB-1 白名单)`).toBe(true)
    const text = connectionMessage({ state: 'error', code, message: code })
    expect(text).not.toBe(code)
    expect(text.length).toBeGreaterThan(6)
  }
  // 写权被占码文案依旧在(回归护栏)
  expect(connectionMessage({ state: 'error', code: 'TUNNEL_WRITE_RIGHT_HELD', message: 'TUNNEL_WRITE_RIGHT_HELD' })).toContain('另一')
})

it('恢复状态写盘只在数据目录确实没有守护在跑时发生(护栏:席位空、state 是旧轮陈货)', async () => {
  const h = makeHarness({ residentAlive: false, restoreDeadlineMs: 40 })
  seedInterruptedLedger(h.root)
  h.supervisor.recoverOnBoot()
  await waitFor(() => !h.supervisor.isRestoring(), 2_000)
  expect(readState(h.root)?.code).toBe('TUNNEL_RESTORE_TIMEOUT')
  expect(existsSync(join(h.root, 'state.json'))).toBe(true)
  expect(readDaemonState(h.root)?.code).toBe('TUNNEL_RESTORE_TIMEOUT')
})
