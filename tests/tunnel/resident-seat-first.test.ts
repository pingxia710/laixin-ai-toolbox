// N-23 开机编排(Windows 真机形状):连接中被硬重启 → 每分钟计划任务把常驻守护一遍遍拉起。
// 席位已被占时,重入的那份要在**装适配器、读账本之前**就退出——
// 基线:先读账本(损坏账本当场被隔离重命名、跑一轮恢复)才发现席位有人,白做一轮还要写盘,
// 每分钟一次的空转在恢复楔死期间反复发生。先查后拿:让位路径零账本操作。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { acquireInstanceLock } from '../../sidecar/shared/instance-lock.mjs'
import { fakeAdapterEnv, makeTempDir, waitFor } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function launchResidentStart(dataDir: string, storePath: string): ReturnType<typeof spawn> {
  const daemonPath = fileURLToPath(new URL('../../sidecar/mac/tunnel-daemon.mjs', import.meta.url))
  const adapterPath = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
  return spawn(process.execPath, [daemonPath, 'start', '--data-dir', dataDir, '--resident', '1', '--adapter', adapterPath],
    { env: { ...process.env, ...fakeAdapterEnv(storePath) }, stdio: ['ignore', 'ignore', 'pipe'] })
}

it('常驻 start 撞席位:装适配器/读账本之前就让位退出,损坏账本原样留着给席位守护处理(基线:先隔离重命名再让位)', async () => {
  const root = makeTempDir('n23-seat-first-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'ledger.json'), 'THIS IS NOT JSON\n', { mode: 0o600 })
  // 测试进程先占席位:形状=常驻守护正在跑(硬重启后计划任务拉起的那份)
  const seat = acquireInstanceLock(dataDir, { runId: 'n23-seat-holder' })
  expect(seat.acquired).toBe(true)
  cleanups.push(() => { try { if (seat.acquired) seat.release() } catch { /* 数据目录随清理删除 */ } })

  let stderr = ''
  const child = launchResidentStart(dataDir, storePath)
  child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', (exitCode) => resolve(exitCode))
    child.once('error', reject)
  })
  expect(code).toBe(0) // 让位=安静退出 0(⛔ 非零被计划任务反复拉起)
  expect(stderr).toContain('让位')
  // 损坏账本没被本进程隔离:没有 .bad-* 副本、没有恢复标记(基线在这里已 rename + 留标记)
  const badFiles = existsSync(dataDir) ? readdirSync(dataDir).filter((name) => name.startsWith('ledger.json.bad-')) : []
  expect(badFiles).toEqual([])
  expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
}, 20_000)

it('席位空着时,常驻 start 照常接管损坏账本恢复流程(护栏:先查后拿没有砍掉恢复责任)', async () => {
  const root = makeTempDir('n23-seat-first-takeover-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'device'); const storePath = join(root, 'fake-system.json')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'ledger.json'), 'THIS IS NOT JSON\n', { mode: 0o600 })
  const child = launchResidentStart(dataDir, storePath)
  child.stderr?.resume()
  // 损坏账本恢复成功 → 守护继续跑:state.json 落地即视为接管成功,随后收进程
  await waitFor(() => existsSync(join(dataDir, 'state.json')), 15_000)
  child.kill('SIGTERM')
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5_000).catch(() => child.kill('SIGKILL'))
  const badFiles = existsSync(dataDir) ? readdirSync(dataDir).filter((name) => name.startsWith('ledger.json.bad-')) : []
  expect(badFiles.length).toBe(1) // 隔离留证仍发生
  expect(existsSync(join(dataDir, 'state.json'))).toBe(true)
}, 25_000)
