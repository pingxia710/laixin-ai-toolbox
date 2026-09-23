// 第 2 条故障注入:mac 关「后台保持连接」= launchctl bootout = 给在跑守护发 SIGTERM = 当场掐断客户连接。
// supervisor.ts:120 与本目录 platform/resident.ts:325 都白纸黑字承诺「卸常驻 ⛔ 动当前连接」,实现违背了它。
//
// 本机实证(2026-09-16,macOS):launchctl disable 挡不住已加载任务的 KeepAlive 重拉
// (disable + kill -9 后 3 秒内 launchd 换 pid 拉回),「disable+删 plist」不成立;
// 成立的语义是 KeepAlive.SuccessfulExit=false——守护正常退出(0)不拉、被杀才拉。
// 所以关开关 = 只删 plist(解除开机自启),在跑实例活到客户自己点断开/退出/重启。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 进程内假 launchctl/powershell:记录所有调用,launchctl print 按 control.loaded 应答。
// homedir 指到临时目录,⛔ 碰真实 ~/Library/LaunchAgents。
const control = vi.hoisted(() => ({
  home: '',
  calls: [] as Array<{ file: string; args: string[] }>,
  loaded: true
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, homedir: () => control.home }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const fakeExecFile = (file: string, args: string[], options?: unknown, maybeCallback?: unknown) => {
    control.calls.push({ file, args: args as string[] })
    const callback = (typeof options === 'function' ? options : maybeCallback) as
      ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const stdout = file === 'launchctl' && (args as string[])[0] === 'print' && control.loaded ? 'loaded\n' : ''
    queueMicrotask(() => callback?.(null, stdout, ''))
    return { unref() { /* 无进程可等 */ } }
  }
  return { ...actual, execFile: fakeExecFile }
})

import {
  RESIDENT_LABEL,
  installMacResident,
  uninstallMacResident,
  uninstallResident,
  uninstallWinResident
} from '../../app/main/tunnel/platform/resident'
import { makeResidentRuntime } from '../../app/main/tunnel/resident-bridge'
import { systemResidentController } from '../../app/main/desktop/resident-preference'
import { acquireInstanceLock } from '../../sidecar/win/instance-lock.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach(removeTempDir)
  control.calls.length = 0
  control.loaded = true
})

const plistPath = () => join(control.home, 'Library', 'LaunchAgents', `${RESIDENT_LABEL}.plist`)
function writePlist(): void {
  mkdirSync(join(control.home, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plistPath(), '<plist>旧内容</plist>')
}
const bootoutCalls = () => control.calls.filter((call) => call.file === 'launchctl' && call.args[0] === 'bootout')
const bootstrapCalls = () => control.calls.filter((call) => call.file === 'launchctl' && call.args[0] === 'bootstrap')

const spec = {
  executable: '/Applications/来信AI工具箱.app/Contents/MacOS/来信AI工具箱',
  args: ['daemon.mjs', 'start', '--resident', '1'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  logDir: '/tmp/laixin-fix2-logs'
}

describe('uninstallMacResident:关开关不许踢在跑实例', () => {
  it('leaveRunningInstance:只删描述文件,⛔ 出现任何 bootout(基线:bootout 把 SIGTERM 发给守护)', async () => {
    writePlist()
    await uninstallMacResident(RESIDENT_LABEL, { leaveRunningInstance: true })
    expect(bootoutCalls()).toEqual([])
    expect(existsSync(plistPath())).toBe(false)
  })

  it('默认(守护已死/应用卸载)仍是硬卸载:bootout + 删描述文件(护栏,基线即绿)', async () => {
    writePlist()
    await uninstallMacResident()
    expect(bootoutCalls().length).toBe(1)
    expect(existsSync(plistPath())).toBe(false)
  })
})

describe('installMacResident:在跑实例不许为了换描述文件被踢下线', () => {
  it('已加载 + leaveRunningInstance:只把新描述文件写好,⛔ bootout/bootstrap(基线:先卸再装踢掉守护)', async () => {
    control.loaded = true
    writePlist()
    await installMacResident(spec, RESIDENT_LABEL, { leaveRunningInstance: true })
    expect(bootoutCalls()).toEqual([])
    expect(bootstrapCalls()).toEqual([])
    // 正向证据:描述文件确实换成了新内容,下次登录加载的就是它
    const written = await import('node:fs')
    expect(written.readFileSync(plistPath(), 'utf8')).toContain('--resident')
  })

  it('已加载但守护已死(leaveRunningInstance:false):照旧换装,新定义当场生效(护栏,基线即绿)', async () => {
    control.loaded = true
    writePlist()
    await installMacResident(spec, RESIDENT_LABEL, { leaveRunningInstance: false })
    expect(bootoutCalls().length).toBe(1)
    expect(bootstrapCalls().length).toBe(1)
  })
})

describe('calibrate:用身份判活决定软硬,⛔ 拍脑袋', () => {
  it('席位上是活守护 → calibrate(false)/(true) 都走 leaveRunningInstance:true(基线:不传,无脑硬卸)', async () => {
    const root = makeTempDir('fix2-calibrate-')
    roots.push(root)
    // 真实活进程占席位,锁里写对启动时刻 → bridge.alive() 为真(正向证据)
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' })
    if (child.pid === undefined) throw new Error('子进程没有 pid')
    try {
      const probe = await (async () => {
        for (let waited = 0; waited < 5_000; waited += 50) {
          // ⛔ 强制 LC_ALL=C:zh_CN 下 lstart 输出中文 4 段,下面的英文月份解析必然失败
          const attempt = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)],
            { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
          if (attempt.status === 0) return attempt
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('ps 迟迟看不到占席进程')
      })()
      const [, month, day, clock, year] = probe.stdout.trim().split(/\s+/)
      const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
      const [hh, mm, ss] = clock.split(':').map(Number)
      const startedAt = new Date(Number(year), months[month], Number(day), hh, mm, ss).getTime()
      acquireInstanceLock(root, { runId: 'resident-daemon' })
      // 重写锁:pid=活进程、startedAt=它的真实启动时刻(acquire 写的是本测试进程自己的,这里换成守护的)
      rmSync(join(root, 'daemon.lock'))
      writeFileSync(join(root, 'daemon.lock'), JSON.stringify({
        token: 'real-daemon', pid: child.pid, runId: 'resident', at: Date.now(), startedAt
      }))

      const uninstallCalls: Array<{ platform: string; options?: { leaveRunningInstance?: boolean } }> = []
      const installCalls: Array<{ spec: unknown; platform: string; options?: { leaveRunningInstance?: boolean } }> = []
      const runtime = makeResidentRuntime({
        dataDir: root, platform: 'macos', supported: true, spec: () => spec,
        probeInstalled: () => true,
        uninstall: async (platform, options) => { uninstallCalls.push({ platform, options }) },
        install: async (received, platform, options) => {
          installCalls.push({ spec: received, platform, options })
          return { installed: true }
        }
      })
      expect(runtime.bridge.alive()).toBe(true)
      await runtime.calibrate(false)
      await runtime.calibrate(true)
      expect(uninstallCalls[0]?.options?.leaveRunningInstance).toBe(true)
      expect(installCalls[0]?.options?.leaveRunningInstance).toBe(true)
    } finally {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
  })

  it('席位上没有活守护 → calibrate(false) 如实传硬卸载决定(连闲置的已加载任务一起清掉);「按判活传参」是新增行为,基线必红', async () => {
    const root = makeTempDir('fix2-calibrate-dead-')
    roots.push(root)
    const uninstallCalls: Array<{ platform: string; options?: { leaveRunningInstance?: boolean } }> = []
    const runtime = makeResidentRuntime({
      dataDir: root, platform: 'macos', supported: true, spec: () => spec,
      probeInstalled: () => true,
      uninstall: async (platform, options) => { uninstallCalls.push({ platform, options }) }
    })
    await runtime.calibrate(false)
    expect(runtime.bridge.alive()).toBe(false)
    expect(uninstallCalls[0]?.options?.leaveRunningInstance).toBe(false)
  })
})

describe('两端行为一致 + 开关确认判据', () => {
  it('Windows 卸载只删任务,⛔ taskkill/Stop-ScheduledTask 之类终止在跑实例(护栏,基线即绿)', async () => {
    await uninstallWinResident()
    const killers = control.calls.filter((call) =>
      /taskkill/i.test(call.file) || call.args.some((argument) => /Stop-ScheduledTask/i.test(String(argument))))
    expect(killers).toEqual([])
    expect(control.calls.some((call) => call.file === 'schtasks.exe')).toBe(true)
  })

  it('mac 开关的卸载确认看「下次登录会不会回来」:plist 没了就算卸掉,已加载残余活到本轮结束(基线:判成没卸干净)', async () => {
    control.loaded = true
    // soft 卸载后:plist 没了,任务还加载着(在跑实例),开关必须判「卸干净了」
    const controller = systemResidentController('darwin')
    await controller.uninstall()
    expect(existsSync(plistPath())).toBe(false)
    expect(await controller.installed()).toBe(false)
  })

  it('平台分发把选项带到 mac 实现(leaveRunningInstance 是新增参数,基线必红)', async () => {
    writePlist()
    await uninstallResident('darwin', { leaveRunningInstance: true })
    expect(bootoutCalls()).toEqual([])
    expect(existsSync(plistPath())).toBe(false)
  })
})
