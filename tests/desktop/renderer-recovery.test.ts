// 收敛包3·件3:渲染进程崩溃自愈逻辑 + 主进程顶层异常落盘。
import { describe, expect, it } from 'vitest'
import { createMainCrashLog, createRendererRecovery, RENDERER_CRASH_CALM_MS } from '../../app/main/desktop/renderer-recovery'

function makeDeps() {
  const calls: string[] = []
  return {
    calls,
    deps: {
      reload: () => calls.push('reload'),
      notify: (message: string) => calls.push(`notify:${message}`),
      showDialog: (title: string, message: string, detail: string) => calls.push(`dialog:${title}|${message}|${detail}`),
      now: (() => 0) as () => number
    }
  }
}

describe('渲染进程崩溃自愈(收敛包3·件3)', () => {
  it('第一次崩溃:自动 reload 一次并提示', () => {
    const { calls, deps } = makeDeps()
    const recovery = createRendererRecovery(deps)
    recovery.handle({ reason: 'crashed', exitCode: -1 })
    expect(calls).toEqual(['reload', 'notify:界面出现异常，已自动恢复；若反复出现请查看设置里的诊断信息'])
  })

  it(`平静期(${RENDERER_CRASH_CALM_MS}ms)内连续崩溃:停止 reload,给可复制的诊断信息`, () => {
    const { calls, deps } = makeDeps()
    let now = 0
    deps.now = () => now
    const recovery = createRendererRecovery(deps)
    recovery.handle({ reason: 'crashed', exitCode: -1 })
    now += 1_000
    recovery.handle({ reason: 'oom', exitCode: -2 })
    expect(calls.filter((call) => call === 'reload')).toHaveLength(1)
    const dialog = calls.find((call) => call.startsWith('dialog:'))
    expect(dialog).toContain('界面连续异常')
    expect(dialog).toContain('连续崩溃次数:2')
    expect(dialog).toContain('原因:oom')
    expect(dialog).toContain('退出码:-2')
  })

  it('相隔超过平静期的再次崩溃视为新的一次:恢复自动 reload', () => {
    const { calls, deps } = makeDeps()
    let now = 0
    deps.now = () => now
    const recovery = createRendererRecovery(deps)
    recovery.handle({ reason: 'crashed', exitCode: -1 })
    now += RENDERER_CRASH_CALM_MS + 1
    recovery.handle({ reason: 'crashed', exitCode: -1 })
    expect(calls.filter((call) => call === 'reload')).toHaveLength(2)
    expect(calls.some((call) => call.startsWith('dialog:'))).toBe(false)
  })
})

describe('主进程顶层异常落盘(收敛包3·件3)', () => {
  it('uncaughtException / unhandledRejection 都按行追加进日志文件', () => {
    const lines: string[] = []
    const log = createMainCrashLog((line) => lines.push(line), () => 1_700_000_000_000)
    log('uncaughtException', new Error('主进程炸了'))
    log('unhandledRejection', '字符串原因')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[uncaughtException]')
    expect(lines[0]).toContain('主进程炸了')
    expect(lines[1]).toContain('[unhandledRejection]')
    expect(lines[1]).toContain('字符串原因')
  })

  it('append 抛错不向外传播(日志失败不能再生异常)', () => {
    const log = createMainCrashLog(() => { throw new Error('磁盘满') })
    expect(() => log('uncaughtException', new Error('x'))).not.toThrow()
  })
})
