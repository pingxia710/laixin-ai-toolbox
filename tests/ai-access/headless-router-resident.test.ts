import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const command = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; timeout: number }[], loaded: false, xml: '', bootoutError: false, powershellError: false,
  taskState: 'missing' as 'missing' | 'present', queryError: false, deleteMissing: false, registerAccessDenied: false,
  existingAction: undefined as { execute: string; arguments: string; workingDirectory: string; runLevel: string } | undefined
}))
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    command.calls.push({ file, args, timeout: options.timeout })
    if (file === 'launchctl' && args[0] === 'print' && !command.loaded) { callback(new Error('not found')); return }
    if (file === 'launchctl' && args[0] === 'bootout' && command.bootoutError) { callback(new Error('permission denied')); return }
    if (file === 'launchctl' && args[0] === 'bootstrap') command.loaded = true
    if (file === 'launchctl' && args[0] === 'bootout') command.loaded = false
    if (file === 'powershell.exe') {
      if (args.join(' ').includes('Get-ScheduledTask')) {
        if (command.queryError) { callback(new Error('fixture task query failure')); return }
        if (args.join(' ').includes('ConvertTo-Json')) {
          callback(null, command.existingAction ? JSON.stringify(command.existingAction) : '', '')
          return
        }
        callback(null, JSON.stringify({ exists: command.taskState === 'present' }), '')
        return
      }
      if (command.registerAccessDenied) { callback(new Error('Access is denied. 0x80070005')); return }
      if (command.powershellError) { callback(new Error('sharing violation')); return }
      const path = join(command.xml, 'ai-router-task.xml')
      void readFile(path).then(bytes => { command.xml = bytes.toString('utf16le'); callback(null, '', '') }, error => callback(error as Error))
      return
    }
    if (file === 'schtasks.exe' && args[0] === '/delete' && command.deleteMissing) { callback(new Error('cannot find the task')); return }
    callback(null, '', '')
  }
}))

import { AI_ROUTER_LABEL, AI_ROUTER_TASK, aiRouterMacAgentPath, installAiRouterResident, removeAiRouterResident, wakeAiRouterResident } from '../../app/main/ai-access/router-resident'
import { RESIDENT_LABEL, RESIDENT_TASK } from '../../app/main/tunnel/platform/resident'

let root = ''
afterEach(async () => {
  command.calls.length = 0; command.loaded = false; command.xml = ''; command.bootoutError = false; command.powershellError = false
  command.taskState = 'missing'; command.queryError = false; command.deleteMissing = false; command.registerAccessDenied = false
  command.existingAction = undefined
  if (root) await rm(root, { recursive: true, force: true }); root = ''
})
const managedDefinitionMaxBytes = 128 * 1024

describe('独立 AI router 常驻安装和停止命令', () => {
  it('macOS 只注册独立 plist，同定义重复校准不踢已运行进程', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-resident-'))
    const spec = { executable: '/Applications/Laixin.app/Contents/MacOS/Laixin', logDir: join(root, 'logs') }
    await installAiRouterResident(spec, 'darwin', root)
    expect(await readFile(aiRouterMacAgentPath(root), 'utf8')).toContain(AI_ROUTER_LABEL)
    expect(command.calls.filter(call => call.args[0] === 'bootstrap')).toHaveLength(1)
    await installAiRouterResident(spec, 'darwin', root)
    expect(command.calls.filter(call => call.args[0] === 'bootstrap')).toHaveLength(1)
    await wakeAiRouterResident('darwin')
    await removeAiRouterResident('darwin', root)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).toContain(AI_ROUTER_LABEL)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_LABEL)
    expect(command.calls.every(call => call.timeout === 8000)).toBe(true)
  })

  it('Windows 只注册当前用户独立任务，不使用普通权限会被拒绝的登录触发器', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-'))
    command.xml = root
    await installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir: root }, 'win32')
    expect(command.xml).toContain('<TimeTrigger>')
    expect(command.xml).toContain('<Interval>PT1M</Interval>')
    expect(command.xml).not.toContain('<LogonTrigger>')
    expect(command.xml).toContain('<RestartOnFailure>')
    expect(command.xml).toContain('&quot;--laixin-ai-router&quot;')
    await wakeAiRouterResident('win32')
    await removeAiRouterResident('win32')
    expect(command.calls.some(call => call.file === 'powershell.exe' && call.args.join(' ').includes(AI_ROUTER_LABEL))).toBe(true)
    expect(command.calls.some(call => call.file === 'schtasks.exe' && call.args.join(' ').includes(AI_ROUTER_TASK))).toBe(true)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
    expect(command.calls.every(call => call.timeout === 8000)).toBe(true)
  })

  it('Windows 普通权限无法覆盖管理员已建任务时，只接管完全相同的启动动作', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-adopt-'))
    command.xml = root
    command.registerAccessDenied = true
    command.existingAction = {
      execute: 'C:\\Program Files\\Laixin\\Laixin.exe',
      arguments: '"--laixin-ai-router"',
      workingDirectory: root,
      runLevel: 'LeastPrivilege'
    }

    await expect(installAiRouterResident({ executable: command.existingAction.execute, logDir: root }, 'win32'))
      .resolves.toBeUndefined()
    expect(command.calls.some(call => call.args.join(' ').includes('ConvertTo-Json'))).toBe(true)
  })

  it('Windows 普通权限不能覆盖且存量任务不同时，返回可识别的权限错误', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-denied-'))
    command.xml = root
    command.registerAccessDenied = true
    command.existingAction = {
      execute: 'C:\\Old\\Laixin.exe',
      arguments: '"--laixin-ai-router"',
      workingDirectory: root,
      runLevel: 'LeastPrivilege'
    }

    await expect(installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir: root }, 'win32'))
      .rejects.toThrow('AI_ROUTER_RESIDENT_TASK_PERMISSION_DENIED')
  })

  it('Windows 受保护任务即使启动动作相同，也不接管高权限定义', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-elevated-'))
    command.xml = root
    command.registerAccessDenied = true
    command.existingAction = {
      execute: 'C:\\Program Files\\Laixin\\Laixin.exe',
      arguments: '"--laixin-ai-router"',
      workingDirectory: root,
      runLevel: 'Highest'
    }

    await expect(installAiRouterResident({ executable: command.existingAction.execute, logDir: root }, 'win32'))
      .rejects.toThrow('AI_ROUTER_RESIDENT_TASK_PERMISSION_DENIED')
  })

  it('Windows 计划任务替换失败时报错并删除临时 XML，不触碰网络任务', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-failure-'))
    command.xml = root
    command.powershellError = true

    await expect(installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir: root }, 'win32'))
      .rejects.toThrow('sharing violation')

    await expect(readFile(join(root, 'ai-router-task.xml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
  })

  it('Windows 删除 AI router 任务后回读确认不存在，且不调用网络任务', async () => {
    command.taskState = 'missing'

    await expect(removeAiRouterResident('win32')).resolves.toBeUndefined()

    expect(command.calls.some(call => call.file === 'schtasks.exe' && call.args[0] === '/delete')).toBe(true)
    expect(command.calls.some(call => call.file === 'powershell.exe' && call.args.join(' ').includes('Get-ScheduledTask'))).toBe(true)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
  })

  it('Windows 删除命令成功但 AI router 任务仍在时失败关闭', async () => {
    command.taskState = 'present'

    await expect(removeAiRouterResident('win32')).rejects.toThrow('AI_ROUTER_RESIDENT_TASK_STILL_PRESENT')

    expect(command.calls.some(call => call.file === 'powershell.exe' && call.args.join(' ').includes('Get-ScheduledTask'))).toBe(true)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
  })

  it('Windows 原本不存在 AI router 任务时回读为幂等成功', async () => {
    command.deleteMissing = true
    command.taskState = 'missing'

    await expect(removeAiRouterResident('win32')).resolves.toBeUndefined()

    expect(command.calls.some(call => call.file === 'powershell.exe' && call.args.join(' ').includes('Get-ScheduledTask'))).toBe(true)
    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
  })

  it('Windows 删除后的任务查询异常时失败关闭且不调用网络任务', async () => {
    command.queryError = true

    await expect(removeAiRouterResident('win32')).rejects.toThrow('AI_ROUTER_RESIDENT_TASK_STATE_UNKNOWN')

    expect(command.calls.map(call => call.args.join(' ')).join('\n')).not.toContain(RESIDENT_TASK)
  })

  it('macOS plist 是链接时拒绝安装，不能覆盖链接目标', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-plist-link-'))
    const target = join(root, 'keep.plist')
    const path = aiRouterMacAgentPath(root)
    await writeFile(target, 'preserve mac target\n')
    await mkdir(join(root, 'Library', 'LaunchAgents'), { recursive: true })
    await symlink(target, path)

    await expect(installAiRouterResident({ executable: '/Applications/Laixin.app/Contents/MacOS/Laixin', logDir: join(root, 'logs') }, 'darwin', root)).rejects.toThrow()

    expect(await readFile(target, 'utf8')).toBe('preserve mac target\n')
    expect(command.calls.some(call => call.args[0] === 'bootstrap')).toBe(false)
  })

  it('macOS 旧 LaunchAgent bootout 失败时恢复原定义且不 bootstrap 新定义', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-bootout-failure-'))
    const path = aiRouterMacAgentPath(root)
    const original = '<?xml version="1.0"?><plist><dict><key>Label</key><string>cn.laixin.toolbox.ai-router</string></dict></plist>\n'
    await mkdir(join(root, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, original)
    command.bootoutError = true

    await expect(installAiRouterResident({ executable: '/Applications/New.app/Contents/MacOS/New', logDir: join(root, 'logs') }, 'darwin', root))
      .rejects.toThrow('permission denied')

    await expect(readFile(path, 'utf8')).resolves.toBe(original)
    expect(command.calls.some(call => call.args[0] === 'bootstrap')).toBe(false)
  })

  it('Windows 临时任务 XML 是链接时拒绝安装，不能覆盖链接目标', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-link-'))
    const target = join(root, 'keep.xml')
    const logDir = join(root, 'logs')
    await writeFile(target, 'preserve windows target\n')
    await mkdir(logDir, { recursive: true })
    await symlink(target, join(logDir, 'ai-router-task.xml'))

    await expect(installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir }, 'win32')).rejects.toThrow()

    expect(await readFile(target, 'utf8')).toBe('preserve windows target\n')
    expect(command.calls.some(call => call.file === 'powershell.exe')).toBe(false)
  })

  it('macOS 允许刚好 128 KiB 的已有 plist 并完成安装', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-plist-limit-'))
    const path = aiRouterMacAgentPath(root)
    await mkdir(join(root, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, Buffer.alloc(managedDefinitionMaxBytes, 0x61))

    await installAiRouterResident({ executable: '/Applications/Laixin.app/Contents/MacOS/Laixin', logDir: join(root, 'logs') }, 'darwin', root)

    expect(command.calls.some(call => call.file === 'launchctl' && call.args[0] === 'bootstrap')).toBe(true)
  })

  it('macOS 拒绝超过 128 KiB 的已有 plist，保留原字节且不 bootstrap', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-plist-too-large-'))
    const path = aiRouterMacAgentPath(root)
    const original = Buffer.alloc(managedDefinitionMaxBytes + 1, 0x61)
    await mkdir(join(root, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(path, original)

    await expect(installAiRouterResident({ executable: '/Applications/Laixin.app/Contents/MacOS/Laixin', logDir: join(root, 'logs') }, 'darwin', root)).rejects.toThrow('AI_ROUTER_RESIDENT_PATH_INVALID')

    expect(await readFile(path)).toEqual(original)
    expect(command.calls.some(call => call.file === 'launchctl' && call.args[0] === 'bootstrap')).toBe(false)
  })

  it('Windows 允许刚好 128 KiB 的已有 XML 并完成注册', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-limit-'))
    const logDir = join(root, 'logs')
    command.xml = logDir
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, 'ai-router-task.xml'), Buffer.alloc(managedDefinitionMaxBytes, 0x61))

    await installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir }, 'win32')

    expect(command.calls.some(call => call.file === 'powershell.exe')).toBe(true)
    expect(command.calls.some(call => call.file === 'schtasks.exe' && call.args[0] === '/query')).toBe(true)
  })

  it('Windows 拒绝超过 128 KiB 的已有 XML，保留原字节且不注册任务', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-task-too-large-'))
    const logDir = join(root, 'logs')
    const path = join(logDir, 'ai-router-task.xml')
    const original = Buffer.alloc(managedDefinitionMaxBytes + 1, 0x61)
    command.xml = logDir
    await mkdir(logDir, { recursive: true })
    await writeFile(path, original)

    await expect(installAiRouterResident({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir }, 'win32')).rejects.toThrow('AI_ROUTER_RESIDENT_PATH_INVALID')

    expect(await readFile(path)).toEqual(original)
    expect(command.calls.some(call => call.file === 'powershell.exe')).toBe(false)
    expect(command.calls.some(call => call.file === 'schtasks.exe')).toBe(false)
  })

  it('待写入 plist 超过 128 KiB 时拒绝且不调用 launchctl', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-router-plist-content-too-large-'))
    const executable = `/Applications/${'a'.repeat(managedDefinitionMaxBytes)}`

    await expect(installAiRouterResident({ executable, logDir: join(root, 'logs') }, 'darwin', root)).rejects.toThrow('AI_ROUTER_RESIDENT_PATH_INVALID')

    expect(command.calls.some(call => call.file === 'launchctl')).toBe(false)
  })
})
