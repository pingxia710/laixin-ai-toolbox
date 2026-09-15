import type { AiAccessShell } from '../../../main/ai-access/service'

export type ShellProcessState = 'running' | 'not-running' | 'unknown'

export interface RestartGuidance {
  readonly shell: AiAccessShell
  readonly process: ShellProcessState
}

/** The main process only reports a three-state process observation. UI wording stays fixed here. */
export function readRestartGuidance(snapshot: string, expectedShell: AiAccessShell): RestartGuidance {
  let value: unknown
  try { value = JSON.parse(snapshot) } catch { throw new Error('AI_RESTART_GUIDANCE_INVALID') }
  if (!record(value) || value.shell !== expectedShell ||
    (value.process !== 'running' && value.process !== 'not-running' && value.process !== 'unknown')) {
    throw new Error('AI_RESTART_GUIDANCE_INVALID')
  }
  return { shell: expectedShell, process: value.process }
}

export function restartGuidanceMessage(guidance: RestartGuidance): string {
  switch (guidance.shell) {
    case 'codex':
      return guidance.process === 'running'
        ? '检测到 Codex 正在运行。请关闭并重新打开 Codex 终端或 ChatGPT/Codex 桌面版，再发送一条消息。'
        : guidance.process === 'not-running'
          ? 'Codex 下次启动会读取新配置。若你使用 ChatGPT/Codex 桌面版，请重新打开它后再发送消息。'
          : 'Codex 需要重新打开终端或 ChatGPT/Codex 桌面版后读取新配置。'
    case 'claude':
      return guidance.process === 'running'
        ? '检测到 Claude Code 正在运行。配置通常热生效；请新开一个会话后发送消息确认。'
        : 'Claude Code 配置通常热生效；请新开一个会话后发送消息确认。'
    case 'hermes':
      return guidance.process === 'running'
        ? '检测到 Hermes 正在运行。模型与 Key 通常会在当前会话生效；请直接发送一条消息确认。'
        : 'Hermes 的模型与 Key 通常热生效；请发送一条消息确认。'
  }
}

export function fallbackRestartGuidanceMessage(shell: AiAccessShell): string {
  return restartGuidanceMessage({ shell, process: 'unknown' })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
