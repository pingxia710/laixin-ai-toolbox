// 甲-10:bootstrap 失败后刚写的 plist 必须回滚——孤儿描述文件带 RunAtLoad,下次登录 launchd
// 会自己加载:工具箱记着「没装上」,系统却武装了;重开工具箱的初值探测(probeInstalled 只看
// plist 在不在)也会把它当已装,第一次点连接可能静默落空。
// 回滚只限「这次新写的」:软卸载(net-2)留下的、内容一致且等下次登录加载的定义 ⛔ 替它清场——
// 它是孤儿 plist 唯一的清除者。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 进程内假 launchctl:记录所有调用,print 按 control.loaded 应答,bootstrap 按 control.failBootstrap 失败。
// homedir 指到临时目录,⛔ 碰真实 ~/Library/LaunchAgents。
const control = vi.hoisted(() => ({
  home: '',
  calls: [] as Array<{ file: string; args: string[] }>,
  loaded: true,
  failBootstrap: false
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
    const kind = (args as string[])[0]
    // macResidentLoaded 以「print 是否成功」为准:未加载时 print 必须失败,⛔ 只清空 stdout
    const fail = (file === 'launchctl' && kind === 'bootstrap' && control.failBootstrap) ||
      (file === 'launchctl' && kind === 'print' && !control.loaded)
    return {
      error: fail ? new Error(`Command failed: ${file} ${kind}`) : null,
      stdout: kind === 'print' && control.loaded ? 'loaded\n' : ''
    }
  }
  // resident.ts 走 promisify(execFile):假桩必须带上 node 自己那个 custom promisify
  // (解构 { stdout, stderr }),⛔ 靠泛型 promisify——它会把 (err, stdout, stderr) 摊成数组。
  const runFake = (file: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const { error, stdout } = respond(file, args as string[])
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

import { RESIDENT_LABEL, installMacResident, macAgentPlist } from '../../app/main/tunnel/platform/resident'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach(removeTempDir)
  control.calls.length = 0
  control.loaded = true
  control.failBootstrap = false
})

const plistPath = () => join(control.home, 'Library', 'LaunchAgents', `${RESIDENT_LABEL}.plist`)

const spec = {
  executable: '/Applications/来信AI工具箱.app/Contents/MacOS/来信AI工具箱',
  args: ['daemon.mjs', 'start', '--resident', '1'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  logDir: '/tmp/laixin-jia10-logs'
}

const bootstrapCalls = () => control.calls.filter((call) => call.file === 'launchctl' && call.args[0] === 'bootstrap')

describe('installMacResident:bootstrap 失败回滚这次新写的 plist', () => {
  it('全新安装,bootstrap 被拒:plist 不留盘上,installed:false(基线:孤儿描述文件武装到下次登录)', async () => {
    control.home = makeTempDir('jia10-rollback-')
    roots.push(control.home)
    control.loaded = false
    control.failBootstrap = true

    const outcome = await installMacResident(spec, RESIDENT_LABEL)

    expect(bootstrapCalls().length).toBe(1)
    expect(outcome.installed).toBe(false)
    expect(existsSync(plistPath())).toBe(false)
  })

  it('盘上有旧内容描述文件,这次换装失败:一并清掉(新内容是我们写的,留下=旧参数武装到下次登录)', async () => {
    control.home = makeTempDir('jia10-rollback-stale-')
    roots.push(control.home)
    mkdirSync(join(control.home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath(), '<plist>上一版的旧参数</plist>')
    control.loaded = false
    control.failBootstrap = true

    const outcome = await installMacResident(spec, RESIDENT_LABEL)

    expect(outcome.installed).toBe(false)
    expect(existsSync(plistPath())).toBe(false)
  })

  it('盘上的描述文件与要装的一字不差(软卸载留下的下次登录定义):bootstrap 失败也 ⛔ 删——那是 net-2 的场', async () => {
    control.home = makeTempDir('jia10-rollback-soft-')
    roots.push(control.home)
    mkdirSync(join(control.home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath(), macAgentPlist(spec, RESIDENT_LABEL))
    control.loaded = false
    control.failBootstrap = true

    const outcome = await installMacResident(spec, RESIDENT_LABEL)

    expect(outcome.installed).toBe(false)
    expect(existsSync(plistPath())).toBe(true)
  })

  it('软路径(活实例 + leaveRunningInstance)从不走到 bootstrap,失败注入也碰不到它(护栏)', async () => {
    control.home = makeTempDir('jia10-rollback-live-')
    roots.push(control.home)
    control.loaded = true
    control.failBootstrap = true

    const outcome = await installMacResident(spec, RESIDENT_LABEL, { leaveRunningInstance: true })

    expect(outcome.installed).toBe(true)
    expect(bootstrapCalls()).toEqual([])
    expect(existsSync(plistPath())).toBe(true)
  })

  it('bootstrap 成功:描述文件照常在,installed:true(护栏,基线即绿)', async () => {
    control.home = makeTempDir('jia10-rollback-ok-')
    roots.push(control.home)
    control.loaded = false
    control.failBootstrap = false

    const outcome = await installMacResident(spec, RESIDENT_LABEL)

    expect(outcome.installed).toBe(true)
    expect(existsSync(plistPath())).toBe(true)
  })
})
