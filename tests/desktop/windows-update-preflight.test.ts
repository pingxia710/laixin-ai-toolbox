import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

interface NativeResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

type NativeRunner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<NativeResult>
interface WindowsPreflightOptions {
  readonly mode: 'update' | 'uninstall'
  readonly target: string
  readonly executable: string
  readonly residentLabel: string
  readonly currentPid?: number
  readonly now?: () => number
  readonly recoveryDirectory?: string
  readonly tunnelDataDir?: string
  readonly ownerPid?: number
  readonly ownerExecutable?: string
  readonly recoveryOwnerAlive?: (pid: number) => boolean
  readonly acquireRecoveryMutex?: () => Promise<() => Promise<void>>
  readonly recoveryIdentitySnapshot?: () => Promise<{ ownerStartFileTime: string; workerStartFileTime: string }>
  readonly launchRecoveryGuard?: (options: {
    readonly powershell: string
    readonly guardSourcePath: string
    readonly guardPath: string
    readonly launcherPath: string
    readonly readyPath: string
    readonly guardStartPath: string
    readonly guardErrorPath: string
    readonly marker: {
      readonly ownerPid: number
      readonly ownerExecutable: string
      readonly ownerStartFileTime: string
      readonly workerPid: number
      readonly workerExecutable: string
      readonly workerStartFileTime: string
    }
    readonly transactionId: string
  }) => Promise<number>
}
interface WindowsHelper {
  defaultRecoveryGuardLauncher(options: {
    readonly powershell: string
    readonly guardSourcePath: string
    readonly guardPath: string
    readonly launcherPath: string
    readonly readyPath: string
    readonly guardStartPath: string
    readonly guardErrorPath: string
    readonly marker: {
      readonly ownerPid: number
      readonly ownerExecutable: string
      readonly ownerStartFileTime: string
      readonly workerPid: number
      readonly workerExecutable: string
      readonly workerStartFileTime: string
    }
    readonly transactionId: string
  }, spawnImpl?: (file: string, args: readonly string[], options: Record<string, unknown>) => EventEmitter & {
    readonly pid?: number
    unref(): void
  }): Promise<number>
  runNative(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<NativeResult>
  windowsPreflight(options: WindowsPreflightOptions, runner?: NativeRunner): Promise<void>
  recoverWindowsPreflight(markerPath: string, runner: NativeRunner, transactionId: string): Promise<void>
  commitWindowsPreflight(recoveryDirectory: string, runner: NativeRunner, ownerPid: number, transactionId?: string): Promise<void>
  commitWindowsPreflightCommand(recoveryDirectory: string, runner: NativeRunner, ownerPid: number, transactionId?: string): Promise<void>
  verifyWindowsPreflightHandoff(target: string, executable: string, recoveryDirectory: string, runner?: NativeRunner): Promise<void>
  decodeNativeOutput(chunks: readonly Buffer[]): string
  disableTaskXml(xml: string): string
}

const requireFromTest = createRequire(import.meta.url)
const helper = requireFromTest('../../resources/update-helper.cjs') as WindowsHelper
const TARGET = 'C:\\Apps\\Laixin'
const EXECUTABLE = `${TARGET}\\来信AI工具箱统一版.exe`
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const LABEL = 'cn.laixin.toolbox.tunnel'
const TASKS = [`\\Laixin\\${LABEL}`, LABEL] as const
const START_FILETIME = '133000000000000000'
const recoveryIdentitySnapshot = async () => ({ ownerStartFileTime: START_FILETIME, workerStartFileTime: START_FILETIME })

type TaskState = 'missing' | 'Enabled' | 'Disabled' | 'unknown'

interface FixtureOptions {
  readonly tasks?: Partial<Record<(typeof TASKS)[number], TaskState>>
  readonly changeCode?: Partial<Record<(typeof TASKS)[number], number>>
  readonly deleteCode?: Partial<Record<(typeof TASKS)[number], number>>
  readonly registerCode?: number
  readonly keepEnabledOnSuccess?: (typeof TASKS)[number]
  readonly queryXml?: Partial<Record<(typeof TASKS)[number], string>>
  readonly missingQueryStderr?: string
  readonly existenceQueryCode?: number
  readonly unknownManagedPath?: boolean
  readonly timeout?: { verb: 'change' | 'query' | 'delete'; task: (typeof TASKS)[number] }
  readonly terminate?: { pid: number; code?: number; timedOut?: boolean; keepRunning?: boolean }
  readonly processQueryFailureAt?: number
  readonly processQueryTimeoutAt?: number
  readonly fallbackCode?: number
  readonly taskRunCode?: number
  readonly taskRunStartsResident?: boolean
  readonly advanceMsPerCall?: number
  readonly guardPid?: number
}

function fixture(options: FixtureOptions = {}) {
  const tasks = new Map<string, TaskState>(TASKS.map((task) => [task, options.tasks?.[task] ?? 'missing']))
  const originalTasks = new Map(tasks)
  const processes = [
    { ProcessId: 101, Name: win32.basename(EXECUTABLE), ExecutablePath: EXECUTABLE as string | null },
    { ProcessId: 102, Name: 'xray.exe', ExecutablePath: `${TARGET}\\resources\\xray\\xray.exe` as string | null },
    { ProcessId: 103, Name: 'xray.exe', ExecutablePath: 'C:\\OtherProxy\\xray.exe' as string | null },
    { ProcessId: 999, Name: win32.basename(EXECUTABLE), ExecutablePath: EXECUTABLE as string | null },
    ...(options.guardPid ? [{ ProcessId: options.guardPid, Name: 'powershell.exe', ExecutablePath: POWERSHELL as string | null,
      CommandLine: `"${POWERSHELL}" -File "recovery/windows-preflight-recovery.ps1" -Guard` }] : []),
    ...(options.unknownManagedPath ? [{ ProcessId: 104, Name: 'xray.exe', ExecutablePath: null }] : [])
  ]
  const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number; script?: string }> = []
  const killed: number[] = []
  const taskRuns: string[] = []
  let proxyEnabled = true
  let fallbackCalls = 0
  let processQueries = 0
  let clock = 0
  const runner: NativeRunner = async (file, args, commandOptions) => {
    const elapsed = options.advanceMsPerCall ?? 0
    clock += elapsed
    const name = win32.basename(file).toLowerCase()
    const encodedAt = args.findIndex((item) => item === '-EncodedCommand')
    const encodedScript = encodedAt >= 0 ? Buffer.from(String(args[encodedAt + 1]), 'base64').toString('utf16le') : undefined
    calls.push({ file: name, args: [...args], timeoutMs: commandOptions.timeoutMs, script: encodedScript })
    if (elapsed > commandOptions.timeoutMs) return { code: null, stdout: '', stderr: '', timedOut: true }
    if (name === 'schtasks.exe') {
      const verb = String(args[0]).slice(1).toLowerCase() as 'change' | 'query' | 'delete' | 'create' | 'run'
      const task = String(args[args.findIndex((item) => String(item).toLowerCase() === '/tn') + 1]) as (typeof TASKS)[number]
      if (options.timeout?.verb === verb && options.timeout.task === task) {
        return { code: null, stdout: '', stderr: '', timedOut: true }
      }
      const state = tasks.get(task) ?? 'unknown'
      if (verb === 'change') {
        const code = options.changeCode?.[task] ?? (state === 'missing' || state === 'unknown' ? 1 : 0)
        if (code === 0 && options.keepEnabledOnSuccess !== task) {
          tasks.set(task, args.some((item) => String(item).toLowerCase() === '/enable') ? 'Enabled' : 'Disabled')
        }
        return { code, stdout: '', stderr: code === 0 ? '' : 'ERROR: Access is denied.' }
      }
      if (verb === 'delete') {
        const code = options.deleteCode?.[task] ?? (state === 'missing' || state === 'unknown' ? 1 : 0)
        if (code === 0) tasks.set(task, 'missing')
        return { code, stdout: '', stderr: code === 0 ? '' : 'ERROR: Access is denied.' }
      }
      if (verb === 'create') {
        const original = originalTasks.get(task)
        tasks.set(task, original === 'Disabled' ? 'Disabled' : 'Enabled')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (verb === 'run') {
        taskRuns.push(task)
        if ((options.taskRunCode ?? 0) === 0 && options.taskRunStartsResident !== false) {
          processes.push({ ProcessId: 200, Name: win32.basename(EXECUTABLE), ExecutablePath: EXECUTABLE,
            CommandLine: `"${EXECUTABLE}" "${TARGET}\\resources\\sidecar\\win\\tunnel-daemon.mjs"` })
        }
        return { code: options.taskRunCode ?? 0, stdout: '', stderr: options.taskRunCode ? 'run failed' : '' }
      }
      if (state === 'missing') {
        return { code: 1, stdout: '', stderr: options.missingQueryStderr ?? 'ERROR: The system cannot find the file specified.' }
      }
      if (state === 'unknown') return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }
      return {
        code: 0,
        stdout: options.queryXml?.[task] ?? `<Task><Settings><Enabled>${state === 'Enabled' ? 'true' : 'false'}</Enabled></Settings></Task>`,
        stderr: ''
      }
    }
    if (name === 'powershell.exe') {
      if (encodedScript?.includes('LAIXIN_TASK_EXISTENCE_QUERY')) {
        const fullPathToken = Buffer.from('\\Laixin\\', 'utf8').toString('base64')
        const task = encodedScript.includes(fullPathToken) ? TASKS[0] : TASKS[1]
        const state = tasks.get(task)
        return { code: options.existenceQueryCode ?? (state === 'missing' ? 3 : state === 'unknown' ? 2 : 0),
          stdout: '', stderr: '' }
      }
      if (encodedScript?.includes('LAIXIN_TASK_COMPENSATION_REGISTER')) {
        const task = TASKS.find((candidate) => tasks.get(candidate) === 'missing' && originalTasks.get(candidate) !== 'missing')
        const code = options.registerCode ?? (task ? 0 : 1)
        if (task && code === 0) tasks.set(task, 'Disabled')
        return { code, stdout: '', stderr: code === 0 ? '' : 'Access is denied.' }
      }
      if (encodedScript?.includes('LAIXIN_RECOVERY_REGISTER') || encodedScript?.includes('LAIXIN_RECOVERY_UNREGISTER')) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (encodedScript?.includes('LAIXIN_PROXY_FALLBACK')) {
        fallbackCalls += 1
        if ((options.fallbackCode ?? 0) === 0) proxyEnabled = false
        return { code: options.fallbackCode ?? 0, stdout: '', stderr: options.fallbackCode ? 'fallback failed' : '' }
      }
      if (encodedScript?.includes('LAIXIN_SAME_HANDLE_TERMINATE')) {
        const pid = Number(/LAIXIN_PID=(\d+)/.exec(encodedScript)?.[1])
        if (options.terminate?.pid === pid) {
          if (options.terminate.timedOut) return { code: null, stdout: '', stderr: '', timedOut: true }
          if ((options.terminate.code ?? 0) !== 0) return { code: options.terminate.code ?? 1, stdout: '', stderr: 'terminate failed' }
        }
        if (options.terminate?.pid !== pid || options.terminate.keepRunning !== true) {
          const index = processes.findIndex((process) => process.ProcessId === pid)
          if (index >= 0) processes.splice(index, 1)
          killed.push(pid)
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      processQueries += 1
      if (processQueries === options.processQueryTimeoutAt) return { code: null, stdout: '', stderr: '', timedOut: true }
      if (processQueries === options.processQueryFailureAt) return { code: 1, stdout: '', stderr: 'query failed' }
      return { code: 0, stdout: Buffer.from(JSON.stringify(processes.map((process) => ({
        ...process, StartFileTime: '133000000000000000'
      }))), 'utf8').toString('base64'), stderr: '' }
    }
    throw new Error(`unexpected command: ${file}`)
  }
  return { tasks, processes, calls, killed, taskRuns, runner, now: () => clock,
    get proxyEnabled() { return proxyEnabled }, get fallbackCalls() { return fallbackCalls } }
}

async function runBeforeInstallWrite(f: ReturnType<typeof fixture>, mode: 'update' | 'uninstall' = 'update') {
  const events: string[] = []
  await helper.windowsPreflight({ mode, target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
    currentPid: 999, now: f.now }, f.runner)
  events.push('install-directory-write')
  return events
}

describe('Windows 更新/卸载前置闸', () => {
  it('原生命令超时后必须等同一子进程真正退出，不能带着未确认的后台写入返回', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'laixin-native-timeout-'))
    const pidPath = join(directory, 'pid.txt')
    try {
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
      const result = await helper.runNative(process.execPath, ['-e', childScript], { timeoutMs: 500 })
      expect(result.timedOut).toBe(true)
      const pid = Number(await readFile(pidPath, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      const source = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
      expect(source).not.toContain('terminationUnconfirmed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('schtasks XML 的 UTF-16LE 输出可被正确回读', () => {
    const xml = '<Task><Settings><Enabled>false</Enabled></Settings></Task>'
    expect(helper.decodeNativeOutput([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])).toBe(xml)
  })

  it('GBK 的“找不到文件”乱码不阻止卸载，缺失任务须经结构化查询确认', async () => {
    const gbk = Buffer.from('b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfea1a30d0d0a', 'hex')
    const decoded = helper.decodeNativeOutput([gbk])
    expect(decoded).not.toContain('找不到')
    const f = fixture({ tasks: { [TASKS[0]]: 'Disabled' }, missingQueryStderr: decoded })

    expect(await runBeforeInstallWrite(f, 'uninstall')).toEqual(['install-directory-write'])
    expect(f.tasks.get(TASKS[0])).toBe('missing')
    expect(f.calls.some((call) => call.script?.includes('LAIXIN_TASK_EXISTENCE_QUERY') &&
      call.script.includes('Get-ScheduledTask -ErrorAction Stop'))).toBe(true)
  })

  it('预检失败把错误码写入本地恢复目录，并保持非零退出码', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'laixin-preflight-error-'))
    try {
      const result = spawnSync(process.execPath, [join(__dirname, '..', '..', 'resources', 'update-helper.cjs'),
        'windows-preflight', 'uninstall'], {
        encoding: 'utf8',
        env: { ...process.env, LAIXIN_PREFLIGHT_TARGET: '',
          LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY: directory }
      })
      expect(result.status).toBe(1)
      expect(await readFile(join(directory, 'windows-preflight-last-error.log'), 'utf8'))
        .toContain('INVALID_WINDOWS_PREFLIGHT')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('结构化任务查询本身失败时不能把任务误判为已删除', async () => {
    const f = fixture({ existenceQueryCode: 2 })

    await expect(runBeforeInstallWrite(f, 'uninstall')).rejects.toThrow('UPDATE_RESIDENT_TASK_STATE_UNKNOWN')
    expect(f.killed).toEqual([])
  })

  it('卸载补偿重建任务时只禁用 Settings.Enabled，不误改触发器自己的 Enabled', () => {
    const xml = '<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>'

    expect(helper.disableTaskXml(xml)).toBe(
      '<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>'
    )
  })

  it('主程序不在当前安装目录：身份校验失败，任何原生命令都不执行', async () => {
    const f = fixture()

    await expect(helper.windowsPreflight({
      mode: 'update', target: TARGET, executable: 'C:\\Other\\来信AI工具箱统一版.exe', residentLabel: LABEL
    }, f.runner)).rejects.toThrow(/INVALID_WINDOWS_PREFLIGHT/)
    expect(f.calls).toEqual([])
  })

  it('新旧任务都不存在：可继续，只按精确路径停来信主进程和内核', async () => {
    const f = fixture()

    expect(await runBeforeInstallWrite(f)).toEqual(['install-directory-write'])
    expect(f.killed.sort()).toEqual([101, 102])
    expect(f.processes).toContainEqual({ ProcessId: 103, Name: 'xray.exe', ExecutablePath: 'C:\\OtherProxy\\xray.exe' })
    expect(f.processes).toContainEqual({ ProcessId: 999, Name: win32.basename(EXECUTABLE), ExecutablePath: EXECUTABLE })
    expect(f.calls.filter((call) => call.file === 'schtasks.exe' && call.args[0] === '/query')).toHaveLength(2)
    expect(f.calls.some((call) => call.file === 'powershell.exe' && call.args.join(' ').includes('ToBase64String'))).toBe(true)
    const terminators = f.calls.filter((call) => call.script?.includes('LAIXIN_SAME_HANDLE_TERMINATE'))
    expect(terminators).toHaveLength(2)
    expect(terminators.every((call) => call.script?.includes('OpenProcess') &&
      call.script.includes('QueryFullProcessImageName') && call.script.includes('WaitForSingleObject') &&
      call.script.includes('TerminateProcess') && call.script.includes('GetProcessTimes') &&
      call.script.includes('[Math]::Abs($created - [long]$expectedStart) -gt 10') &&
      call.script.includes("$expectedStart='133000000000000000'"))).toBe(true)
    expect(f.calls.some((call) => call.file === 'taskkill.exe')).toBe(false)
  })

  it('新旧任务都成功 Disabled 且 XML 回读为 false：才可进入停进程与换文件', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' } })

    expect(await runBeforeInstallWrite(f)).toEqual(['install-directory-write'])
    expect([...f.tasks.values()]).toEqual(['Disabled', 'Disabled'])
    expect(f.killed.sort()).toEqual([101, 102])
  })

  it('同名来信/xray 进程路径不可读：身份不可确认，停止且不按名称误杀', async () => {
    const f = fixture({ unknownManagedPath: true })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/IDENTITY_UNKNOWN/)
    expect(f.killed).toEqual([])
    expect(f.processes).toContainEqual({ ProcessId: 103, Name: 'xray.exe', ExecutablePath: 'C:\\OtherProxy\\xray.exe' })
  })

  it.each(TASKS)('%s 的 /change 非零且任务仍 Enabled：在停进程和安装目录写入前失败', async (task) => {
    const f = fixture({ tasks: { [task]: 'Enabled' }, changeCode: { [task]: 5 } })
    let wrote = false

    await expect(runBeforeInstallWrite(f).then(() => { wrote = true })).rejects.toThrow(/TASK/)
    expect(wrote).toBe(false)
    expect(f.killed).toEqual([])
  })

  it('/change 返回 0 但 XML 回读仍 Enabled：不得把退出码 0 当成真正停用', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, keepEnabledOnSuccess: TASKS[0] })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/TASK/)
    expect(f.killed).toEqual([])
  })

  it('触发器 Disabled 但任务 Settings 仍 Enabled：不得误读成任务已停用', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled' },
      queryXml: {
        [TASKS[0]]: '<Task><Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>'
      }
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/STILL_ENABLED/)
    expect(f.killed).toEqual([])
  })

  it('/change 返回非零，即使回读碰巧已 Disabled 也不得吞掉原生命令失败', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Disabled' }, changeCode: { [TASKS[0]]: 5 } })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/DISABLE_FAILED/)
    expect(f.killed).toEqual([])
  })

  it('任务命令挂起：有界超时并在任何目标写入前失败', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, timeout: { verb: 'change', task: TASKS[0] } })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/TIMEOUT/)
    expect(f.killed).toEqual([])
  })

  it('任务状态回读挂起：同样有界超时并停止', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, timeout: { verb: 'query', task: TASKS[0] } })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/QUERY_TIMEOUT/)
    expect(f.killed).toEqual([])
  })

  it.each(TASKS)('%s 查询权限不明：不得当成“任务不存在”', async (task) => {
    const f = fixture({ tasks: { [task]: 'unknown' } })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/TASK/)
    expect(f.killed).toEqual([])
  })

  it('真卸载时删除命令失败且任务仍在：不得静默报成功', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Disabled' }, deleteCode: { [TASKS[0]]: 5 } })

    await expect(runBeforeInstallWrite(f, 'uninstall')).rejects.toThrow(/TASK/)
    expect(f.killed.sort()).toEqual([101, 102])
    expect(f.tasks.get(TASKS[0])).toBe('Disabled')
    expect(f.fallbackCalls).toBe(1)
  })

  it('第二个进程终止失败：补偿恢复任务、关闭死回环代理并叫醒旧守护后才报错', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' },
      terminate: { pid: 102, code: 5 }
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/PROCESS_STOP_FAILED/)
    expect(f.killed).toEqual([101])
    expect([...f.tasks.values()]).toEqual(['Enabled', 'Enabled'])
    expect(f.fallbackCalls).toBe(1)
    expect(f.proxyEnabled).toBe(false)
    expect(f.taskRuns).toEqual([TASKS[0]])
    const fallbackAt = f.calls.findIndex((call) => call.script?.includes('LAIXIN_PROXY_FALLBACK'))
    const enableAt = f.calls.findIndex((call) => call.file === 'schtasks.exe' && call.args.includes('/enable'))
    const runAt = f.calls.findIndex((call) => call.file === 'schtasks.exe' && call.args[0] === '/run')
    expect(fallbackAt).toBeGreaterThan(-1)
    expect(enableAt).toBeGreaterThan(fallbackAt)
    expect(runAt).toBeGreaterThan(enableAt)
    const fallbackScript = f.calls[fallbackAt]?.script ?? ''
    expect(fallbackScript.match(/Get-ItemProperty/g)).toHaveLength(2)
    expect(fallbackScript).toContain('$mustDisable=')
    expect(fallbackScript).toContain('LAIXIN_PROXY_LEDGER_OWNERSHIP')
    expect(fallbackScript).toContain("Join-Path $TunnelDataDir 'ledger.json'")
    expect(fallbackScript).toContain('Get-NetTCPConnection -State Listen')
    expect(fallbackScript).toContain('$server.writtenValue.data -ceq [string]$Settings.ProxyServer')
    expect(fallbackScript).not.toContain('$loopback=$false')
    expect(fallbackScript).toMatch(/if\(\$mustDisable -and \[int\]\$after\.ProxyEnable -ne 0\)\{exit 31\}/)
    expect(fallbackScript).toContain('exit 31')
  })

  it('进程终止超时：同样补偿，不能把任务留 Disabled 或把代理留在死回环', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled' },
      terminate: { pid: 102, timedOut: true }
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/PROCESS_STOP_TIMEOUT/)
    expect(f.tasks.get(TASKS[0])).toBe('Enabled')
    expect(f.fallbackCalls).toBe(1)
    expect(f.proxyEnabled).toBe(false)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('两只进程已停但二次枚举失败：仍按有副作用失败补偿，不得直接返回', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled' },
      processQueryFailureAt: 2
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/PROCESS_QUERY_FAILED/)
    expect(f.killed.sort()).toEqual([101, 102])
    expect(f.tasks.get(TASKS[0])).toBe('Enabled')
    expect(f.fallbackCalls).toBe(1)
    expect(f.proxyEnabled).toBe(false)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('终止命令返回 0 但二次枚举仍见进程：按部分停止失败补偿，不得进入换文件', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled' },
      terminate: { pid: 102, keepRunning: true }
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/STILL_RUNNING/)
    expect(f.killed).toEqual([101])
    expect(f.tasks.get(TASKS[0])).toBe('Enabled')
    expect(f.fallbackCalls).toBe(1)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('真卸载删掉第一只任务、第二只删除失败：用原 XML 重建并恢复原启用状态', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' },
      deleteCode: { [TASKS[1]]: 5 }
    })

    await expect(runBeforeInstallWrite(f, 'uninstall')).rejects.toThrow(/TASK/)
    expect([...f.tasks.values()]).toEqual(['Enabled', 'Enabled'])
    expect(f.calls.some((call) => call.file === 'powershell.exe' && call.script?.includes('LAIXIN_TASK_COMPENSATION_REGISTER') &&
      call.script.includes('Register-ScheduledTask'))).toBe(true)
    expect(f.calls.some((call) => call.file === 'schtasks.exe' && call.args[0] === '/create')).toBe(false)
    const register = f.calls.find((call) => call.script?.includes('LAIXIN_TASK_COMPENSATION_REGISTER'))?.script ?? ''
    const fields = [...register.matchAll(/FromBase64String\('([^']+)'\)/g)].map((match) => Buffer.from(match[1], 'base64').toString('utf8'))
    expect(fields.slice(1)).toEqual(['\\Laixin\\', LABEL])
    expect(f.fallbackCalls).toBe(1)
  })

  it('普通用户无任务注册权限时补偿必须明确失败，不得谎称网络已恢复', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' },
      deleteCode: { [TASKS[1]]: 5 }, registerCode: 5 })
    await expect(runBeforeInstallWrite(f, 'uninstall')).rejects.toThrow(/COMPENSATION_FAILED/)
    expect(f.tasks.get(TASKS[0])).toBe('missing')
    expect(f.fallbackCalls).toBe(1)
  })

  it('持久恢复锁跨 Windows 登录会话且崩溃自动释放，不靠 Local 命名互斥', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    expect(source).toContain('FileShare]::None')
    expect(source).toContain('windows-preflight-recovery.lock')
    expect(source).not.toContain('Local\\\\LaixinToolboxWindowsPreflight')
    expect(source).not.toContain('Global\\\\LaixinToolboxWindowsPreflight')
  })

  it('补偿自己失败也必须完成所有尽力步骤，并明确报补偿失败', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled' },
      terminate: { pid: 102, code: 5 },
      fallbackCode: 5,
      taskRunCode: 5
    })

    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/COMPENSATION_FAILED/)
    expect(f.tasks.get(TASKS[0])).toBe('Enabled')
    expect(f.fallbackCalls).toBe(1)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('schtasks /run 返回 0 但守护没有驻留：不能把通道写成已恢复', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, terminate: { pid: 102, code: 5 },
      taskRunStartsResident: false })
    await expect(runBeforeInstallWrite(f)).rejects.toThrow(/COMPENSATION_FAILED:.*resident-unconfirmed/)
    expect(f.proxyEnabled).toBe(false)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('所有原生命令共享总时限，单步预算不得突破剩余交易窗口', async () => {
    const f = fixture()

    await runBeforeInstallWrite(f)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 5_000)).toBe(true)
  })

  it('每条原生命令都接近 5 秒时，合法的完整卸载序列仍在工作窗口内完成', async () => {
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' }, advanceMsPerCall: 4_900 })

    expect(await runBeforeInstallWrite(f, 'uninstall')).toEqual(['install-directory-write'])
    expect([...f.tasks.values()]).toEqual(['missing', 'missing'])
  })

  it('接近时限的末段失败仍有独立补偿窗口，不会因预算耗尽留下半状态', async () => {
    const f = fixture({
      tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Enabled' },
      deleteCode: { [TASKS[1]]: 5 },
      advanceMsPerCall: 4_900
    })

    await expect(runBeforeInstallWrite(f, 'uninstall')).rejects.toThrow(/DELETE_FAILED/)
    expect([...f.tasks.values()]).toEqual(['Enabled', 'Enabled'])
    expect(f.fallbackCalls).toBe(1)
    expect(f.taskRuns).toEqual([TASKS[0]])
  })

  it('preflight 成功后更新进程立即消失：持久快照可在下一启动恢复原任务并解除死回环', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-recovery-'))
    const guardPid = 998
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled', [TASKS[1]]: 'Disabled' }, guardPid })
    try {
      await helper.windowsPreflight({
        mode: 'update', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
          await writeFile(readyPath, transactionId)
          return guardPid
        }
      }, f.runner)

      const markerPath = join(recoveryDirectory, 'windows-preflight-recovery.json')
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        transactionId: string
        tasks: Array<{ task: string; state: string; xml: string }>
      }
      expect(marker.tasks.map(({ task, state }) => ({ task, state }))).toEqual([
        { task: TASKS[0], state: 'enabled' },
        { task: TASKS[1], state: 'disabled' }
      ])
      expect([...f.tasks.values()]).toEqual(['Disabled', 'Disabled'])
      expect(f.killed.sort()).toEqual([101, 102])
      expect(f.processes.some((process) => process.ProcessId === guardPid)).toBe(true)

      const registerAt = f.calls.findIndex((call) => call.script?.includes('LAIXIN_RECOVERY_REGISTER'))
      const firstDisableAt = f.calls.findIndex((call) => call.file === 'schtasks.exe' && call.args.includes('/disable'))
      expect(registerAt).toBeGreaterThan(-1)
      expect(firstDisableAt).toBeGreaterThan(registerAt)
      const registerScript = f.calls[registerAt]?.script ?? ''
      expect(registerScript).toContain('RegFlushKey')
      expect(registerScript).toContain('CurrentVersion\\Run')
      expect(registerScript).toContain('if(-not (Test-Path -LiteralPath $key -ErrorAction Stop))')
      expect(registerScript).not.toContain('[void](New-Item -Path $key -Force -ErrorAction Stop);')
      const valueBase64 = /FromBase64String\('([^']+)'\)/.exec(registerScript)?.[1] ?? ''
      const runCommand = Buffer.from(valueBase64, 'base64').toString('utf8')
      const rebootConsumer = await readFile(join(recoveryDirectory, 'windows-preflight-recovery.ps1'), 'utf8')
      expect(rebootConsumer).toContain('LAIXIN_PROXY_LEDGER_OWNERSHIP')
      expect(rebootConsumer).toContain('Invoke-ProxyFallback $Marker')
      expect(rebootConsumer).toContain('if(-not (Test-Path -LiteralPath $runKey -ErrorAction Stop))')
      expect(rebootConsumer).not.toMatch(/^\s*\[void\]\(New-Item -Path \$runKey -Force -ErrorAction Stop\)$/m)
      expect(rebootConsumer).toContain('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\'')
      expect(rebootConsumer).not.toContain('CurrentVersion\\RunOnce')
      expect(rebootConsumer).toContain('if(-not (Test-Path -LiteralPath $markerPath)){Unregister-Recovery;exit 0}')
      expect(rebootConsumer).toContain('if($null -ne $current -and [string]::Equals([string]$current.transactionId,$expectedTransaction,[StringComparison]::Ordinal)){Register-Recovery}')
      expect(runCommand).toContain('-File "')
      expect(runCommand).toContain('windows-preflight-recovery.ps1"')
      expect(runCommand).toContain('-Reboot')
      expect(runCommand).not.toContain('-Guard')
      expect(rebootConsumer).toContain('LAIXIN_RECOVERY_NATIVE_COMPENSATE')
      expect(rebootConsumer).not.toContain('$Guard')
      expect(rebootConsumer).toContain('Get-ScheduledTask')
      expect(rebootConsumer).toContain('Register-ScheduledTask')
      expect(rebootConsumer).toContain('Internet Settings')
      const taskLookup = rebootConsumer.slice(
        rebootConsumer.indexOf('function Get-RecoveryTask'),
        rebootConsumer.indexOf('function Disabled-TaskXml')
      )
      expect(taskLookup).toContain('Get-ScheduledTask -ErrorAction Stop')
      expect(taskLookup).not.toContain('SilentlyContinue')
      expect(rebootConsumer).toContain('$failures=@()')
      expect(rebootConsumer).toContain("$failures+='task-prepare:'")
      expect(rebootConsumer).toContain("$failures+='proxy'")
      expect(rebootConsumer).toContain("$failures+='task-finish:'")
      expect(rebootConsumer).toContain("$failures+='resident-unconfirmed'")
      expect(rebootConsumer).not.toContain("'windows-preflight-recover'")
      expect(rebootConsumer).not.toContain('$exe=')
      expect(rebootConsumer).not.toContain(EXECUTABLE)
      expect(rebootConsumer).not.toContain('windows-preflight-watch')
      expect(rebootConsumer).not.toContain('<Task')
      expect(runCommand).not.toContain('<Task')
      expect(runCommand.length).toBeLessThan(260)
      const taskPrepare = rebootConsumer.indexOf('LAIXIN_RECOVERY_TASK_PREPARE')
      const proxyFallback = rebootConsumer.indexOf('LAIXIN_RECOVERY_PROXY_FALLBACK_STEP')
      const taskFinish = rebootConsumer.indexOf('LAIXIN_RECOVERY_TASK_FINISH')
      const durableCommit = rebootConsumer.indexOf('LAIXIN_RECOVERY_COMMIT')
      expect(taskPrepare).toBeGreaterThan(-1)
      expect(proxyFallback).toBeGreaterThan(taskPrepare)
      expect(taskFinish).toBeGreaterThan(proxyFallback)
      expect(durableCommit).toBeGreaterThan(taskFinish)
      expect(markerPath.startsWith(recoveryDirectory)).toBe(true)
      expect(markerPath.toLowerCase()).not.toContain(TARGET.toLowerCase())

      // Simulate process loss: no catch/finally from the first invocation runs. The persisted consumer
      // is invoked as the detached guard would do, and must make the machine safe before deleting proof.
      await expect(helper.recoverWindowsPreflight(markerPath, f.runner, 'wrong-transaction')).rejects.toThrow(/TRANSACTION_MISMATCH/)
      await helper.recoverWindowsPreflight(markerPath, f.runner, marker.transactionId)
      expect([...f.tasks.values()]).toEqual(['Enabled', 'Disabled'])
      expect(f.proxyEnabled).toBe(false)
      expect(f.taskRuns).toEqual([TASKS[0]])
      await expect(access(markerPath)).rejects.toThrow()
      await expect(access(join(recoveryDirectory, 'windows-preflight-recovery.committed'))).resolves.toBeUndefined()
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('看守完成身份核验晚于普通命令 5 秒上限时，仍可确认就绪后继续卸载', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-slow-guard-'))
    const guardPid = 991
    const f = fixture({ guardPid })
    let readyWrite: Promise<void> | undefined
    try {
      await helper.windowsPreflight({
        mode: 'uninstall', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
          readyWrite = new Promise((resolve, reject) => {
            setTimeout(() => { writeFile(readyPath, `${transactionId}:${guardPid}`).then(resolve, reject) }, 5_200)
          })
          return guardPid
        }
      }, f.runner)
      expect(f.calls.every((call) => call.timeoutMs <= 5_000)).toBe(true)
    } finally {
      await readyWrite
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  }, 15_000)

  it('PowerShell 恢复消费者不再承担长驻守卫启动', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-guard-no-compiler-'))
    const guardPid = 992
    const f = fixture({ guardPid })
    let launcher = ''
    try {
      await helper.windowsPreflight({
        mode: 'uninstall', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
          launcher = await readFile(launcherPath, 'utf8')
          await writeFile(readyPath, `${transactionId}:${guardPid}`)
          return guardPid
        }
      }, f.runner)
      expect(launcher).toContain('param([switch]$Reboot,[string]$Transaction)')
      expect(launcher).toContain('if(-not $Reboot){exit 60}')
      expect(launcher).not.toContain('$Guard')
      expect(launcher).not.toContain('LAIXIN_RECOVERY_HANDLE_WAIT')
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('守卫核验失败写入脱敏阶段码，不盲等 20 秒', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-guard-reason-'))
    const f = fixture()
    const reason = 'UPDATE_RECOVERY_GUARD_PROCESS_PATH_MISMATCH'
    try {
      const startedAt = Date.now()
      await expect(helper.windowsPreflight({
        mode: 'uninstall', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ readyPath }) => {
          await writeFile(join(dirname(readyPath), 'windows-preflight-recovery.guard-error'), reason)
          return 992
        }
      }, f.runner)).rejects.toThrow(`UPDATE_RECOVERY_GUARD_FAILED:${reason}`)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(await readFile(join(recoveryDirectory, 'windows-preflight-recovery.guard-error'), 'utf8')).toBe(reason)
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('commit 撤销 Run 失败：保留 marker+commit，由消费者只重试清理而不回滚已确认新版', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-commit-'))
    const guardPid = 997
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, guardPid })
    let rejectUnregister = false
    let rejectedUnregisterScript = ''
    const runner: NativeRunner = async (file, args, options) => {
      const encodedAt = args.findIndex((item) => item === '-EncodedCommand')
      const script = encodedAt >= 0 ? Buffer.from(String(args[encodedAt + 1]), 'base64').toString('utf16le') : ''
      if (rejectUnregister && script.includes('LAIXIN_RECOVERY_UNREGISTER')) {
        rejectedUnregisterScript = script
        return { code: 5, stdout: '', stderr: 'access denied' }
      }
      return f.runner(file, args, options)
    }
    try {
      await helper.windowsPreflight({
        mode: 'update', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
          await writeFile(readyPath, transactionId)
          return guardPid
        }
      }, runner)
      // Model the acknowledged new app having calibrated the resident task before commit.
      f.tasks.set(TASKS[0], 'Enabled')
      f.processes.push({ ProcessId: 4242, Name: 'powershell.exe', ExecutablePath: POWERSHELL })
      const transactionId = JSON.parse(await readFile(join(recoveryDirectory, 'windows-preflight-recovery.json'), 'utf8')).transactionId as string
      await expect(helper.commitWindowsPreflight(recoveryDirectory, runner, 4243, transactionId)).rejects.toThrow(/OWNER_MISMATCH/)
      await expect(helper.commitWindowsPreflight(recoveryDirectory, runner, 4242, 'wrong-transaction')).rejects.toThrow(/OWNER_MISMATCH/)
      rejectUnregister = true
      await expect(helper.commitWindowsPreflight(recoveryDirectory, runner, 4242, transactionId)).rejects.toThrow(/UNREGISTER/)
      expect(rejectedUnregisterScript).toContain('Test-Path -LiteralPath $key -ErrorAction Stop')
      expect(rejectedUnregisterScript).toContain('Get-ItemProperty -LiteralPath $key -ErrorAction Stop')
      expect(rejectedUnregisterScript).not.toContain('Remove-ItemProperty -LiteralPath $key -Name $name -Force -ErrorAction SilentlyContinue')
      const markerPath = join(recoveryDirectory, 'windows-preflight-recovery.json')
      await expect(access(markerPath)).resolves.toBeUndefined()
      await expect(access(join(recoveryDirectory, 'windows-preflight-recovery.committed'))).resolves.toBeUndefined()
      // NSIS must distinguish "commit was never durable" from "commit is durable and cleanup will retry".
      // The latter is safe to continue; aborting here would leave an installed app with its task removed.
      await expect(helper.commitWindowsPreflightCommand(recoveryDirectory, runner, 4242, transactionId)).resolves.toBeUndefined()
      await expect(helper.commitWindowsPreflightCommand(recoveryDirectory, runner, 4243, transactionId)).rejects.toThrow(/OWNER_MISMATCH/)

      rejectUnregister = false
      const fallbackBefore = f.fallbackCalls
      await helper.recoverWindowsPreflight(markerPath, runner, transactionId)
      expect(f.tasks.get(TASKS[0])).toBe('Enabled')
      expect(f.fallbackCalls).toBe(fallbackBefore)
      await expect(access(markerPath)).rejects.toThrow()
      await expect(helper.commitWindowsPreflightCommand(recoveryDirectory, runner, 4242, 'other-transaction'))
        .rejects.toThrow(/MARKER_MISSING|OWNER_MISMATCH/)
      await expect(helper.commitWindowsPreflightCommand(recoveryDirectory, runner, 4242, transactionId))
        .resolves.toBeUndefined()
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('上次已提交但清理断电：新 preflight 先清旧事务，再拍新的任务快照', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-restart-'))
    const guardPid = 995
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, guardPid })
    let failUnregister = false
    const runner: NativeRunner = async (file, args, options) => {
      const encodedAt = args.findIndex((item) => item === '-EncodedCommand')
      const script = encodedAt >= 0 ? Buffer.from(String(args[encodedAt + 1]), 'base64').toString('utf16le') : ''
      if (failUnregister && script.includes('LAIXIN_RECOVERY_UNREGISTER')) {
        return { code: 5, stdout: '', stderr: 'access denied' }
      }
      return f.runner(file, args, options)
    }
    const launchRecoveryGuard = async ({ launcherPath, readyPath, transactionId }: {
      launcherPath: string; readyPath: string; transactionId: string
    }) => {
      const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
      if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
      await writeFile(readyPath, transactionId)
      return guardPid
    }
    try {
      const options: WindowsPreflightOptions = { mode: 'update', target: TARGET, executable: EXECUTABLE,
        residentLabel: LABEL, currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot, launchRecoveryGuard }
      await helper.windowsPreflight(options, runner)
      const markerPath = join(recoveryDirectory, 'windows-preflight-recovery.json')
      const oldTransaction = JSON.parse(await readFile(markerPath, 'utf8')).transactionId as string
      f.tasks.set(TASKS[0], 'Enabled') // The acknowledged new app has restarted its resident task.
      f.processes.push({ ProcessId: 4242, Name: 'powershell.exe', ExecutablePath: POWERSHELL })
      failUnregister = true
      await expect(helper.commitWindowsPreflight(recoveryDirectory, runner, 4242, oldTransaction)).rejects.toThrow(/UNREGISTER/)
      failUnregister = false
      const fallbackBefore = f.fallbackCalls
      await expect(helper.windowsPreflight(options, runner)).resolves.toBeUndefined()
      const newTransaction = JSON.parse(await readFile(markerPath, 'utf8')).transactionId as string
      expect(newTransaction).not.toBe(oldTransaction)
      expect(f.fallbackCalls).toBe(fallbackBefore) // Commit residue never rolls back the live version.
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('上次已武装但进程和看守都已消失：新 preflight 先补偿旧快照再开事务', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-abandoned-'))
    const transactionId = 'old-abandoned-transaction'
    const guardPid = 994
    const f = fixture({ tasks: { [TASKS[0]]: 'Disabled' }, guardPid })
    // A reboot can recycle the old owner PID for another PowerShell process. Path alone is not identity.
    f.processes.push({ ProcessId: 11111, Name: 'powershell.exe', ExecutablePath: POWERSHELL })
    const markerPath = join(recoveryDirectory, 'windows-preflight-recovery.json')
    try {
      await writeFile(markerPath, JSON.stringify({ version: 1, transactionId, mode: 'update', target: TARGET,
        executable: EXECUTABLE, residentLabel: LABEL, ownerPid: 11111, ownerExecutable: POWERSHELL,
        ownerStartFileTime: '132000000000000000', workerPid: 22222, workerExecutable: EXECUTABLE,
        workerStartFileTime: '132000000000000000',
        tasks: [{ task: TASKS[0], state: 'enabled', xml: '<Task><Settings><Enabled>true</Enabled></Settings></Task>' },
          { task: TASKS[1], state: 'missing', xml: '' }] }))
      await writeFile(join(recoveryDirectory, 'windows-preflight-recovery.armed'), JSON.stringify({ version: 1, transactionId }))
      await helper.windowsPreflight({ mode: 'update', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL, recoveryDirectory, now: f.now,
        recoveryOwnerAlive: () => true, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId: newTransaction }) => {
          expect(f.fallbackCalls).toBe(1)
          expect(f.taskRuns).toEqual([TASKS[0]])
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${newTransaction}"`
          await writeFile(readyPath, newTransaction)
          return guardPid
        }
      }, f.runner)
      expect(JSON.parse(await readFile(markerPath, 'utf8')).transactionId).not.toBe(transactionId)
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('恢复标记损坏：安装写入前明确失败，不把未知半事务抹掉', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-invalid-'))
    const f = fixture()
    try {
      await writeFile(join(recoveryDirectory, 'windows-preflight-recovery.json'), '{bad')
      await expect(helper.windowsPreflight({ mode: 'update', target: TARGET, executable: EXECUTABLE,
        residentLabel: LABEL, currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now }, f.runner)).rejects.toThrow(/MARKER_INVALID/)
      expect(f.calls).toEqual([])
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('独立恢复守卫先复制到安装目录外，再以原生进程启动并传入精确身份', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-native-launch-'))
    const guardSourcePath = join(recoveryDirectory, 'packaged-guard.exe')
    const guardPath = join(recoveryDirectory, 'windows-preflight-recovery-guard.exe')
    const child = Object.assign(new EventEmitter(), { pid: 993, unref: vi.fn() })
    const spawnGuard = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    try {
      await writeFile(guardSourcePath, 'native-guard')
      const launch = helper.defaultRecoveryGuardLauncher({
        powershell: POWERSHELL, guardSourcePath, guardPath,
        launcherPath: join(recoveryDirectory, 'windows-preflight-recovery.ps1'),
        readyPath: join(recoveryDirectory, 'windows-preflight-recovery.ready'),
        guardStartPath: join(recoveryDirectory, 'windows-preflight-recovery.guard-started'),
        guardErrorPath: join(recoveryDirectory, 'windows-preflight-recovery.guard-error'),
        marker: {
          ownerPid: 4242, ownerExecutable: POWERSHELL, ownerStartFileTime: START_FILETIME,
          workerPid: 4343, workerExecutable: EXECUTABLE, workerStartFileTime: START_FILETIME
        }, transactionId: 'this-transaction'
      }, spawnGuard)
      await expect(launch).resolves.toBe(993)
      await expect(readFile(guardPath, 'utf8')).resolves.toBe('native-guard')
      expect(spawnGuard).toHaveBeenCalledWith(guardPath,
        ['--laixin-recovery-guard', 'this-transaction'], expect.objectContaining({
          detached: false, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: false,
          env: expect.objectContaining({
            LAIXIN_RECOVERY_GUARD_TRANSACTION: 'this-transaction',
            LAIXIN_RECOVERY_GUARD_OWNER_PID: '4242',
            LAIXIN_RECOVERY_GUARD_OWNER_PATH: POWERSHELL,
            LAIXIN_RECOVERY_GUARD_OWNER_STARTED: START_FILETIME,
            LAIXIN_RECOVERY_GUARD_WORKER_PID: '4343',
            LAIXIN_RECOVERY_GUARD_WORKER_PATH: EXECUTABLE,
            LAIXIN_RECOVERY_GUARD_WORKER_STARTED: START_FILETIME,
            LAIXIN_RECOVERY_GUARD_POWERSHELL: POWERSHELL
          })
        }))
      expect(child.unref).toHaveBeenCalledTimes(1)
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('预编译原生守卫持有并核验两个进程句柄，ready 后才等待，最后短调用恢复脚本', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'windows-recovery-guard.nsi'), 'utf8')
    expect(source).toContain('LAIXIN_RECOVERY_NATIVE_WAIT')
    expect(source).toContain('OpenProcess')
    expect(source).toContain('QueryFullProcessImageNameW')
    expect(source).toContain('GetProcessTimes')
    const secondHandle = source.indexOf("OpenProcess(i 0x101000, i 0, i $WorkerPid)")
    const ready = source.indexOf('!insertmacro WriteRecord "$ReadyPath"')
    const firstWait = source.indexOf('WaitForSingleObject(p R1')
    const secondWait = source.indexOf('WaitForSingleObject(p R2')
    const recovery = source.indexOf('nsExec::ExecToStack')
    expect(secondHandle).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(secondHandle)
    expect(firstWait).toBeGreaterThan(ready)
    expect(secondWait).toBeGreaterThan(firstWait)
    expect(recovery).toBeGreaterThan(secondWait)
    expect(source).not.toContain('Add-Type')
  })

  it('看守无法 spawn 时立即留下脱敏启动失败码，不再伪装为 ready 超时', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-guard-launch-failure-'))
    const guardErrorPath = join(recoveryDirectory, 'windows-preflight-recovery.guard-error')
    const guardSourcePath = join(recoveryDirectory, 'packaged-guard.exe')
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn(), kill: vi.fn() })
    try {
      await writeFile(guardSourcePath, 'native-guard')
      const launch = helper.defaultRecoveryGuardLauncher({
        powershell: POWERSHELL, guardSourcePath,
        guardPath: join(recoveryDirectory, 'windows-preflight-recovery-guard.exe'),
        launcherPath: join(recoveryDirectory, 'windows-preflight-recovery.ps1'),
        readyPath: join(recoveryDirectory, 'windows-preflight-recovery.ready'),
        guardStartPath: join(recoveryDirectory, 'windows-preflight-recovery.guard-started'), guardErrorPath,
        marker: {
          ownerPid: 4242, ownerExecutable: POWERSHELL, ownerStartFileTime: START_FILETIME,
          workerPid: 4343, workerExecutable: EXECUTABLE, workerStartFileTime: START_FILETIME
        }, transactionId: 'this-transaction'
      }, () => {
        queueMicrotask(() => child.emit('error', new Error('spawn failed')))
        return child
      })

      await expect(launch).rejects.toThrow('UPDATE_RECOVERY_GUARD_FAILED:UPDATE_RECOVERY_GUARD_LAUNCH_FAILED')
      await expect(readFile(guardErrorPath, 'utf8')).resolves.toBe('UPDATE_RECOVERY_GUARD_LAUNCH_FAILED')
      expect(child.unref).not.toHaveBeenCalled()
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('NSIS 插件目录的原生 System.dll 不能进入 PowerShell 编译工作目录', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    const mutex = source.slice(source.indexOf('async function acquireWindowsRecoveryMutex'),
      source.indexOf('async function withWindowsRecoveryMutex'))
    const native = source.slice(source.indexOf('function runNative'), source.indexOf('function decodeNativeOutput'))
    const guard = source.slice(source.indexOf('async function defaultRecoveryGuardLauncher'),
      source.indexOf('async function waitForRecoveryGuard'))
    expect(source.includes('WINDOWS_NATIVE_CWD')).toBe(true)
    for (const launcher of [mutex, native, guard]) expect(launcher).toContain('cwd: WINDOWS_NATIVE_CWD')

    const cleanup = await readFile(join(__dirname, '..', '..', 'resources', 'uninstall-task-cleanup.ps1'), 'utf8')
    const setDirectory = cleanup.indexOf('[IO.Directory]::SetCurrentDirectory([Environment]::SystemDirectory)')
    expect(setDirectory).toBeGreaterThan(-1)
    expect(setDirectory).toBeLessThan(cleanup.indexOf('Add-Type'))
  })

  it('看守 PID 相同但命令行身份不符：不得靠裸 PID 排除，必须停止并补偿', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-guard-identity-'))
    const guardPid = 996
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, guardPid })
    try {
      await expect(helper.windowsPreflight({
        mode: 'update', target: TARGET, executable: EXECUTABLE, residentLabel: LABEL,
        currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "stale-transaction"`
          await writeFile(readyPath, transactionId)
          return guardPid
        }
      }, f.runner)).rejects.toThrow(/GUARD_IDENTITY_LOST/)
      expect(f.tasks.get(TASKS[0])).toBe('Enabled')
      expect(f.proxyEnabled).toBe(false)
      expect(f.taskRuns).toEqual([TASKS[0]])
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('继承的 handoff 环境变量必须有活事务、真看守和已收敛任务/进程作证', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-handoff-'))
    const guardPid = 993
    const f = fixture({ tasks: { [TASKS[0]]: 'Enabled' }, guardPid })
    f.processes.push({ ProcessId: process.pid, Name: 'powershell.exe', ExecutablePath: POWERSHELL })
    try {
      await helper.windowsPreflight({ mode: 'update', target: TARGET, executable: EXECUTABLE,
        residentLabel: LABEL, currentPid: 999, ownerPid: process.pid, ownerExecutable: POWERSHELL,
        recoveryDirectory, now: f.now, recoveryIdentitySnapshot,
        launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
          const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
          if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
          await writeFile(readyPath, `${transactionId}:${guardPid}`)
          return guardPid
        }
      }, f.runner)
      const nativeGuard = f.processes.find((item) => item.ProcessId === guardPid)
      if (nativeGuard) {
        const [guardTransaction] = (await readFile(
          join(recoveryDirectory, 'windows-preflight-recovery.ready'), 'utf8'
        )).trim().split(':')
        const guardPath = join(recoveryDirectory, 'windows-preflight-recovery-guard.exe')
        nativeGuard.Name = 'windows-preflight-recovery-guard.exe'
        nativeGuard.ExecutablePath = guardPath
        nativeGuard.CommandLine = `"${guardPath}" --laixin-recovery-guard ${guardTransaction}`
      }
      f.processes.splice(f.processes.findIndex((item) => item.ProcessId === 999), 1)
      await expect(helper.verifyWindowsPreflightHandoff(TARGET, EXECUTABLE, recoveryDirectory, f.runner)).resolves.toBeUndefined()
      f.processes.push({ ProcessId: 777, Name: 'xray.exe', ExecutablePath: null })
      await expect(helper.verifyWindowsPreflightHandoff(TARGET, EXECUTABLE, recoveryDirectory, f.runner)).rejects.toThrow(/IDENTITY_UNKNOWN/)
      f.processes.pop()
      await writeFile(join(recoveryDirectory, 'windows-preflight-recovery.ready'), 'forged:993')
      await expect(helper.verifyWindowsPreflightHandoff(TARGET, EXECUTABLE, recoveryDirectory, f.runner)).rejects.toThrow(/HANDOFF_INVALID/)
    } finally {
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })

  it('两个前置闸并发时第二个在读取/清理旧事务前就被跨进程锁拦住', async () => {
    const recoveryDirectory = await mkdtemp(join(tmpdir(), 'laixin-preflight-mutex-'))
    const guardPid = 992
    const f = fixture({ guardPid })
    let held = false
    const acquireRecoveryMutex = async () => {
      if (held) throw new Error('UPDATE_PREFLIGHT_RECOVERY_BUSY')
      held = true
      return async () => { held = false }
    }
    let releaseLaunch: (() => void) | undefined
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })
    const options: WindowsPreflightOptions = { mode: 'update', target: TARGET, executable: EXECUTABLE,
      residentLabel: LABEL, currentPid: 999, ownerPid: 4242, ownerExecutable: POWERSHELL,
      recoveryDirectory, now: f.now, acquireRecoveryMutex, recoveryIdentitySnapshot,
      launchRecoveryGuard: async ({ launcherPath, readyPath, transactionId }) => {
        await launchGate
        const guard = f.processes.find((process) => process.ProcessId === guardPid) as { CommandLine?: string } | undefined
        if (guard) guard.CommandLine = `"${POWERSHELL}" -File "${launcherPath}" -Guard -Transaction "${transactionId}"`
        await writeFile(readyPath, transactionId)
        return guardPid
      } }
    try {
      const first = helper.windowsPreflight(options, f.runner)
      for (let i = 0; i < 100 && !await access(join(recoveryDirectory, 'windows-preflight-recovery.json')).then(() => true, () => false); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const callsBefore = f.calls.length
      await expect(helper.windowsPreflight(options, f.runner)).rejects.toThrow(/RECOVERY_BUSY/)
      expect(f.calls).toHaveLength(callsBefore)
      releaseLaunch?.()
      await first
    } finally {
      releaseLaunch?.()
      await rm(recoveryDirectory, { recursive: true, force: true })
    }
  })
})

describe('真实入口守卫', () => {
  it('PowerShell 助手先校验并完整备份，再调用前置闸；检查超时和退出码', async () => {
    const source = (await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.ps1'))).toString('utf8').replace(/^\uFEFF/, '')
    const preflight = source.indexOf('  $preflightTransaction = Invoke-WindowsPreflight')
    const digest = source.indexOf('Get-FileHash -LiteralPath $job.installer')
    const backup = source.indexOf('Copy-Item -LiteralPath $job.target')
    expect(preflight).toBeGreaterThan(-1)
    expect(digest).toBeGreaterThan(-1)
    expect(backup).toBeGreaterThan(digest)
    expect(preflight).toBeGreaterThan(backup)
    expect(source).toContain('$preflight.WaitForExit(185000)')
    expect(source).toContain('$preflight.Kill()')
    expect(source).not.toContain('Stop-Process -Id $preflight.Id')
    expect(source).toContain('$preflight.WaitForExit(5000)')
    expect(source).toContain('$preflight.ExitCode -ne 0')
    expect(source).toContain('LAIXIN_PREFLIGHT_OWNER_PID')
  })

  it('更新助手把已完成的前置闸交给 NSIS，且绝不在安装器仍运行时返回或回滚', async () => {
    const source = (await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.ps1'))).toString('utf8').replace(/^\uFEFF/, '')
    const preflight = source.indexOf('  $preflightTransaction = Invoke-WindowsPreflight')
    const handoff = source.indexOf('$env:LAIXIN_PREFLIGHT_HANDOFF_TARGET =')
    const start = source.indexOf('Start-Process -FilePath $job.installer')
    const wait = source.indexOf('$installer.WaitForExit()')
    const exitCode = source.indexOf('$installer.ExitCode -ne 0')
    expect(preflight).toBeGreaterThan(-1)
    expect(handoff).toBeGreaterThan(preflight)
    expect(start).toBeGreaterThan(handoff)
    expect(wait).toBeGreaterThan(start)
    expect(exitCode).toBeGreaterThan(wait)
    expect(source).not.toMatch(/WaitForExit\(180000\)[^\r\n]*Write-Result[^\r\n]*exit 1/)
    expect(source).toContain('$env:LAIXIN_PREFLIGHT_HANDOFF_TARGET = $previousPreflightHandoff')
    const acknowledgement = source.indexOf('if (-not $acknowledged)')
    const commit = source.indexOf('Invoke-WindowsPreflightCommit $preflightTransaction', acknowledgement)
    const removeBackup = source.indexOf('Remove-Item -LiteralPath $backup -Recurse', commit)
    expect(commit).toBeGreaterThan(acknowledgement)
    expect(removeBackup).toBeGreaterThan(commit)
    expect(source).toContain("if ($commit.ExitCode -ne 0) { throw 'UPDATE_PREFLIGHT_COMMIT_FAILED' }")
    expect(source).toContain('[void]$commit.WaitForExit()')
    expect(source).not.toContain('$commit.WaitForExit(15000)')
    expect(source).toContain('if ($acknowledged -and $null -ne $started) {')
  })

  it('NSIS 只在真卸载调用前置闸；已装目标在安装入口先拒绝，不再全局杀 xray', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    expect(source).toContain('windows-preflight ${MODE}')
    expect(source).toContain('!insertmacro runLaixinWindowsPreflight update')
    expect(source).toContain('!insertmacro runLaixinWindowsPreflight uninstall')
    const preflightStart = source.indexOf('!macro runLaixinWindowsPreflight')
    const preflightMacro = source.slice(preflightStart, source.indexOf('!macroend', preflightStart))
    expect(preflightMacro).toMatch(/nsExec::ExecToLog[^\r\n]+\r?\n\s*Pop \$7/)
    expect(preflightMacro).not.toContain('Abort')
    expect(preflightMacro).toContain('LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY')
    expect(preflightMacro).toContain('LAIXIN_PREFLIGHT_OWNER_PID')
    expect(preflightMacro).toContain('LAIXIN_PREFLIGHT_OWNER_EXECUTABLE')
    const uninstallMacro = source.slice(source.indexOf('!macro customUnInstall'), source.indexOf('!macroend', source.indexOf('!macro customUnInstall')))
    expect(uninstallMacro).toContain('${GetOptions} $3 "/S" $4')
    expect(uninstallMacro).toContain('关闭所有来信 AI 工具箱的安装和卸载窗口')
    expect(uninstallMacro).toContain('一键诊断')
    expect(uninstallMacro).not.toContain('退出码 $7')
    const initMacro = source.slice(source.indexOf('!macro customInit'), source.indexOf('!macroend', source.indexOf('!macro customInit')))
    expect(initMacro).toMatch(/\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}[\s\S]+SetErrorLevel 1[\s\S]+Abort/)
    expect(initMacro).not.toContain('runLaixinWindowsPreflight')
    expect(initMacro).toContain('先完成或关闭正在进行的卸载')
    expect(initMacro).toContain('关闭所有来信 AI 工具箱的安装和卸载窗口')
    expect(initMacro).toContain('为保护现有程序，本次未开始覆盖')
    expect(source).not.toMatch(/taskkill(?:\.exe)?[^\r\n]*\/im\s+"?xray\.exe/i)
    expect(source).not.toMatch(/taskkill(?:\.exe)?[^\r\n]*\/im\s+"?\$\{APP_EXECUTABLE_FILENAME\}/i)
    const helperSource = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    const guardSource = await readFile(join(__dirname, '..', '..', 'build', 'windows-recovery-guard.nsi'), 'utf8')
    expect(helperSource).toContain("'windows-preflight-recovery-guard.exe'")
    expect(helperSource).toContain("includes('--laixin-recovery-guard')")
    expect(guardSource).toContain('LAIXIN_RECOVERY_NATIVE_WAIT')
    expect(guardSource).toContain('WaitForSingleObject')
    expect(guardSource).toContain('GetProcessTimes')
  })

  it('卸载确认后立即运行预检，禁任务和停进程结果交给删除文件前的钩子', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    const check = source.slice(source.indexOf('!macro customCheckAppRunning'),
      source.indexOf('!macroend', source.indexOf('!macro customCheckAppRunning')))
    expect(source.slice(0, source.indexOf('!macro customCheckAppRunning'))).toContain('!ifdef BUILD_UNINSTALLER')
    expect(check).not.toContain('_CHECK_APP_RUNNING')
    expect(check).toContain('!insertmacro runLaixinWindowsPreflight uninstall')
    expect(check).toContain('StrCpy $laixinEarlyUninstallTarget "$INSTDIR"')
    expect(check).toContain('StrCpy $laixinEarlyUninstallPreflight $7')
    const uninstall = source.slice(source.indexOf('!macro customUnInstall'),
      source.indexOf('!macroend', source.indexOf('!macro customUnInstall')))
    expect(uninstall).toContain('!insertmacro runLaixinWindowsPreflight uninstall')
    expect(uninstall).toContain('lstrcmpiW(w "$laixinEarlyUninstallTarget", w "$INSTDIR")')
    expect(uninstall).toContain('StrCpy $7 $laixinEarlyUninstallPreflight')

    const root = dirname(requireFromTest.resolve('app-builder-lib/package.json'))
    const template = await readFile(join(root, 'templates', 'nsis', 'uninstaller.nsh'), 'utf8')
    expect(template.indexOf('!insertmacro customUnInstall')).toBeLessThan(template.indexOf('# delete the installed files'))
    const installer = await readFile(join(root, 'templates', 'nsis', 'include', 'allowOnlyOneInstallerInstance.nsh'), 'utf8')
    expect(installer).toContain('!ifmacrodef customCheckAppRunning')
  })

  it('持久化重命名由当前 Node 进程直调 MoveFileExW，并保留 Win32 错误码', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'resources', 'update-helper.cjs'), 'utf8')
    const rename = source.slice(source.indexOf('async function writeThroughRename'), source.indexOf('function decodeBase64PowerShell'))
    expect(rename).toContain("koffi.load('kernel32.dll')")
    expect(rename).toContain('MoveFileExW')
    expect(rename).toContain('GetLastError')
    expect(rename).not.toContain('runNative(powershell')
    expect(rename).toContain('UPDATE_RECOVERY_DURABLE_RENAME_FAILED')
    expect(source).toContain('WIN32_${win32Error}')
  })

  it('真卸载主 EXE 缺失也先清任务、走账本恢复尝试和代理兜底，不得在恢复前 Abort', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    const start = source.indexOf('!macro customUnInstall')
    const end = source.indexOf('!macroend', start)
    const body = source.slice(start, end)
    const existsGuard = body.indexOf('${If} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    const missing = body.indexOf('${Else}', existsGuard)
    const missingBranch = body.slice(missing, body.indexOf('${EndIf}', missing) + '${EndIf}'.length)
    const taskCleanup = body.indexOf('schtasks.exe /delete', missing)
    const restore = body.indexOf('tunnel-daemon.mjs" restore')
    const fallback = body.indexOf('-ProxyFallbackOnly')
    const abort = /^\s*Abort\s*$/m.exec(body)?.index ?? -1
    expect(existsGuard).toBeGreaterThan(-1)
    expect(missing).toBeGreaterThan(existsGuard)
    expect(body.slice(missing, restore)).toContain('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File')
    expect(body.slice(missing, restore)).toMatch(/nsExec::ExecToLog[^\r\n]+\r?\n\s*Pop \$7/)
    expect(missingBranch).not.toMatch(/Pop \$7[\s\S]*StrCpy \$7\s+"0"/)
    expect(body).toContain('File /oname=laixin-uninstall-task-cleanup.ps1')
    const cleanup = await readFile(join(__dirname, '..', '..', 'resources', 'uninstall-task-cleanup.ps1'), 'utf8')
    expect(cleanup.match(/Get-ScheduledTask/g)).toHaveLength(2)
    expect(cleanup).toContain('Unregister-ScheduledTask')
    expect(cleanup).toMatch(/if \(\$left\.Count -ne 0\) \{ exit 1 \}/)
    expect(cleanup).toContain('LAIXIN_UNINSTALL_PROXY_FALLBACK')
    expect(cleanup).toContain('InternetSetOption')
    expect(cleanup).toMatch(/if \(\$mustDisable -and \[int\]\$after\.ProxyEnable -ne 0\) \{ exit 2 \}/)
    expect(taskCleanup === -1 || taskCleanup > missing).toBe(true)
    expect(restore).toBeGreaterThan(taskCleanup)
    expect(fallback).toBeGreaterThan(restore)
    expect(body.slice(fallback)).toMatch(/-ProxyFallbackOnly[^\r\n]*\r?\n\s*Pop \$0/)
    expect(body.slice(fallback)).toMatch(/\$0 != "0"[\s\S]*StrCpy \$7 \$0/)
    expect(abort).toBeGreaterThan(fallback)
  })

  it('安装入口在旧卸载器之前拒绝覆盖，静默安装非零退出且不弹阻塞框', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    const initStart = source.indexOf('!macro customInit')
    const initEnd = source.indexOf('!macroend', initStart)
    const init = source.slice(initStart, initEnd)
    const uninstallStart = source.indexOf('!macro customUnInstall')
    const uninstallEnd = source.indexOf('!macroend', uninstallStart)
    const uninstall = source.slice(uninstallStart, uninstallEnd)
    const installStart = source.indexOf('!macro customInstall')
    const installEnd = source.indexOf('!macroend', installStart)
    const install = source.slice(installStart, installEnd)

    expect(source).toContain('LAIXIN_PREFLIGHT_HANDOFF_TARGET')
    expect(source).toContain('windows-preflight-handoff')
    expect(source).toContain('lstrcmpiW')
    expect(init).toContain('${If} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(init).toMatch(/\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}[\s\S]+IfSilent \+2[\s\S]+MessageBox MB_OK\|MB_ICONSTOP[\s\S]+SetErrorLevel 1[\s\S]+Abort/)
    expect(init).not.toContain('runLaixinWindowsPreflight')
    expect(init).toContain('readLaixinWindowsPreflightHandoff $R7')
    expect(init).toMatch(/\$R7 != "1"[\s\S]+SetErrorLevel 1[\s\S]+Abort/)
    expect(init).toContain('为保护现有程序，本次未开始覆盖')
    expect(uninstall).toMatch(/\$5 == "uninstall"[\s\S]*runLaixinWindowsPreflight uninstall/)
    expect(uninstall).toMatch(/readLaixinWindowsPreflightHandoff[\s\S]*\$R9 == "1"[\s\S]*StrCpy \$7 "0"[\s\S]*runLaixinWindowsPreflight update/)
    expect(install).toContain('clearLaixinWindowsPreflightHandoff')

    const root = dirname(requireFromTest.resolve('app-builder-lib/package.json'))
    const installer = await readFile(join(root, 'templates', 'nsis', 'installer.nsi'), 'utf8')
    const section = await readFile(join(root, 'templates', 'nsis', 'installSection.nsh'), 'utf8')
    const installUtil = await readFile(join(root, 'templates', 'nsis', 'include', 'installUtil.nsh'), 'utf8')
    const onInit = installer.slice(installer.indexOf('Function .onInit'), installer.indexOf('FunctionEnd', installer.indexOf('Function .onInit')))
    expect(onInit).toContain('!insertmacro customInit')
    expect(section.indexOf('!insertmacro uninstallOldVersion')).toBeGreaterThan(-1)
    expect(installUtil).toContain('ExecWait \'"$uninstallerFileNameTemp"')
    expect(installUtil).toContain('${if} $R5 > 5')
  })

  it('残缺旧安装主 EXE 已丢但登记仍在：无法验证 handoff 就在旧卸载器前拦截', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    const init = source.slice(source.indexOf('!macro customInit'), source.indexOf('!macroend', source.indexOf('!macro customInit')))
    for (const [key, value] of [['INSTALL_REGISTRY_KEY', 'InstallLocation'], ['UNINSTALL_REGISTRY_KEY', 'UninstallString'],
      ['UNINSTALL_REGISTRY_KEY_2', 'UninstallString']] as const) {
      expect(init).toContain(`ReadRegStr $R9 SHELL_CONTEXT "\${${key}}" ${value}`)
    }
    expect(init).toContain('!ifdef UNINSTALL_REGISTRY_KEY_2')
    expect(init.match(/\$R9 != ""[\s\S]*?StrCpy \$R8 "1"/g)).toHaveLength(3)
    expect(init).toMatch(/\$R8 == "1"[\s\S]+readLaixinWindowsPreflightHandoff \$R7[\s\S]+\$R7 != "1"[\s\S]+SetErrorLevel 1[\s\S]+Abort/)
    expect(init).not.toContain('runLaixinWindowsPreflight')
  })

  it('0.6.1 首跳有据：更新助手交接由新安装器和旧卸载器共同复验', async () => {
    const root = dirname(requireFromTest.resolve('app-builder-lib/package.json'))
    const template = await readFile(join(root, 'templates', 'nsis', 'include', 'installUtil.nsh'), 'utf8')
    const copyOld = template.indexOf('!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"')
    const runOld = template.indexOf('ExecWait \'"$uninstallerFileNameTemp"')
    expect(copyOld).toBeGreaterThan(-1)
    expect(runOld).toBeGreaterThan(copyOld)
    expect(template.slice(0, runOld)).toContain('StrCpy $0 "$0 --updated"')

    const installer = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
    expect(installer).toContain('0.6.1 更新助手')
    expect(installer).toContain('readLaixinWindowsPreflightHandoff $R7')
    expect(installer).toMatch(/readLaixinWindowsPreflightHandoff \$R7[\s\S]*\$R7 != "1"[\s\S]*Abort/)
  })
})
