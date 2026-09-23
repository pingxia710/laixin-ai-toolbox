// N-21:开机后点连接,别永远卡在「正在接续」。
// resident.ts 的子进程调用(launchctl/schtasks/powershell)原先全部没传超时(只有 PowerShell 三处有
// 30s/20s 纪律):Task Scheduler 服务卡住(系统更新后常见)或 launchd 卡住时,校准 Promise 永不落定,
// 击穿校准闸门「任何校准结果都不能让接续永远等下去」(calibration-gate.ts 自证承诺)——开机接续和
// 等待期手动连接全部永远等。三条钉死:
//  1) 注入永不退出的 run():开机校准仍须落定,onCalibrated(markCalibrated)照打——去掉 finally 里的
//     落定回调(反向变异②)这条红;
//  2) 全部 run() 调用点都带超时:子进程永不退出时每个导出流程都落定,且装/叫醒失败带「超时」原因
//     ——去掉超时(反向变异①)这条红;
//  3) 校准串行:开机自动校准进行中拨开关,两次校准不交错,终态与最后一次一致。
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 进程内假 launchctl/schtasks/powershell:hang=true 时子进程永不退出(复现服务卡死);
// homedir 指到临时目录,⛔ 碰真实 ~/Library/LaunchAgents。
const control = vi.hoisted(() => ({
  home: '',
  hang: false
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, homedir: () => control.home }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const { promisify } = await import('node:util')
  // hang 时永不回调(子进程卡死);resident.ts 走 promisify(execFile):假桩必须带上 node 自己那个
  // custom promisify(解构 { stdout, stderr }),⛔ 靠泛型 promisify——它会把 (err, stdout, stderr) 摊成数组。
  const runFake = () => new Promise<{ stdout: string; stderr: string }>(() => { /* 卡死,永不落定 */ })
  const callbackFake = (_file: string, _args: string[], options?: unknown, maybeCallback?: unknown) => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as
      ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    if (!control.hang) callback?.(null, '', '')
    return { unref() { /* 无进程可等 */ } }
  }
  const fakeExecFile = Object.assign(callbackFake, { [promisify.custom]: runFake })
  return { ...actual, execFile: fakeExecFile }
})

import {
  RESIDENT_LABEL, installMacResident, installWinResident, macResidentLoaded, uninstallMacResident,
  uninstallWinResident, wakeMacResident, wakeWinResident, winResidentArmed, winResidentResidue
} from '../../app/main/tunnel/platform/resident'
import { makeResidentRuntime, residentSpecFor } from '../../app/main/tunnel/resident-bridge'
import { makeTempDir } from './helpers'

// env 用两个字段代表「launch.env 原样透传」,⛔ 把真实放行钥匙抄进来(同 resident-wiring.test)。
const launch = { daemonPath: '/app/sidecar/tunnel-daemon.mjs', adapterPath: '/app/sidecar/managed-adapter.mjs', env: { TOOLBOX_FAKE_GUARD_KEY: '1', ELECTRON_RUN_AS_NODE: '1' } }

const roots: string[] = []
const tempRoot = (label: string): string => { const dir = makeTempDir(`n21-${label}-`); roots.push(dir); return dir }
afterEach(() => {
  vi.useRealTimers()
  control.hang = false
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  control.home = ''
})

/** 子进程卡死时,流程必须在有限时间(假时钟 ms)内落定。没落定 = run() 没带超时 = N-21 的病根本身。 */
async function settlesWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let done = false
  const watched = p.then((value) => { done = true; return value }, () => { done = true; return undefined as unknown as T })
  await Promise.race([watched, vi.advanceTimersByTimeAsync(ms)])
  if (!done) throw new Error(`${label}:子进程永不退出时流程在 ${ms}ms(假时钟)内未落定——run() 没带超时(N-21)`)
  return await watched
}

describe('N-21 子进程卡死时校准必落定', () => {
  it('开机校准遇上永不退出的 launchctl:校准落定为「装不上」、闸门回调照打(未修代码上:永远不落定)', async () => {
    const home = tempRoot('boot')
    control.home = home
    control.hang = true
    vi.useFakeTimers()
    let fired = 0
    const dataDir = tempRoot('boot-data')
    const runtime = makeResidentRuntime({
      dataDir,
      platform: 'macos',
      supported: true,
      probeInstalled: () => false,
      spec: () => residentSpecFor({ executable: '/工具箱', launch, dataDir, logDir: join(home, 'logs') }),
      onCalibrated: () => { fired += 1 }
    })
    // 落定(任何结果)都算数;「hung」= 校准 Promise 永不落定 = 客户永远卡「正在接续」。
    const settled = runtime.calibrate(true).then(() => 'settled' as const, () => 'settled' as const)
    const verdict = await Promise.race([
      settled,
      vi.advanceTimersByTimeAsync(120_000).then(() => 'hung' as const)
    ])
    expect(verdict).toBe('settled')
    await expect(settled).resolves.toBe('settled')
    // 落定走的是「装不上」这个真实结果(装失败原因进日志与诊断),armed 照实答「不在」——
    // 主进程回落到自己 spawn 老路,客户几十秒内拿到可连网的结果,⛔ 假装装上。
    expect(runtime.bridge.armed()).toBe(false)
    // 闸门收到落定时机(markCalibrated):被推迟的开机接续靠它补做。
    // 去掉 calibrate finally 里的 onCalibrated(反向变异②)——装失败不抛错,只有 finally 会打它,这条必红。
    expect(fired).toBe(1)
  })

  it('resident 全部子进程调用都带超时:每个导出流程在永不退出的子进程上都落定,失败带「超时」原因', async () => {
    const home = tempRoot('sweep')
    control.home = home
    control.hang = true
    vi.useFakeTimers()
    const logDir = join(home, 'logs')
    const spec = { executable: '/工具箱', args: ['daemon.mjs', 'start', '--resident', '1'], env: { ELECTRON_RUN_AS_NODE: '1' }, logDir }

    // mac 装链:print → bootout → bootstrap 三次卡死调用,每个都各自有闸,链在有限假时钟内走完
    const macInstall = await settlesWithin(installMacResident({ ...spec }, RESIDENT_LABEL), 120_000, 'installMacResident')
    expect(macInstall.installed).toBe(false)
    expect(macInstall.reason ?? '').toMatch(/超时/)
    expect(await settlesWithin(macResidentLoaded(), 40_000, 'macResidentLoaded')).toBe(false)
    expect(await settlesWithin(uninstallMacResident(), 40_000, 'uninstallMacResident')).toBeUndefined()
    const macWake = await settlesWithin(wakeMacResident(), 40_000, 'wakeMacResident')
    expect(macWake.woken).toBe(false)
    expect(macWake.reason ?? '').toMatch(/超时/)

    // Windows 侧(真机格另列,这里只验「调用带闸、卡死必落定」,不起真 schtasks——execFile 已是假桩)
    const winInstall = await settlesWithin(installWinResident({ ...spec }), 90_000, 'installWinResident')
    expect(winInstall.installed).toBe(false)
    expect(winInstall.reason ?? '').toMatch(/超时/)
    expect(await settlesWithin(winResidentArmed(), 40_000, 'winResidentArmed')).toBe(false)
    expect(await settlesWithin(winResidentResidue(), 60_000, 'winResidentResidue')).toBe(false)
    expect(await settlesWithin(uninstallWinResident(), 60_000, 'uninstallWinResident')).toBeUndefined()
    const winWake = await settlesWithin(wakeWinResident(), 60_000, 'wakeWinResident')
    expect(winWake.woken).toBe(false)
    expect(winWake.reason ?? '').toMatch(/超时/)
  })
})

describe('N-21 校准串行:开机校准进行中拨开关不交错', () => {
  it('前一次校准落定前,后一次不开跑;终态与最后一次一致', async () => {
    const home = tempRoot('serialize')
    control.home = home
    const dataDir = tempRoot('serialize-data')
    const calls: string[] = []
    let releaseFirst: (outcome: { installed: boolean }) => void = () => {}
    const firstSettles = new Promise<{ installed: boolean }>((resolve) => { releaseFirst = resolve })
    const runtime = makeResidentRuntime({
      dataDir,
      platform: 'macos',
      supported: true,
      probeInstalled: () => false,
      spec: () => residentSpecFor({ executable: '/工具箱', launch, dataDir, logDir: join(home, 'logs') }),
      install: async () => {
        calls.push('install')
        return await firstSettles
      },
      uninstall: async () => { calls.push('uninstall') }
    })
    // 开机自动校准先到(装操作挂着不落定,模拟 launchctl 卡住或慢),客户此刻拨开关(关):
    const boot = runtime.calibrate(true)
    const toggle = runtime.calibrate(false)
    // 放几轮微任务:未修代码(直通无锁)里第二次校准立刻开跑,uninstall 会插进 install 落定之前。
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls).toEqual(['install'])
    releaseFirst({ installed: true })
    await expect(boot).resolves.toEqual({ installed: true })
    await expect(toggle).resolves.toEqual({ installed: false })
    expect(calls).toEqual(['install', 'uninstall'])
    expect(runtime.bridge.armed()).toBe(false)
  })

  it('前一次校准抛错也放行后一次:串行闸不能变成死锁闸', async () => {
    const home = tempRoot('serialize-throw')
    control.home = home
    const dataDir = tempRoot('serialize-throw-data')
    const calls: string[] = []
    let rejectFirst: (error: Error) => void = () => {}
    const firstFails = new Promise<never>((_, reject) => { rejectFirst = reject })
    const runtime = makeResidentRuntime({
      dataDir,
      platform: 'macos',
      supported: true,
      probeInstalled: () => false,
      spec: () => residentSpecFor({ executable: '/工具箱', launch, dataDir, logDir: join(home, 'logs') }),
      install: async () => {
        calls.push('install')
        return await firstFails
      },
      uninstall: async () => { calls.push('uninstall') }
    })
    const boot = runtime.calibrate(true)
    const toggle = runtime.calibrate(false)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls).toEqual(['install'])
    rejectFirst(new Error('目录不可写'))
    await expect(boot).rejects.toThrow('目录不可写')
    await expect(toggle).resolves.toEqual({ installed: false })
    expect(calls).toEqual(['install', 'uninstall'])
  })
})
