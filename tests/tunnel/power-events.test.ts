// Windows 电源事件源:行解析、注入 spawn 的接线,以及真实 PowerShell 执行实际生成的脚本。
import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { createPowerEventSource, parsePowerEvent, watcherScript } from '../../sidecar/win/power-events.mjs'

function fakeChild() {
  const stdout = new EventEmitter()
  const child = { stdout, killed: false, kill: () => { child.killed = true } }
  return child as unknown as { stdout: Readable; kill: () => void; killed: boolean }
}

describe('Windows 电源事件源(逻辑层)', () => {
  it('行解析:只认 wake / network-change 受控行,其余丢弃', () => {
    expect(parsePowerEvent('toolbox:wake')).toBe('wake')
    expect(parsePowerEvent('  toolbox:network-change\r')).toBe('network-change')
    expect(parsePowerEvent('toolbox:session-change')).toBeUndefined()
    expect(parsePowerEvent('noise')).toBeUndefined()
    expect(parsePowerEvent('')).toBeUndefined()
    expect(parsePowerEvent(undefined)).toBeUndefined()
  })

  // 2026-09-15 收窄(创始人定):原查询是「任意网卡的任意属性变动」——统计计数、速率这些每秒都在变的
  // 字段都会命中,在有虚拟网卡/别的代理软件的机器上几乎是常态触发,每一条都打断退避、提前拉起恢复
  // (那台 Windows 的日志里 network-change 连发)。现在只认连通状态真的发生了变化。
  it('网络事件查询已收窄:只认 NetConnectionStatus 真的变了,⛔ 任意属性变动', () => {
    const script = watcherScript()
    // 必须比较前后两个实例的连通状态,而不是「只要 Win32_NetworkAdapter 有任何修改」
    expect(script).toContain('TargetInstance.NetConnectionStatus <> PreviousInstance.NetConnectionStatus')
    // 轮询窗口放宽到 5 秒:它只负责「早点知道」,退避本身有自己的节奏
    expect(script).toContain('WITHIN 5')
    expect(script).not.toContain('WITHIN 2')
    // ⛔ 按 PhysicalAdapter 过滤掉虚拟网卡:VPN/隧道网卡的上下线是真的连通性变化
    expect(script).not.toContain('PhysicalAdapter')
    // 唤醒那一路不受影响:仍只认 7/18(⛔ 把进入睡眠当唤醒)
    expect(script).toContain('$type -eq 7 -or $type -eq 18')
  })

  it('事件源接线:stdout 行 → emit;stop() 终止子进程;分块行缓冲不丢事件', () => {
    const seen: string[] = []
    const child = fakeChild()
    const stdout = child.stdout
    const source = createPowerEventSource({
      emit: (event) => seen.push(event),
      spawnProcess: (() => child) as never
    })
    stdout.emit('data', Buffer.from('toolbox:wake\r\njunk\n'))
    expect(seen).toEqual(['wake'])
    // 一行被拆到两次 data:缓冲拼接后才成行
    stdout.emit('data', Buffer.from('toolbox:net'))
    stdout.emit('data', Buffer.from('work-change\n'))
    expect(seen).toEqual(['wake', 'network-change'])
    source.stop()
    expect(child.killed).toBe(true)
  })
})

describe('实际生成的 watcher 脚本(验收 P1#1:让测试执行真实脚本)', () => {
  it('结构:独立 if(无 elseif)、无分号拼接、EventType 过滤唤醒类(7/18)、以单参数传给 -Command', () => {
    const script = watcherScript()
    expect(script.includes('elseif')).toBe(false)
    expect(script.includes(';')).toBe(false)
    expect(script).toContain('$type -eq 7 -or $type -eq 18')
    expect(script).toContain("Write-Output 'toolbox:wake'")
    expect(script).toContain("Write-Output 'toolbox:network-change'")
    // 非唤醒类电源事件(4=Entering Suspend 进入睡眠、1、10=电源状态变化)不当 wake
    expect(script).not.toMatch(/-eq 4\b/)
    expect(script).not.toMatch(/-eq 1\b/)
    expect(script).not.toMatch(/-eq 10\b/)
    // spawn 实参:脚本必须整体作为 -Command 的单个参数
    let captured: unknown
    const source = createPowerEventSource({
      emit: () => undefined,
      spawnProcess: ((...args: unknown[]) => {
        captured = args
        return { stdout: undefined, kill: () => undefined }
      }) as never
    })
    source.stop()
    const [file, args] = captured as [string, string[]]
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args[3]).toBe(script)
  })

  // 真实 PowerShell 进程执行实际脚本:WMI 注册与事件队列用桩替换(不订阅宿主系统事件)。
  // pwsh 来源 = TOOLBOX_TEST_PWSH 或 PATH;都没有则显式跳过(⛔ 冒充已验证)。
  it('脚本在真实 PowerShell 里执行:电源 7/18 → wake、4(进入睡眠)与 10 不触发、网络变化 → network-change', async (ctx) => {
    const candidates = [process.env.TOOLBOX_TEST_PWSH, 'pwsh'].filter((p): p is string => Boolean(p))
    let pwsh: string | undefined
    for (const candidate of candidates) {
      if (spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000 }).status === 0) {
        pwsh = candidate
        break
      }
    }
    if (pwsh === undefined) {
      ctx.skip('本机无 pwsh;验收/真机环境请设 TOOLBOX_TEST_PWSH 指向 PowerShell 可执行文件')
      return
    }
    const stub = [
      'function Register-WmiEvent { param([Parameter(ValueFromRemainingArguments = $true)] $rest) }',
      'function Remove-Event { param($EventIdentifier) }',
      '$global:toolboxQueue = New-Object System.Collections.Queue',
      'function Add-ToolboxEvent { param($id, $type) $global:toolboxQueue.Enqueue([pscustomobject]@{ SourceIdentifier = $id; SourceEventArgs = [pscustomobject]@{ NewEvent = [pscustomobject]@{ EventType = $type } } }) }',
      "Add-ToolboxEvent 'toolboxPower' 7",
      "Add-ToolboxEvent 'toolboxPower' 4",
      "Add-ToolboxEvent 'toolboxPower' 10",
      "Add-ToolboxEvent 'toolboxPower' 18",
      "Add-ToolboxEvent 'toolboxNetwork' 0",
      "Add-ToolboxEvent 'toolboxNetwork' 0",
      'function Wait-Event { param([int]$Timeout) if ($global:toolboxQueue.Count -eq 0) { Start-Sleep -Milliseconds 100; return $null } $global:toolboxQueue.Dequeue() }'
    ].join('\n')
    const child: ChildProcess = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `${stub}\n${watcherScript()}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const lines = await new Promise<string[]>((resolve) => {
      let buffer = ''
      const seen: string[] = []
      const finish = () => resolve(seen)
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += String(chunk)
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          if (line.trim() !== '') seen.push(line.trim())
        }
        if (seen.length >= 4) {
          child.kill()
          finish()
        }
      })
      child.on('close', () => finish())
      setTimeout(() => {
        child.kill()
        finish()
      }, 20_000)
    })
    expect(lines).toEqual(['toolbox:wake', 'toolbox:wake', 'toolbox:network-change', 'toolbox:network-change'])
  }, 30_000)
})

describe('Windows 电源事件源:崩溃重启退避(收敛包2 件5)', () => {
  interface Scheduled { fn: () => void, ms: number, id: number }
  function fakeTimers() {
    let sequence = 0
    const scheduled: Scheduled[] = []
    return {
      scheduled,
      timers: {
        setTimeout: (fn: () => void, ms?: number) => {
          const at = ms ?? 0
          sequence += 1
          scheduled.push({ fn, ms: at, id: sequence })
          return sequence
        },
        clearTimeout: (id: unknown) => {
          const index = scheduled.findIndex((entry) => entry.id === id)
          if (index >= 0) scheduled.splice(index, 1)
        }
      }
    }
  }

  function crashableChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter, killed: boolean, kill: () => void, crash: () => void
    }
    child.stdout = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    child.crash = () => { child.emit('exit', 1) }
    return child as unknown as { stdout: Readable, kill: () => void, killed: boolean, crash: () => void }
  }

  it('退避序列:连续失败按 5s → 30s → 5min 封顶,连续 5 次失败后停止并记一条,⛔ 每 5 秒无限重启', () => {
    const giveUpMessages: string[] = []
    let child = crashableChild()
    const spawnCalls: number[] = []
    const { scheduled, timers } = fakeTimers()
    const source = createPowerEventSource({
      emit: () => undefined,
      spawnProcess: (() => {
        spawnCalls.push(spawnCalls.length + 1)
        child = crashableChild()
        return child as unknown as ChildProcess
      }) as never,
      onGiveUp: (reason: string) => { giveUpMessages.push(reason) },
      timers
    })
    // 首发 + 5 次连续失败:第 1..5 次失败分别排 5s/30s/5min/5min/5min 的重启
    child.crash()
    for (let round = 0; round < 5; round += 1) {
      expect(scheduled.length).toBe(1)
      // 从排程里取出并触发下一次启动
      const entry = scheduled.splice(0)[0]
      expect([5_000, 30_000, 300_000, 300_000, 300_000][round]).toBe(entry.ms)
      entry.fn()
      child.crash()
    }
    // 第 6 次失败:放弃重启
    expect(scheduled.length).toBe(0)
    expect(giveUpMessages).toHaveLength(1)
    expect(giveUpMessages[0]).toContain('连续 5 次')
    expect(spawnCalls).toHaveLength(6)
    source.stop()
  })

  it('有输出 = 监听在跑:连续失败计数归零,此后再崩从 5s 重新退避', () => {
    const giveUpMessages: string[] = []
    const { scheduled, timers } = fakeTimers()
    let child = crashableChild()
    const source = createPowerEventSource({
      emit: () => undefined,
      spawnProcess: (() => {
        child = crashableChild()
        return child as unknown as ChildProcess
      }) as never,
      onGiveUp: (reason: string) => { giveUpMessages.push(reason) },
      timers
    })
    // 崩两次 → 5s、30s
    child.crash()
    const first = scheduled.splice(0)[0]
    expect(first.ms).toBe(5_000)
    first.fn()
    child.crash()
    const second = scheduled.splice(0)[0]
    expect(second.ms).toBe(30_000)
    // 第二个实例先吐出事件行再崩:计数归零,下一次重启回到 5s
    second.fn()
    child.stdout.emit('data', Buffer.from('toolbox:wake\n'))
    child.crash()
    const third = scheduled.splice(0)[0]
    expect(third.ms).toBe(5_000)
    expect(giveUpMessages).toHaveLength(0)
    source.stop()
  })

  it('stop() 清掉未决的重启排程,⛔ 放弃后还爬起来', () => {
    const { scheduled, timers } = fakeTimers()
    let child = crashableChild()
    const source = createPowerEventSource({
      emit: () => undefined,
      spawnProcess: (() => {
        child = crashableChild()
        return child as unknown as ChildProcess
      }) as never,
      timers
    })
    child.crash()
    expect(scheduled.length).toBe(1)
    source.stop()
    expect(scheduled.length).toBe(0)
    // stop 后崩溃不再触发重启
    child.crash()
    expect(scheduled.length).toBe(0)
  })
})
