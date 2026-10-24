// 第 1 条故障注入:锁判活只做 kill(pid,0),同一次开机内的 PID 复用直接骗过它。
//
// 客户剧本:常驻守护崩溃 → daemon.lock 残留 → 该 PID 被系统复用给任意无关进程 →
// 基线把「无关进程活着」当成「守护在席」:isRunning() 恒真、界面显示已连、新守护静默让位,
// 系统自愈被击穿。修复后:锁里记着持有者自己的启动时刻,判活时与该 PID 现在的启动时刻对账,
// 「同一个号码、不是同一个人」当场现形。
//
// 正向证据纪律:每个「活但不是守护」用例都先证明被顶 PID 确实活着、且确实诞生于本次开机;
// 每套锁都配「身份对得上必须判活」的反向护栏,防「一律判死」式假修复。
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireInstanceLock,
  instanceLockPath,
  readInstanceLock
} from '../../sidecar/win/instance-lock.mjs'
import {
  processAlive,
  readSettingsLock,
  settingsLockPath,
  withSettingsLock,
  SettingsBusyError
} from '../../sidecar/win/ledger.mjs'
import { makeResidentRuntime } from '../../app/main/tunnel/resident-bridge'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
  roots.splice(0).forEach(removeTempDir)
})

const directory = () => { const root = makeTempDir('lock-identity-'); roots.push(root); return root }

// 一个与本实现无关的探子:用 ps lstart 文本手工解析出真实启动时刻(实现走 etime 秒数回推,两者机制不同)。
// ⛔ 必须强制 LC_ALL=C:zh_CN 等 locale 下 lstart 输出「三 9月/16 08:12:16 2026」(4 段中文),解析必然失败。
// ⛔ 也不许改用 etime——那是生产实现的同款机制,探子就失去独立性了。
const LSTART_MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
function independentStartedAt(pid: number): number | undefined {
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (probe.status !== 0) return undefined
  const fields = probe.stdout.trim().split(/\s+/)
  // 形如:Wed Sep 16 07:07:02 2026(周 月 日 时刻 年,共 5 段)
  if (fields.length !== 5) return undefined
  const [week, month, day, clock, year] = fields
  if (week === undefined || !(month in LSTART_MONTHS) || year === undefined) return undefined
  const [hh, mm, ss] = clock.split(':').map((part) => Number(part))
  const parsed = new Date(Number(year), LSTART_MONTHS[month], Number(day), hh, mm, ss)
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : undefined
}

async function eventuallyStartedAt(pid: number): Promise<number> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const startedAt = independentStartedAt(pid)
    if (startedAt !== undefined) return startedAt
    if (Date.now() > deadline) throw new Error(`ps 迟迟看不到 pid ${String(pid)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// 活着但与守护无关的进程:就是「顶了 PID 的那个路人」。
function liveBystander(): { pid: number } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' })
  children.push(child)
  if (child.pid === undefined) throw new Error('子进程没有 pid')
  return { pid: child.pid }
}

/** 前提校验(正向证据):这个 pid 活着、诞生于本次开机 —— 「同一次开机内的复用」场景成立。 */
async function assertSameBootLiveBystander(child: { pid: number }) {
  const startedAt = await eventuallyStartedAt(child.pid)
  expect(processAlive(child.pid)).toBe(true)
  expect(Date.now() - startedAt).toBeLessThan(uptime() * 1_000)
  return startedAt
}

function writeGhostLock(path: string, holder: Record<string, unknown>) {
  writeFileSync(path, JSON.stringify(holder), { flag: 'wx', mode: 0o600 })
}

describe('daemon.lock:持有者身份对账', () => {
  it('同一次开机内 PID 被无关进程顶用 → 必须判死并让新守护接手(基线:误判在席)', async () => {
    const root = directory()
    const bystander = liveBystander()
    const bystanderStartedAt = await assertSameBootLiveBystander(bystander)
    // 崩溃守护留下的席位:pid 是路人的,但启动时刻是十来分钟前死掉的那个守护的
    writeGhostLock(instanceLockPath(root), {
      token: 'ghost-daemon-1', pid: bystander.pid, runId: 'crashed', at: Date.now() - 600_000,
      startedAt: bystanderStartedAt - 600_000
    })
    const seat = acquireInstanceLock(root, { runId: 'new-daemon' })
    expect(seat.acquired).toBe(true)
    const current = readInstanceLock(root)?.holder
    expect(current?.pid).toBe(process.pid)
    expect(current?.runId).toBe('new-daemon')
    if (seat.acquired) seat.release()
  })

  it('旧格式锁(无 startedAt)但时刻早于本次开机 → 跨开机遗留,必须接手', () => {
    const root = directory()
    const bystander = liveBystander()
    expect(processAlive(bystander.pid)).toBe(true)
    // 十年前的锁:无论 pid 落在谁头上,这都是上次开机的遗留
    writeGhostLock(instanceLockPath(root), {
      token: 'ghost-daemon-2', pid: bystander.pid, runId: 'crashed', at: Date.now() - 10 * 365 * 86_400_000
    })
    const seat = acquireInstanceLock(root, { runId: 'new-daemon' })
    expect(seat.acquired).toBe(true)
    if (seat.acquired) seat.release()
  })

  it('持有者确实是活守护(启动时刻对得上)→ 必须判活、⛔ 被接走(防一律判死)', async () => {
    const root = directory()
    const holder = liveBystander()
    const holderStartedAt = await assertSameBootLiveBystander(holder)
    writeGhostLock(instanceLockPath(root), {
      token: 'real-daemon-1', pid: holder.pid, runId: 'resident', at: Date.now(),
      startedAt: holderStartedAt
    })
    const seat = acquireInstanceLock(root, { runId: 'newcomer' })
    expect(seat.acquired).toBe(false)
    expect((seat as { holder?: { pid?: number } }).holder?.pid).toBe(holder.pid)
    expect(readInstanceLock(root)?.holder?.token).toBe('real-daemon-1')
  })

  it('新写的席位必须带 startedAt,且与本进程真实启动时刻一致(独立探子对账)', () => {
    const root = directory()
    const seat = acquireInstanceLock(root, { runId: 'a' })
    expect(seat.acquired).toBe(true)
    // mjs 推断类型不含运行时新字段,测试侧显式收窄(写路径确实带 startedAt)
    const holder = readInstanceLock(root)?.holder as { token?: string; pid?: number; runId?: string; at?: number; startedAt?: number } | undefined
    expect(Number.isFinite(holder?.startedAt)).toBe(true)
    // 对账对象是「本进程的真实启动时刻」(独立探子取 ps lstart,与实现的 uptime 回推不同机制),
    // 容差同生产判活的 2.5 秒。⛔ 拿 startedAt 减 Date.now()——那是「测试进程跑了多久」,跑慢必红。
    const ownStartedAt = independentStartedAt(process.pid)
    expect(ownStartedAt).toBeDefined()
    expect(Math.abs((holder?.startedAt as number) - (ownStartedAt as number))).toBeLessThanOrEqual(2_500)
    if (seat.acquired) seat.release()
  })
})

describe('settings.lock:持有者身份对账', () => {
  it('活着的无关进程顶了设置锁 → 必须按遗留锁接管,⛔ 干等 20 秒', async () => {
    const root = directory()
    const bystander = liveBystander()
    const bystanderStartedAt = await assertSameBootLiveBystander(bystander)
    writeGhostLock(settingsLockPath(root), {
      token: 'ghost-settings-1', pid: bystander.pid, owner: 'dead-restorer', at: Date.now() - 600_000,
      startedAt: bystanderStartedAt - 600_000
    })
    let ranInside = false
    withSettingsLock(root, () => { ranInside = true }, { owner: 't', timeoutMs: 3_000 })
    expect(ranInside).toBe(true)
    // 走到这儿 = 遗留锁被接管、临界区执行、锁已正常释放;幽灵锁已不在
    expect(readSettingsLock(root)).toBeUndefined()
  })

  it('旧格式设置锁早于本次开机 → 接管,不空等', () => {
    const root = directory()
    const bystander = liveBystander()
    expect(processAlive(bystander.pid)).toBe(true)
    writeGhostLock(settingsLockPath(root), {
      token: 'ghost-settings-2', pid: bystander.pid, owner: 'last-boot', at: Date.now() - 10 * 365 * 86_400_000
    })
    let ranInside = false
    withSettingsLock(root, () => { ranInside = true }, { owner: 't', timeoutMs: 3_000 })
    expect(ranInside).toBe(true)
  })

  it('设置锁持有者确实是活的且身份对得上 → 忙拒绝,⛔ 被抢(防一律接管)', async () => {
    const root = directory()
    const holder = liveBystander()
    const holderStartedAt = await assertSameBootLiveBystander(holder)
    writeGhostLock(settingsLockPath(root), {
      token: 'real-settings-1', pid: holder.pid, owner: 'live-restorer', at: Date.now(),
      startedAt: holderStartedAt
    })
    expect(() => withSettingsLock(root, () => undefined, { owner: 't', timeoutMs: 1_500 })).toThrow(SettingsBusyError)
    expect(readSettingsLock(root)?.holder?.token).toBe('real-settings-1')
  })
})

describe('主进程侧 resident.bridge.alive():同一判据', () => {
  it('席位锁是路人顶用 → alive 为假(基线:为真,状态层放行陈旧 connected)', async () => {
    const root = directory()
    const bystander = liveBystander()
    const bystanderStartedAt = await assertSameBootLiveBystander(bystander)
    writeGhostLock(instanceLockPath(root), {
      token: 'ghost-daemon-3', pid: bystander.pid, runId: 'crashed', at: Date.now() - 600_000,
      startedAt: bystanderStartedAt - 600_000
    })
    const runtime = makeResidentRuntime({
      dataDir: root, platform: 'macos', supported: true,
      spec: () => ({ executable: '/bin/echo', args: [], env: {}, logDir: join(tmpdir(), 'lock-identity-logs') }),
      probeInstalled: () => true
    })
    expect(runtime.bridge.alive()).toBe(false)
  })

  it('席位锁是活守护且身份对得上 → alive 为真(正向护栏)', async () => {
    const root = directory()
    const holder = liveBystander()
    const holderStartedAt = await assertSameBootLiveBystander(holder)
    writeGhostLock(instanceLockPath(root), {
      token: 'real-daemon-2', pid: holder.pid, runId: 'resident', at: Date.now(),
      startedAt: holderStartedAt
    })
    const runtime = makeResidentRuntime({
      dataDir: root, platform: 'macos', supported: true,
      spec: () => ({ executable: '/bin/echo', args: [], env: {}, logDir: join(tmpdir(), 'lock-identity-logs') }),
      probeInstalled: () => true
    })
    expect(runtime.bridge.alive()).toBe(true)
  })
})
