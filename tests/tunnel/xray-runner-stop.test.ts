// 件1(收敛包2)证明:Windows 断开不再留 xray.exe 孤儿。
// 层次:① runner 逻辑(win32 注入模拟:关管道即停 xray;darwin:父进程消失轮询补充);
// ② bridge(win32 注入模拟:管道停不住时按记档 pid taskkill /T /F 兜底);
// ③ 真实进程(darwin):真实 runner + 官方 xray,断开后 pid 记档清除、xray 进程确死。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn as realSpawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { startXrayRunner } from '../../sidecar/win/xray-runner.mjs'
import { createLocalBridge } from '../../sidecar/win/local-bridge.mjs'
import { makeTempDir, removeTempDir, startFakeSocks5Server, type FakeSocks5 } from './helpers'

interface FakeTimers {
  setInterval: (fn: () => void) => number
  clearInterval: (id: number) => void
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
}

function fakeTimers() {
  let sequence = 0
  const intervals = new Map<number, () => void>()
  return {
    intervals,
    timers: {
      setInterval: (fn: () => void) => {
        sequence += 1
        intervals.set(sequence, fn)
        return sequence
      },
      clearInterval: (id: number) => { intervals.delete(id) },
      setTimeout: (fn: () => void) => {
        sequence += 1
        intervals.set(sequence, () => { fn(); intervals.delete(sequence) })
        return sequence
      },
      clearTimeout: (id: number) => { intervals.delete(id) }
    } as unknown as FakeTimers
  }
}

function fakeStdin(overrides: { readableEnded?: boolean } = {}) {
  const stdin = new EventEmitter() as EventEmitter & { resume: () => unknown, readableEnded?: boolean }
  stdin.resume = () => stdin
  stdin.readableEnded = overrides.readableEnded
  return stdin
}

function fakeXrayChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number, signals: string[], kill: (signal?: string) => boolean
  }
  child.pid = 4242
  child.signals = []
  child.kill = (signal?: string) => {
    child.signals.push(signal ?? '')
    return true
  }
  return child
}

describe('xray-runner(win32 注入模拟)', () => {
  let dataDir: string
  let config: string
  beforeEach(() => { dataDir = makeTempDir('laixin-runner-stop-'); config = join(dataDir, 'xray-bridge.json'); writeFileSync(config, '{}') })
  afterEach(() => removeTempDir(dataDir))

  function runnerOptions(overrides: Record<string, unknown> = {}) {
    return {
      executable: 'C:\\toolbox\\xray.exe', config, parent: 999,
      stdin: fakeStdin(), ppid: 999, platform: 'win32',
      spawnImpl: () => fakeXrayChild(),
      getPpid: () => 999,
      exit: () => undefined,
      ...overrides
    }
  }

  it('启动即记档 xray pid;关 stdin 管道(bridge 停止信号)→ SIGTERM 停 xray → 退出并清 pid 档', () => {
    const exit = vi.fn()
    const spawned: Array<{ args: readonly string[] }> = []
    const child = fakeXrayChild()
    const stdin = fakeStdin()
    const runner = startXrayRunner(runnerOptions({
      stdin,
      spawnImpl: (executable: string, args: readonly string[]) => {
        spawned.push({ args })
        return child
      },
      exit
    }))
    void runner
    expect(spawned[0]?.args).toEqual(['run', '-config', config])
    // 记档带启动时刻与映像名:下一次启动据此清扫孤儿,且能防 PID 复用误杀(审计 A2)
    expect(JSON.parse(readFileSync(`${config}.pid`, 'utf8')) as Record<string, unknown>)
      .toEqual({ pid: 4242, startedAt: expect.any(Number), image: 'xray.exe' })
    expect(exit).not.toHaveBeenCalled()
    // bridge close() 关管道:stdin EOF 即停,不依赖 SIGTERM 送达(Windows 上等于强杀)
    stdin.emit('end')
    expect(child.signals).toContain('SIGTERM')
    child.emit('close', 0)
    expect(exit).toHaveBeenCalledWith(0)
    expect(existsSync(`${config}.pid`)).toBe(false)
  })

  it('stdin 已提前结束(readableEnded)→ 直接近停', () => {
    const exit = vi.fn()
    const child = fakeXrayChild()
    startXrayRunner(runnerOptions({ stdin: fakeStdin({ readableEnded: true }), spawnImpl: () => child, exit }))
    expect(child.signals).toContain('SIGTERM')
    child.emit('close', 0)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('darwin:父进程消失由 ppid 轮询补充触发停止(win32 ⛔ 空转:平台名即关闭轮询)', () => {
    const exit = vi.fn()
    const child = fakeXrayChild()
    const timers = fakeTimers()
    let currentPpid = 999
    startXrayRunner(runnerOptions({
      platform: 'darwin', spawnImpl: () => child, exit,
      getPpid: () => currentPpid, timers: timers.timers
    }))
    expect(timers.intervals.size).toBe(1)
    const poll = [...timers.intervals.values()][0]
    currentPpid = 123 // 父进程已死
    poll()
    expect(child.signals).toContain('SIGTERM')
    child.emit('close', 0)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('win32 不启动 ppid 轮询(Windows 上父死后 ppid 不变,轮询永不触发)', () => {
    const timers = fakeTimers()
    startXrayRunner(runnerOptions({ timers: timers.timers }))
    expect(timers.intervals.size).toBe(0)
  })

  it('启动护栏:parent 不合法或与真实 ppid 不符 → exit(64),⛔ 起 xray', () => {
    const exit = vi.fn()
    const spawnImpl = vi.fn(() => fakeXrayChild())
    startXrayRunner(runnerOptions({ parent: Number.NaN, spawnImpl, exit }))
    startXrayRunner(runnerOptions({ ppid: 1, spawnImpl, exit }))
    expect(exit).toHaveBeenCalledTimes(2)
    expect(exit).toHaveBeenCalledWith(64)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('xray 内核 stderr 不再丢弃:转发到 runner 自己的 stderr(截断+限量闸),进守护日志链(甲-6)', () => {
    const captured: string[] = []
    const child = fakeXrayChild() as ReturnType<typeof fakeXrayChild> & { stderr?: EventEmitter }
    startXrayRunner(runnerOptions({
      // 夹具按 Node 的真实行为建模:stderr 流只在 runner 请求 'pipe' 时存在
      spawnImpl: (executable: string, args: readonly string[], opts: { stdio?: readonly string[] | string }) => {
        const stdio = opts?.stdio
        const piped = Array.isArray(stdio) ? stdio[2] === 'pipe' : stdio === 'pipe'
        if (piped) child.stderr = new EventEmitter()
        return child
      },
      // 注入收集口(生产是 process.stderr → 守护日志 → 诊断包;包里逐行过 redact)
      stderr: { write: (line: string) => { captured.push(line); return true } }
    }))
    if (child.stderr === undefined) throw new Error('runner 没有请求 pipe stderr(基线形状:ignore)')
    child.stderr.emit('data', Buffer.from(`panic: runtime error\n${'Y'.repeat(400)}\n`))
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0]).toContain('panic: runtime error')
    // 400 字符的行被截断到 200(⛔ 整段转储),爆量闸:全程共 50 行上限,前两条已占 2 → 洪水只放 48
    const longLine = captured.find((line) => line.includes('YYYY'))
    expect(longLine).toBeDefined()
    expect(longLine!.length).toBeLessThanOrEqual(210)
    for (let index = 0; index < 120; index += 1) child.stderr.emit('data', Buffer.from(`flood ${String(index)}\n`))
    const floods = captured.filter((line) => line.includes('flood'))
    expect(floods.length).toBe(48)
  })
})

describe('local-bridge 停止(win32 注入模拟)', () => {
  let dataDir: string
  let socksServer: Server | undefined
  beforeEach(() => { dataDir = makeTempDir('laixin-bridge-stop-') })
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (socksServer === undefined || !socksServer.listening) { resolve(); return }
      socksServer.close(() => resolve())
    })
    removeTempDir(dataDir)
  })

  // 审计 A2(2026-09-12 上线检查):runner 被 TerminateProcess 硬杀时 close 钩子不跑,
  // pid 记档留在磁盘、xray.exe 还活着。旧启动路径不读旧记档、直接覆盖,孤儿无人清扫
  // (证据 repro-win-xray-orphan-pid.json:4001 → 4002,对 4001 零次 kill)。
  function fakeRunnerSpawn(calls: Array<{ cmd: string, args: readonly string[] }>, onServer: (server: Server) => void) {
    return (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args })
      if (cmd === 'taskkill') return new EventEmitter() as never
      const configPath = args[2] as string
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { inbounds: Array<{ port: number }> }
      const server = createServer((socket) => {
        socket.on('data', (chunk) => { if (chunk[0] === 5) socket.write(Buffer.from([5, 0])) })
      })
      server.listen(config.inbounds[0].port, '127.0.0.1')
      onServer(server)
      writeFileSync(`${configPath}.pid`, `${JSON.stringify({ pid: 4002, startedAt: Date.now(), image: 'xray.exe' })}\n`, { mode: 0o600 })
      const stdin = new PassThrough()
      stdin.resume()
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough, exitCode: number | null, signalCode: string | number | null, kill: (signal?: string) => boolean }
      child.stdin = stdin
      child.exitCode = null
      child.signalCode = null
      child.kill = (signal?: string) => {
        child.signalCode = signal ?? 'SIGKILL'
        queueMicrotask(() => child.emit('close', null, child.signalCode))
        return true
      }
      return child as never
    }
  }

  it('启动前清扫上次硬杀留下的内核:先对旧记档 pid 恰好 1 次 taskkill(带映像名过滤),再起新 runner', async () => {
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    writeFileSync(pidPath, `${JSON.stringify({ pid: 4001, startedAt: Date.now(), image: 'xray.exe' })}\n`, { mode: 0o600 })
    const calls: Array<{ cmd: string, args: readonly string[] }> = []
    const bridge = createLocalBridge({
      listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: 1 },
      spawnImpl: fakeRunnerSpawn(calls, (server) => { socksServer = server }) as never, platform: 'win32'
    })

    await bridge.listen()

    const kills = calls.filter((call) => call.cmd === 'taskkill')
    expect(kills).toHaveLength(1)
    expect(kills[0].args).toEqual(['/F', '/T', '/FI', 'PID eq 4001', '/FI', 'IMAGENAME eq xray.exe'])
    expect(calls[0].cmd).toBe('taskkill') // 清扫在起新 runner 之前
    expect(calls[1].cmd).not.toBe('taskkill')
    // 新 runner 的记档已就位,旧记档没有被当成新内核留下来
    expect(JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }).toEqual(expect.objectContaining({ pid: 4002 }))
    await bridge.close()
  })

  it('桥 spawn runner 的 stderr 去向是 inherit(接进守护日志链),⛔ 再 ignore 丢尸(甲-6)', async () => {
    const spawns: Array<{ opts: { stdio?: readonly unknown[] } | undefined }> = []
    const spawnImpl = (cmd: string, args: readonly string[], opts: { stdio?: readonly unknown[] }) => {
      spawns.push({ opts })
      const configPath = args[2] as string
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { inbounds: Array<{ port: number }> }
      socksServer = createServer((socket) => {
        socket.on('data', (chunk) => { if (chunk[0] === 5) socket.write(Buffer.from([5, 0])) })
      })
      socksServer.listen(config.inbounds[0].port, '127.0.0.1')
      writeFileSync(`${configPath}.pid`, `${JSON.stringify({ pid: 4002, startedAt: Date.now(), image: 'xray.exe' })}\n`, { mode: 0o600 })
      const stdin = new PassThrough()
      stdin.resume()
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough, exitCode: number | null, signalCode: string | number | null, kill: (signal?: string) => boolean }
      child.stdin = stdin
      child.exitCode = null
      child.signalCode = null
      child.kill = (signal?: string) => {
        child.signalCode = signal ?? 'SIGKILL'
        queueMicrotask(() => child.emit('close', null, child.signalCode))
        return true
      }
      return child as never
    }
    const bridge = createLocalBridge({
      listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: 1 },
      spawnImpl: spawnImpl as never, platform: 'win32'
    })
    await bridge.listen()
    expect(spawns).toHaveLength(1) // 数据目录是新的:无旧记档,不触发 taskkill
    expect(spawns[0].opts?.stdio?.[2]).toBe('inherit')
    await bridge.close()
  })

  it('记档的启动时刻早于本次开机 → 该 pid 必已被系统复用:只删记档 ⛔ 强杀无关进程', async () => {
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    writeFileSync(pidPath, `${JSON.stringify({ pid: 4001, startedAt: 1, image: 'xray.exe' })}\n`, { mode: 0o600 })
    const calls: Array<{ cmd: string, args: readonly string[] }> = []
    const bridge = createLocalBridge({
      listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: 1 },
      spawnImpl: fakeRunnerSpawn(calls, (server) => { socksServer = server }) as never, platform: 'win32'
    })

    await bridge.listen()

    expect(calls.filter((call) => call.cmd === 'taskkill')).toHaveLength(0)
    await bridge.close()
  })

  it('关管道后 runner 停不住 → 1 秒兜底按记档 pid taskkill /T /F,再杀 runner(⛔ 留孤儿)', async () => {
    const FAKE_XRAY_PID = 424242
    const taskkillCalls: Array<{ cmd: string, args: readonly string[] }> = []
    let stdinEnded = false
    const spawnImpl = (cmd: string, args: readonly string[]) => {
      if (cmd === 'taskkill') {
        taskkillCalls.push({ cmd, args })
        return new EventEmitter() as never
      }
      // 假 runner:起 SOCKS 应答服务(让 listen 探测通过)、写 pid 档;关管道后故意不退出,
      // 模拟 Windows 上管道之外没有可靠停止信号的残局。
      const configPath = args[2] as string
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { inbounds: Array<{ port: number }> }
      socksServer = createServer((socket) => {
        socket.on('data', (chunk) => {
          if (chunk[0] === 5) socket.write(Buffer.from([5, 0]))
        })
      })
      socksServer.listen(config.inbounds[0].port, '127.0.0.1')
      writeFileSync(`${configPath}.pid`, `${FAKE_XRAY_PID}\n`, { mode: 0o600 })
      const stdin = new PassThrough()
      stdin.resume() // 与真实 process.stdin 一致:流动后才会在管道关闭时触发 'end'
      stdin.on('end', () => { stdinEnded = true })
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough, exitCode: number | null, signalCode: string | number | null, kill: (signal?: string) => boolean }
      child.stdin = stdin
      child.exitCode = null
      child.signalCode = null
      child.kill = (signal?: string) => {
        child.signalCode = signal ?? 'SIGKILL'
        queueMicrotask(() => child.emit('close', null, child.signalCode))
        return true
      }
      void realSpawn // 保持导入(真实平台兜底路径不在此测)
      return child as never
    }
    const bridge = createLocalBridge({
      listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: 1 },
      spawnImpl: spawnImpl as never, platform: 'win32'
    })
    await bridge.listen()
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    // 这一路的假 runner 故意写旧版裸数字记档:证明升级后 close 兜底仍认得老格式(审计 A2)
    expect(readFileSync(pidPath, 'utf8')).toBe(`${FAKE_XRAY_PID}\n`)
    await bridge.close()
    expect(stdinEnded).toBe(true) // 主通道:管道已关
    expect(taskkillCalls).toEqual([{ cmd: 'taskkill', args: ['/PID', String(FAKE_XRAY_PID), '/T', '/F'] }])
    expect(bridge.isAlive()).toBe(false)
  })
})

describe('local-bridge 真实进程(darwin):断开后不留 xray 孤儿', () => {
  let dataDir: string
  let upstream: FakeSocks5
  beforeEach(async () => {
    dataDir = makeTempDir('laixin-bridge-live-')
    upstream = await startFakeSocks5Server({})
  })
  afterEach(async () => {
    await upstream.close()
    removeTempDir(dataDir)
  })

  it('断开 → runner 停 xray、清 pid 记档、进程确死', async () => {
    const bridge = createLocalBridge({
      listenPort: 0, dataDir,
      upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { tunnelSuffixes: ['foreign.test'], directSuffixes: [], protectedDirectSuffixes: [] }
    })
    await bridge.listen()
    const pidPath = join(dataDir, 'xray-bridge.json.pid')
    await expect.poll(() => existsSync(pidPath), { timeout: 5_000 }).toBe(true)
    const xrayPid = (JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }).pid
    expect(Number.isSafeInteger(xrayPid)).toBe(true)
    expect(() => process.kill(xrayPid, 0)).not.toThrow() // xray 在跑
    await bridge.close()
    await expect.poll(() => existsSync(pidPath), { timeout: 5_000 }).toBe(false)
    expect(() => process.kill(xrayPid, 0)).toThrow() // ESRCH:xray 已死,无孤儿
  }, 30_000)
})
