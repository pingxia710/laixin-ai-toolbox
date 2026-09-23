// 甲-10 返工(2026-09-17 验收):管理员令牌注册过的常驻任务,普通权限覆盖注册一律
// 「拒绝访问 0x80070005」(COM 与 schtasks CLI 建的都一样,真机对照 j10-P)——0.5.0 起发布版都用
// 这个接口装任务,客户以管理员跑一次工具箱就会进入这个状态。普通权限对它:读定义 ✅、查状态 ✅、
// schtasks /run ✅;停用/删除/覆盖 ❌(真机 D 表)。
//  · 定义逐字段一致 → 按装上报(installed:true):运行时走叫醒由它承载,⛔ 自己 spawn 出第二份;
//  · 定义不一致 → installed:false + existingTaskStale:armed 仍答「在」(⛔ 并存两份),
//    设置页如实显示没生效并给自救动作;
//  · 中文 Windows 的报错经 execFile 按 utf8 解码必成乱码,唯一稳定可认的是 HRESULT 0x80070005(K3)。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 进程内假 powershell/schtasks:按命令形状路由——注册(可拒)、State 查询、动作定义读回(ConvertTo-Json)。
const control = vi.hoisted(() => ({
  home: '',
  calls: [] as Array<{ file: string; args: string[] }>,
  denyRegister: false,
  denyMessage: 'Command failed: powershell.exe -NoProfile -NonInteractive -Command Register-ScheduledTask ...\r\n'
    + 'Register-ScheduledTask : Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))',
  taskExists: true,
  taskState: 'Ready',
  disableFailure: '',
  disableFailures: {} as Record<string, string>,
  readback: 'json' as 'json' | 'multi' | 'absent',
  existingActionJson: ''
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, homedir: () => control.home }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const { promisify } = await import('node:util')
  const respond = (file: string, args: string[]): { error: Error | null; stdout: string } => {
    control.calls.push({ file, args })
    let error: Error | null = null
    let stdout = ''
    if (file === 'powershell.exe') {
      const command = args.join(' ')
      if (/Register-ScheduledTask/.test(command) && control.denyRegister) error = new Error(control.denyMessage)
      else if (/ConvertTo-Json/.test(command)) {
        if (control.readback === 'absent') error = new Error('Get-ScheduledTask : 没有与此条件匹配的计划任务。')
        else if (control.readback === 'multi') stdout = 'ACTIONS=2'
        else stdout = control.existingActionJson
      } else if (/Get-ScheduledTask/.test(command)) {
        if (control.taskExists) stdout = `${control.taskState}\n`
        else error = new Error('Get-ScheduledTask : 没有与此条件匹配的计划任务。')
      }
    }
    if (file === 'schtasks.exe') {
      if ((args as string[])[0] === '/query' && !control.taskExists) error = new Error('ERROR: The scheduled task does not exist')
      if ((args as string[])[0] === '/change' && (args as string[])[3] === '/disable') {
        const failure = control.disableFailures[(args as string[])[2]] ?? control.disableFailure
        if (failure !== '') error = new Error(failure)
      }
    }
    return { error, stdout }
  }
  // resident.ts 走 promisify(execFile):假桩必须带上 node 自己那个 custom promisify
  // (解构 { stdout, stderr }),⛔ 靠泛型 promisify——它会把 (err, stdout, stderr) 摊成数组。
  const runFake = (file: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const { error, stdout } = respond(file, args)
      queueMicrotask(() => error !== null ? reject(error) : resolve({ stdout, stderr: '' }))
    })
  const callbackFake = (file: string, args: string[], options?: unknown, maybeCallback?: unknown) => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as
      ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const { error, stdout } = respond(file, args as string[])
    queueMicrotask(() => callback?.(error, stdout, ''))
    return { unref() { /* 无进程可等 */ } }
  }
  const fakeExecFile = Object.assign(callbackFake, { [promisify.custom]: runFake })
  return { ...actual, execFile: fakeExecFile }
})

import {
  RESIDENT_TASK, RESIDENT_TASK_LEGACY, installWinResident, wakeResident, winResidentArmed, winResidentStaleTask, winTaskAction, winTaskXml, type ResidentSpec
} from '../../app/main/tunnel/platform/resident'
import { makeResidentRuntime } from '../../app/main/tunnel/resident-bridge'
import { systemResidentController, residentToggleStatus } from '../../app/main/desktop/resident-preference'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach(removeTempDir)
  control.calls.length = 0
  control.denyRegister = false
  control.denyMessage = 'Command failed: powershell.exe -NoProfile -NonInteractive -Command Register-ScheduledTask ...\r\n'
    + 'Register-ScheduledTask : Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))'
  control.taskExists = true
  control.taskState = 'Ready'
  control.disableFailure = ''
  control.disableFailures = {}
  control.readback = 'json'
})

const spec: ResidentSpec = {
  executable: 'C:\\Users\\pingxia\\AppData\\Local\\Programs\\laixin-ai-toolbox\\来信AI工具箱统一版.exe',
  args: ['resources\\daemon.mjs', 'start', '--data-dir', 'C:\\Users\\pingxia\\AppData\\Roaming\\来信AI工具箱统一版\\tunnel',
    '--adapter', 'C:\\Users\\pingxia\\AppData\\Local\\Programs\\laixin-ai-toolbox\\resources\\xray\\xray.exe',
    '--resident', '1', '--task-path', '\\Laixin\\cn.laixin.toolbox.tunnel'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  logDir: 'C:\\Users\\pingxia\\AppData\\Roaming\\来信AI工具箱统一版\\logs'
}

/** 把一份动作定义摆成 readWinTaskAction 要解析的形状(字段与 ConvertTo-Json 输出同名)。 */
const actionJson = (action: { execute: string; arguments: string; workingDirectory: string }): string =>
  JSON.stringify({ execute: action.execute, arguments: action.arguments, workingDirectory: action.workingDirectory })

const seedExisting = (action: { execute: string; arguments: string; workingDirectory: string }): void => {
  control.denyRegister = true
  control.readback = 'json'
  control.existingActionJson = actionJson(action)
}

describe('installWinResident:注册被拒时读回存量任务,逐字段比对', () => {
  it('路径含 % 时先停当前与历史常驻，再回退直启；不能停则如实标为存量任务，⛔ 把 Ready 误报成当前常驻', async () => {
    control.home = makeTempDir('j10rw-percent-')
    roots.push(control.home)
    const unsupported = { ...spec, args: [...spec.args, 'C:\\Users\\%USERNAME%\\tunnel'] }

    const clean = await installWinResident(unsupported, RESIDENT_TASK)

    expect(clean.installed).toBe(false)
    expect(clean.existingTaskStale).toBeFalsy()
    expect(clean.reason).toContain('暂不支持路径或启动参数含 %')
    expect(control.calls.filter((call) => call.file === 'schtasks.exe' && call.args[0] === '/change' && call.args[3] === '/disable')
      .map((call) => call.args[2])).toEqual([RESIDENT_TASK, 'cn.laixin.toolbox.tunnel'])
    expect(control.calls.some((call) => call.file === 'powershell.exe')).toBe(false)

    control.calls.length = 0
    control.disableFailure = 'ERROR: Access is denied.'
    const residual = await installWinResident(unsupported, RESIDENT_TASK)
    expect(residual.existingTaskStale).toBe(true)
    expect(residual.unmanagedStale).toBe(true)
    expect(residual.reason).toContain('旧常驻任务未停用')
    expect(residual.reason).toContain('Access is denied')
    expect(winResidentStaleTask()).toBe(true)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(false)

    control.calls.length = 0
    await wakeResident('win32', residual.staleTaskPaths)
    expect(control.calls.filter((call) => call.file === 'schtasks.exe' && call.args[0] === '/run').map((call) => call.args[2]))
      .toEqual([RESIDENT_TASK])
  })

  it('只有历史根目录任务停不掉时，存量承载必须叫醒历史任务，⛔ 把当前已停任务当承载', async () => {
    control.home = makeTempDir('j10rw-legacy-residual-')
    roots.push(control.home)
    const unsupported = { ...spec, args: [...spec.args, 'C:\\Users\\%USERNAME%\\tunnel'] }
    control.disableFailures = { [RESIDENT_TASK_LEGACY]: 'ERROR: Access is denied.' }

    const residual = await installWinResident(unsupported, RESIDENT_TASK)
    expect(residual.staleTaskPaths).toEqual([RESIDENT_TASK_LEGACY])

    const wakeCalls: Array<readonly string[] | undefined> = []
    const runtime = makeResidentRuntime({
      dataDir: control.home, platform: 'windows', supported: true, spec: () => unsupported,
      install: async () => residual,
      wake: async (_platform, taskPaths) => { wakeCalls.push(taskPaths); return { woken: true } }
    })
    await runtime.calibrate(true)
    await runtime.bridge.wake()
    expect(wakeCalls).toEqual([[RESIDENT_TASK_LEGACY]])
  })

  it('定义逐字段一致 → 按装上报(installed:true),识别层答「生效」(基线:答没装上)', async () => {
    control.home = makeTempDir('j10rw-match-')
    roots.push(control.home)
    seedExisting(winTaskAction(spec))

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(true)
    expect(outcome.existingTaskStale).toBeFalsy()
    expect(winResidentStaleTask()).toBe(false)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(true)
  })

  it('参数一字之差 → installed:false + existingTaskStale,识别层答「没生效」(⛔ 模糊匹配)', async () => {
    control.home = makeTempDir('j10rw-args-')
    roots.push(control.home)
    // 漂移构造必须碰到当前任务计划动作的实际 token；普通标志不加 ^" 包裹。
    const drifted = { ...winTaskAction(spec), arguments: winTaskAction(spec).arguments.replace('--resident 1 ', '--resident 0 ') }
    seedExisting(drifted)

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(false)
    expect(outcome.existingTaskStale).toBe(true)
    expect(winResidentStaleTask()).toBe(true)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(false)
  })

  it('执行程序或工作目录不同同样算不一致——三个字段逐一见比,⛔ 只比其中两个省事', async () => {
    control.home = makeTempDir('j10rw-fields-')
    roots.push(control.home)
    const movedExe = { ...winTaskAction(spec), execute: 'C:\\Old\\来信AI工具箱统一版.exe' }
    const movedDir = { ...winTaskAction(spec), workingDirectory: 'C:\\Old\\logs' }
    seedExisting(movedExe)
    const byExe = await installWinResident(spec, RESIDENT_TASK)
    seedExisting(movedDir)
    const byDir = await installWinResident(spec, RESIDENT_TASK)

    expect(byExe.installed).toBe(false)
    expect(byExe.existingTaskStale).toBe(true)
    expect(byDir.installed).toBe(false)
    expect(byDir.existingTaskStale).toBe(true)
  })

  it('任务不在(读不到定义) → installed:false 但不算存量承载(existingTaskStale 缺席)', async () => {
    control.home = makeTempDir('j10rw-absent-')
    roots.push(control.home)
    control.denyRegister = true
    control.readback = 'absent'

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(false)
    expect(outcome.existingTaskStale).toBeFalsy()
    expect(winResidentStaleTask()).toBe(false)
  })

  it('中文 Windows 形态:中文乱码只剩「HRESULT 0x80070005」可认,同样走读回比对(K3 钉子;判据改成只认英文时此用例必红)', async () => {
    control.home = makeTempDir('j10rw-gbk-')
    roots.push(control.home)
    control.denyMessage = 'Command failed: powershell.exe -NoProfile -NonInteractive -Command Register-ScheduledTask ...\r\n'
      + 'Register-ScheduledTask : \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\u3002 '
      + '(Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))'
    seedExisting(winTaskAction(spec))

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(true)
    expect(outcome.existingTaskStale).toBeFalsy()
  })

  it('非权限失败(超时)不读回、不背存量标记,armed 照任务状态答(护栏)', async () => {
    control.home = makeTempDir('j10rw-timeout-')
    roots.push(control.home)
    control.denyRegister = false
    await installWinResident(spec, RESIDENT_TASK) // 先成功一次,清掉可能残留的被拒态
    control.denyRegister = true
    control.denyMessage = 'Command failed: powershell.exe ... The operation timed out.'
    control.readback = 'json'
    control.existingActionJson = actionJson(winTaskAction(spec))

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(false)
    expect(outcome.existingTaskStale).toBeFalsy()
    expect(winResidentStaleTask()).toBe(false)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(true)
  })

  it('读回命令必须先设 [Console]::OutputEncoding=UTF8——中文 Windows 控制台是 GBK 代码页,漏掉则按 utf8 解码成乱码、比对恒失配(搜「OutputEncoding」应命中本条)', async () => {
    control.home = makeTempDir('j10rw-enc-')
    roots.push(control.home)
    seedExisting(winTaskAction(spec))

    await installWinResident(spec, RESIDENT_TASK)

    const rb = control.calls.filter((call) => call.file === 'powershell.exe' && /ConvertTo-Json/.test(call.args.join(' ')))
    expect(rb.length).toBeGreaterThan(0)
    expect(rb[0].args.join(' ')).toContain('[Console]::OutputEncoding = [Text.Encoding]::UTF8')
  })

  it('临时 XML 照旧清走(护栏,基线即绿)', async () => {
    control.home = makeTempDir('j10rw-xml-')
    roots.push(control.home)
    seedExisting(winTaskAction(spec))

    await installWinResident(spec, RESIDENT_TASK)

    expect(existsSync(join(control.home, 'resident-task.xml'))).toBe(false)
  })
})

describe('armed 取值与设置状态:存量任务承载时,运行时不并列第二份', () => {
  it('existingTaskStale 的安装结果 → bridge.armed() 照答「在」,运行时走叫醒(基线:答没装,主进程会 spawn 出第二份)', async () => {
    const root = makeTempDir('j10rw-bridge-')
    roots.push(root)
    const runtime = makeResidentRuntime({
      dataDir: root, platform: 'windows', supported: true, spec: () => spec,
      install: async () => ({ installed: false, reason: '拒绝访问', existingTaskStale: true })
    })
    await runtime.calibrate(true)
    expect(runtime.bridge.armed()).toBe(true)
  })

  it('普通装失败(非存量承载)armed 照旧答「没装」——降级语义不变(护栏,基线即绿)', async () => {
    const root = makeTempDir('j10rw-bridge-plain-')
    roots.push(root)
    const runtime = makeResidentRuntime({
      dataDir: root, platform: 'windows', supported: true, spec: () => spec,
      install: async () => ({ installed: false, reason: '超时' })
    })
    await runtime.calibrate(true)
    expect(runtime.bridge.armed()).toBe(false)
  })

  it('设置状态:不一致时 active:false + staleResidentTask:true;一致时 active:true 且不带 stale 标记', async () => {
    control.home = makeTempDir('j10rw-status-')
    roots.push(control.home)
    const preference = { read: () => true, write: () => { /* 记选择,与本用例无关 */ } }
    const controller = systemResidentController('win32')

    seedExisting({ ...winTaskAction(spec), arguments: winTaskAction(spec).arguments.replace('xray.exe', 'xray-old.exe') })
    await installWinResident(spec, RESIDENT_TASK)
    const stale = await residentToggleStatus(preference, controller, true)
    expect(stale.active).toBe(false)
    expect(stale.staleResidentTask).toBe(true)

    seedExisting(winTaskAction(spec))
    await installWinResident(spec, RESIDENT_TASK)
    const matched = await residentToggleStatus(preference, controller, true)
    expect(matched.active).toBe(true)
    expect(matched.staleResidentTask).toBe(false)
  })

  it('winTaskXml 与 winTaskAction 同源:抽了纯函数,XML 逐字节不变形(护栏,基线即绿)', () => {
    const action = winTaskAction(spec)
    const esc = (value: string): string =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const xml = winTaskXml(spec)
    expect(xml).toContain(`<Command>${esc(action.execute)}</Command>`)
    expect(xml).toContain(`<Arguments>${esc(action.arguments)}</Arguments>`)
    expect(xml).toContain(`<WorkingDirectory>${esc(action.workingDirectory)}</WorkingDirectory>`)
  })
})
