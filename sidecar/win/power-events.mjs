// Windows 电源 / 网络事件源(用户级):PowerShell 订阅 WMI 电源与网络接口变化,
// 输出受控行给守护;⛔ 服务 ⛔ 计划任务 ⛔ 启动项 ⛔ 提权(与守卫同边界)。
// 真实 PowerShell 管道留待真机验收;自动化测试经注入 spawnProcess 喂事件行。
// 仅 wake / network-change 两类:解锁不睡眠的场景由 network-change 与既有复验 tick 覆盖。
import { spawn } from 'node:child_process'

const WATCHER_LINES = {
  'toolbox:wake': 'wake',
  'toolbox:network-change': 'network-change'
}

// 重启退避:5s → 30s → 5min 封顶;连续失败到上限后停止并在诊断记一条。
// ⛔ 每 5 秒无限重启:杀软长期拦住 PowerShell 时会变成永久后台空转。
const RESTART_BACKOFF_MS = Object.freeze([5_000, 30_000, 300_000])
const MAX_CONSECUTIVE_FAILURES = 5

export function parsePowerEvent(line) {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  return WATCHER_LINES[trimmed]
}

export function createPowerEventSource({ emit, spawnProcess = spawn, onGiveUp, timers = { setTimeout, clearTimeout } }) {
  let child
  let restart
  let closed = false
  let consecutiveFailures = 0
  const launch = () => {
    if (closed) return
    child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', watcherScript()], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let buffer = ''
    let ended = false
    const retry = () => {
      if (closed || ended) return
      ended = true
      consecutiveFailures += 1
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        onGiveUp?.(`PowerShell 事件监听连续 ${MAX_CONSECUTIVE_FAILURES} 次未能运行，已停止重启（睡眠唤醒自动恢复可能失效，通道复验仍在）`)
        return
      }
      const delay = RESTART_BACKOFF_MS[Math.min(consecutiveFailures - 1, RESTART_BACKOFF_MS.length - 1)]
      restart = timers.setTimeout(launch, delay)
    }
    child.once?.('error', retry)
    child.once?.('exit', retry)
    child.stdout?.on('data', (chunk) => {
      if (closed || ended) return
      // 有输出 = 监听确实在跑:连续失败计数归零。
      consecutiveFailures = 0
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = (lines.pop() ?? '').slice(-512)
      for (const line of lines) {
        const event = parsePowerEvent(line)
        if (event !== undefined) emit(event)
      }
    })
  }
  launch()
  return {
    stop: () => {
      if (closed) return
      closed = true
      timers.clearTimeout(restart)
      child?.kill()
    }
  }
}

function watcherScript() {
  // ⛔ 用 `; ` 拼 PowerShell 语句:`;` 会截断 if 块,后面的 elseif / 后续分支会变成
  // 独立命令(且被 SilentlyContinue 吞掉)。这里全部用独立 if 语句 + 换行拼接。
  // 电源事件按 Win32_PowerManagementEvent.EventType 过滤唤醒类:7=Resume from Suspend、
  // 18=Resume Automatic;4=Entering Suspend(进入睡眠)⛔ 当 wake——在睡眠前触发恢复会把
  // 未断开的现场当已断开清理;1(旧文档进入睡眠)、10=电源状态变化同样 ⛔。
  // 依据 learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-powermanagementevent。
  return [
    "$ErrorActionPreference = 'Stop'",
    "Register-WmiEvent -Class Win32_PowerManagementEvent -SourceIdentifier toolboxPower | Out-Null",
    // 网络变化信号收窄(创始人 2026-09-15):原查询是「任意网卡的任意属性变动」——
    // 统计计数、速率这些每秒都在变的字段都会命中,在有虚拟网卡/别的代理软件的机器上几乎是常态触发
    // (2026-09-15 那台 Windows 的日志里 network-change 连发)。每一条都会打断退避、提前拉起恢复。
    // 现在只认**连通状态真的发生了变化**:比较 PreviousInstance 与 TargetInstance 的 NetConnectionStatus,
    // 相等就不是连通性事件。轮询窗口一并从 2 秒放宽到 5 秒(它只是「早点知道」,退避本身有自己的节奏)。
    // ⛔ 顺手按 PhysicalAdapter 过滤掉虚拟网卡:VPN/隧道网卡的上下线是真的连通性变化。
    "Register-WmiEvent -Query \"SELECT * FROM __InstanceModificationEvent WITHIN 5 WHERE TargetInstance ISA 'Win32_NetworkAdapter' AND TargetInstance.NetConnectionStatus <> PreviousInstance.NetConnectionStatus\" -SourceIdentifier toolboxNetwork | Out-Null",
    'while ($true) {',
    '  $event = Wait-Event -Timeout 1',
    '  if ($null -eq $event) { continue }',
    "  if ($event.SourceIdentifier -eq 'toolboxPower') {",
    '    $type = $event.SourceEventArgs.NewEvent.EventType',
    "    if ($type -eq 7 -or $type -eq 18) { Write-Output 'toolbox:wake' }",
    '  }',
    "  if ($event.SourceIdentifier -eq 'toolboxNetwork') { Write-Output 'toolbox:network-change' }",
    '  Remove-Event -EventIdentifier $event.EventIdentifier',
    '}'
  ].join('\n')
}

export { watcherScript }

export const WAKE_EVENT_TYPES = [7, 18]
