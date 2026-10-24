// N-23 步骤6:用户级环境变量(HKCU\Environment)的写入与广播,慢机节奏治理。
// 09-18 真机(HUAWEI):每变量各起一次 PowerShell 广播(15s 超时×2 次重试),杀软冷启动下一个 30-40s——
// 四个变量一轮就是 2 分多钟,把整轮 restore+apply 拖进「修复必然超时」。修法:
//  ① 一个同步写入批次(一次 apply/restore 的全部变量)只在批次末广播一次;
//  ② 每项写入落计时日志(慢在哪个变量、慢了多少,客服看得到);
//  ③ 子进程命令超时给独立受控码 TERMINAL_ENVIRONMENT_COMMAND_TIMEOUT(⛔ 与「注册表不可读」混同一归因)。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalEnvironmentAdapter,
  type TerminalEnvironmentAdapter,
  type TerminalProxy
} from '../../sidecar/win/terminal-environment.mjs'
import { makeTempDir, removeTempDir } from './helpers'

// 只在超时码这条用例里生效:defaultRun 的 execFileSync 抛真实超时形状(killed+SIGTERM)。
// 其余用例的适配器全部注入 run,不经这里。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, execFileSync: () => {
    throw Object.assign(new Error('spawnSync reg.exe ETIMEDOUT'), { killed: true, signal: 'SIGTERM' })
  } }
})

const PROXY: TerminalProxy = { host: '127.0.0.1', port: 18080 }

interface EnvironmentValue { type: 'REG_SZ' | 'REG_EXPAND_SZ'; data: string }

function fakeRegistry(environment: Map<string, EnvironmentValue>, delayMs = 0) {
  const sleep = (ms: number) => { if (ms > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } }
  return (command: string, args: readonly string[]) => {
    if (command !== 'reg.exe') throw new Error('UNEXPECTED_COMMAND')
    sleep(delayMs)
    const name = args.includes('/v') ? args[args.indexOf('/v') + 1] : undefined
    if (args[0] === 'query') {
      return ['\r\nHKCU\\Environment\r\n',
        ...[...environment.entries()].map(([key, value]) => `    ${key}    ${value.type}    ${value.data}\r\n`)].join('')
    }
    if (args[0] === 'add') {
      const type = args[args.indexOf('/t') + 1] as EnvironmentValue['type']
      const data = args[args.indexOf('/d') + 1]
      if (name === undefined || data === undefined) throw new Error('REG_ADD_INVALID')
      environment.set(name, { type, data })
      return ''
    }
    if (args[0] === 'delete') {
      if (name === undefined) throw new Error('REG_DELETE_INVALID')
      environment.delete(name)
      return ''
    }
    throw new Error('UNEXPECTED_REG_OPERATION')
  }
}

describe('用户级环境变量:合批广播＋计时日志＋命令超时独立码(N-23)', () => {
  let root: string
  let home: string
  let environment: Map<string, EnvironmentValue>

  beforeEach(() => {
    root = makeTempDir('laixin-user-env-batch-')
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    environment = new Map()
  })
  afterEach(() => removeTempDir(root))

  const build = (options: {
    notify?: () => void
    delayMs?: number
    log?: (line: string) => void
  } = {}) => createTerminalEnvironmentAdapter({
    enabled: true, home,
    run: fakeRegistry(environment, options.delayMs ?? 0),
    notifyEnvironmentChanged: options.notify ?? (() => undefined),
    ...(options.log !== undefined ? { log: options.log } : {})
  })

  const envItems = (adapter: TerminalEnvironmentAdapter) =>
    adapter.managedItems(PROXY).filter((item) => item.ref.item.startsWith('win-user-env-'))

  it('一个同步写入批次只在批次末广播一次(基线:每个变量各广播一次;慢机上四个 PowerShell 各 30-40s)', async () => {
    let notifyCount = 0
    const adapter = build({ notify: () => { notifyCount += 1 } })
    for (const item of envItems(adapter)) adapter.write(item.ref, item.value)
    // 同步批次内零广播:广播欠着,批次结束只发一次,覆盖全部四个变量
    expect(notifyCount).toBe(0)
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBe(1)
    expect(environment.size).toBe(4)
    // 下一个独立批次再欠再发一次
    for (const item of envItems(adapter)) adapter.write(item.ref, item.value)
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBe(2)
  })

  it('每项写入落计时日志:慢写入可见「哪个变量、多少毫秒」(基线:慢在哪一环无从判断)', async () => {
    const lines: string[] = []
    const adapter = build({ log: (line) => lines.push(line) })
    const item = envItems(adapter).find((candidate) => candidate.ref.item === 'win-user-env-http-proxy')
    expect(item).toBeDefined()
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_025)
    adapter.write(item!.ref, item!.value)
    now.mockRestore()
    await new Promise((resolve) => setImmediate(resolve))
    const envLines = lines.filter((line) => line.includes('win-user-env-http-proxy'))
    expect(envLines.length).toBe(1)
    expect(envLines[0]).toContain('25 ms')
  })

  it('子进程命令超时给独立受控码 TERMINAL_ENVIRONMENT_COMMAND_TIMEOUT(基线:与「注册表不可读」混同一归因)', () => {
    // 不注入 run:走 defaultRun → 被 mock 的 execFileSync 抛真实超时形状
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home, notifyEnvironmentChanged: () => undefined })
    expect(() => adapter.managedItems(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_COMMAND_TIMEOUT/)
  })
})
