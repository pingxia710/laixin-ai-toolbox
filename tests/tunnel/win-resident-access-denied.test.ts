// 甲-10 / 验收线 2026-09-16 问题3:任务被管理员令牌注册过(SSH 里建、客户以管理员跑过一次工具箱)后,
// 普通权限 Register-ScheduledTask -Force 一律 Access denied——任务留在系统里,工具箱永远覆盖不了它,
// 静默退回自己起守护,「意外退出网络不断」悄悄失效;设置页却还照「任务在且未停用」报武装。
// 注册被拒过,识别(winResidentArmed)必须改答「没武装」:给客户的 active 要答这台工具箱的常驻
// 真的在生效,不是「系统里恰好有个同名任务」。重新注册成功(如以管理员再跑一次)即恢复。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 进程内假 powershell/schtasks:注册按 control.denyRegister 拒,任务在不在按 control.taskExists,
// 任务状态按 control.taskState 应答。homedir 指到临时目录,XML 临时文件落在 control.home 下。
const control = vi.hoisted(() => ({
  home: '',
  calls: [] as Array<{ file: string; args: string[] }>,
  denyRegister: false,
  denyMessage: 'Command failed: powershell.exe -NoProfile -NonInteractive -Command Register-ScheduledTask ...\r\n'
    + 'Register-ScheduledTask : Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))',
  taskExists: true,
  taskState: 'Ready',
  readback: 'json' as 'json' | 'absent',
  existingActionJson: JSON.stringify({ execute: 'C:\\Old\\来信AI工具箱统一版.exe', arguments: '--headless old', workingDirectory: 'C:\\Old\\logs' })
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
        // 甲-10 返工:注册被拒后要读回存量任务的动作定义。本文件默认摆一份「对不上」的旧定义,
        // 表达「系统里的任务不是这版要装的」——识别层据此答没武装。
        if (control.readback === 'absent') error = new Error('Get-ScheduledTask : 没有与此条件匹配的计划任务。')
        else stdout = control.existingActionJson
      } else if (/Get-ScheduledTask/.test(command)) {
        if (control.taskExists) stdout = `${control.taskState}\n`
        else error = new Error('Get-ScheduledTask : 没有与此条件匹配的计划任务。')
      }
    }
    if (file === 'schtasks.exe') {
      if ((args as string[])[0] === '/query' && !control.taskExists) error = new Error('ERROR: The scheduled task does not exist')
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

import { RESIDENT_TASK, installWinResident, winResidentArmed } from '../../app/main/tunnel/platform/resident'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach(removeTempDir)
  control.calls.length = 0
  control.denyRegister = false
  control.taskExists = true
  control.taskState = 'Ready'
  control.readback = 'json'
})

const spec = {
  executable: 'C:\\Users\\pingxia\\AppData\\Local\\Programs\\来信AI工具箱\\来信AI工具箱.exe',
  args: ['resources\\daemon.mjs', 'start', '--resident', '1'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  logDir: 'C:\\fake\\logs'
}

describe('installWinResident:注册被拒(Access denied)', () => {
  it('如实报 installed:false,原因带拒绝详情;临时 XML 照旧清走', async () => {
    control.home = makeTempDir('jia10-win-deny-')
    roots.push(control.home)
    control.denyRegister = true

    const outcome = await installWinResident(spec, RESIDENT_TASK)

    expect(outcome.installed).toBe(false)
    expect(outcome.reason).toBeTruthy()
    expect(/access is denied|access denied|0x80070005|拒绝访问/i.test(outcome.reason ?? '')).toBe(true)
    expect(existsSync(join(control.home, 'resident-task.xml'))).toBe(false)
  })

  it('任务在系统里武装着(Ready)但注册被拒:armed 如实答 false——设置页「这次没能生效」(基线:答 true,假装成功)', async () => {
    control.home = makeTempDir('jia10-win-deny-armed-')
    roots.push(control.home)
    control.denyRegister = true
    control.taskExists = true
    control.taskState = 'Ready'

    const outcome = await installWinResident(spec, RESIDENT_TASK)
    expect(outcome.installed).toBe(false)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(false)
  })

  it('重新注册成功(客户以管理员再跑一次)即恢复:armed 重新按任务状态答(自愈路径)', async () => {
    control.home = makeTempDir('jia10-win-deny-heal-')
    roots.push(control.home)
    control.denyRegister = true
    await installWinResident(spec, RESIDENT_TASK)

    control.denyRegister = false
    const healed = await installWinResident(spec, RESIDENT_TASK)
    expect(healed.installed).toBe(true)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(true)
  })

  it('注册失败但不是权限问题(超时):任务在且可管,armed 照任务状态答,⛔ 把别的失败也冤成没武装', async () => {
    control.home = makeTempDir('jia10-win-deny-timeout-')
    roots.push(control.home)
    control.denyRegister = false
    await installWinResident(spec, RESIDENT_TASK) // 先成功一次,清掉可能残留的被拒态
    control.denyRegister = true
    control.denyMessage = 'Command failed: powershell.exe ... The operation timed out.'

    const outcome = await installWinResident(spec, RESIDENT_TASK)
    expect(outcome.installed).toBe(false)
    expect(await winResidentArmed(RESIDENT_TASK)).toBe(true)
  })
})
