// A3:mac 校验子进程无超时、stdin 是永不写入的管道 ⇒ hdiutil 遇带许可协议的 DMG 永挂,
// 任务停在「校验中」只能重启工具箱。这里用假 hdiutil(真的 /bin/sleep 999)证明:
// 取消能立刻杀掉子进程,且每条校验命令都带超时 + SIGKILL。
import type * as NodeChildProcess from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type * as NodeUtil from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spy = vi.hoisted(() => ({
  calls: [] as Array<{ command: string, options: Record<string, unknown> }>,
  children: [] as ChildProcess[],
  // 只把生产时限压短,好在用例里真触发 execFile 的超时杀进程;⛔ 改超时之外的任何选项。
  overrideTimeoutMs: undefined as number | undefined
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process')
  const { promisify } = await vi.importActual<typeof NodeUtil>('node:util')
  // attach → 挂住且**忽略 SIGTERM** 的真进程(只有 SIGKILL 杀得掉):Node 的 AbortSignal
  // 中止只发 SIGTERM 且会清掉 execFile 自带的 SIGKILL 兜底,拿 /bin/sleep 是验不出来的。
  // detach → 立刻成功,保持用例不碰真镜像。
  const rewrite = (command: string, args: readonly string[]): readonly [string, readonly string[]] => {
    if (command !== '/usr/bin/hdiutil') return [command, args]
    return args[0] === 'attach' ? ['/bin/sh', ['-c', 'trap "" TERM; exec sleep 999']] : ['/usr/bin/true', []]
  }
  const execFile = ((command: string, args: readonly string[], options: Record<string, unknown>, callback: never) => {
    spy.calls.push({ command, options })
    const [target, targetArgs] = rewrite(command, args)
    const patched = spy.overrideTimeoutMs === undefined ? options : { ...options, timeout: spy.overrideTimeoutMs }
    const child = (actual.execFile as unknown as (...rest: unknown[]) => ChildProcess)(target, targetArgs, patched, callback)
    spy.children.push(child)
    return child
  }) as unknown as typeof NodeChildProcess.execFile
  Object.defineProperty(execFile, promisify.custom, {
    value: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      let child: ChildProcess | undefined
      const promise = new Promise((resolve, reject) => {
        child = (execFile as unknown as (...rest: unknown[]) => ChildProcess)(command, args, options,
          (error: unknown, stdout: string, stderr: string) => { if (error) reject(error); else resolve({ stdout, stderr }) })
      }) as Promise<unknown> & { child?: ChildProcess }
      promise.child = child
      return promise
    }
  })
  return { ...actual, execFile }
})

afterEach(() => {
  for (const child of spy.children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  spy.calls.length = 0; spy.children.length = 0; spy.overrideTimeoutMs = undefined
})

// 等子进程真的退出;3 秒还活着就算没死。⛔ 用 child.killed 代替(那只说明「信号发过」)。
async function exited(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_000)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

describe('mac 校验命令超时与取消', () => {
  it('校验挂住时取消立刻杀掉子进程；每条命令都带超时与 SIGKILL', async () => {
    const { MacArtifactInspector } = await import('../../app/main/download/mac-artifact')
    const root = await mkdtemp('/private/tmp/laixin-toolbox-verify-')
    const artifactPath = join(root, 'Hermes.dmg')
    await writeFile(artifactPath, 'fixture')

    const controller = new AbortController()
    const started = Date.now()
    const inspection = new MacArtifactInspector().inspect({ artifactPath, format: 'dmg', signal: controller.signal })
    // 等假 hdiutil 真的起来,再取消。
    await new Promise((resolve) => setTimeout(resolve, 100))
    const attachChild = spy.children[0]
    expect(attachChild.exitCode).toBeNull()
    controller.abort()

    await expect(inspection).resolves.toEqual({ kind: 'not-installer', identity: null })
    expect(Date.now() - started).toBeLessThan(10_000)
    // 必须真的死掉,⛔ 只看 child.killed —— 发过信号它就是 true,哪怕对方把信号无视掉。
    await expect(exited(attachChild)).resolves.toBe(true)
    expect(attachChild.signalCode).toBe('SIGKILL')

    const attachCall = spy.calls.find((call) => call.command === '/usr/bin/hdiutil')
    expect(attachCall?.options.timeout).toBeGreaterThan(0)
    expect(attachCall?.options.killSignal).toBe('SIGKILL')
  }, 20_000)

  it('命令超时抛受控的超时码，⛔ 被吞成「不是安装包」', async () => {
    const { MacArtifactInspector } = await import('../../app/main/download/mac-artifact')
    const { isVerifyTimeout } = await import('../../app/main/download/types')
    const root = await mkdtemp('/private/tmp/laixin-toolbox-verify-')
    const artifactPath = join(root, 'Hermes.dmg')
    await writeFile(artifactPath, 'fixture')
    spy.overrideTimeoutMs = 300

    // 判不出来 ≠ 判定「不是安装包」:后者会让管理器把已下载好的文件删掉要客户重下。
    const inspection = new MacArtifactInspector().inspect({ artifactPath, format: 'dmg' })
    await expect(inspection).rejects.toSatisfy(isVerifyTimeout)
    // 超时同样要把子进程杀掉,⛔ 留孤儿。
    await expect(exited(spy.children[0])).resolves.toBe(true)
  }, 20_000)
})
