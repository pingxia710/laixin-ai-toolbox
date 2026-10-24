import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import type { AiAccessShell } from './service'
import { trustedWindowsSystemRoot } from '../shells/inventory'

export type ShellProcessState = 'running' | 'not-running' | 'unknown'

export interface ShellRestartGuidance {
  readonly shell: AiAccessShell
  /** Only a process-presence result; process names, IDs and command lines never leave main. */
  readonly process: ShellProcessState
  readonly message: string
}

export interface RestartGuidanceOptions {
  readonly platform?: NodeJS.Platform
  readonly readCommand?: (command: string, args: readonly string[]) => Promise<string>
}

const execFile = promisify(execFileCallback)

const processNames: Readonly<Record<AiAccessShell, readonly string[]>> = {
  codex: ['codex', 'Codex', 'ChatGPT'],
  claude: ['claude', 'Claude'],
  hermes: ['hermes', 'Hermes']
}

/**
 * Reads process presence with fixed commands only. This is advisory: a launch wrapper or an OS
 * restriction yields `unknown`, never a false claim that the customer has restarted the client.
 */
export function createRestartGuidanceReader(options: RestartGuidanceOptions = {}): {
  read(shell: AiAccessShell): Promise<ShellRestartGuidance>
} {
  const platform = options.platform ?? process.platform
  const readCommand = options.readCommand ?? defaultReadCommand
  const systemRoot = trustedWindowsSystemRoot
  return {
    async read(shell) {
      const process = await processState(shell, platform, readCommand, systemRoot)
      return { shell, process, message: restartMessage(shell, process) }
    }
  }
}

export function restartMessage(shell: AiAccessShell, process: ShellProcessState): string {
  switch (shell) {
    case 'codex':
      return process === 'running'
        ? '检测到 Codex 正在运行。请彻底退出（Mac 请用“退出”或 ⌘Q）并重新打开 Codex 终端或 ChatGPT/Codex 桌面版，再发送一条消息。'
        : process === 'not-running'
          ? 'Codex 下次启动会读取新配置。若你使用 ChatGPT/Codex 桌面版，请重新打开它后再发送消息。'
          : 'Codex 需要重新打开终端或 ChatGPT/Codex 桌面版后读取新配置。'
    case 'claude':
      return process === 'running'
        ? '检测到 Claude Code 正在运行。配置通常热生效；请新开一个会话后发送消息确认。'
        : process === 'not-running'
          ? 'Claude Code 配置通常热生效；下次打开后请新开一个会话并发送消息确认。'
          : 'Claude Code 配置通常热生效；请新开一个会话后发送消息确认。'
    case 'hermes':
      return process === 'running'
        ? '检测到 Hermes 正在运行。模型与 Key 通常会在当前会话生效；请直接发送一条消息确认。'
        : process === 'not-running'
          ? 'Hermes 下次打开即可使用新模型与 Key；打开后请发送一条消息确认。'
          : 'Hermes 的模型与 Key 通常热生效；请发送一条消息确认。'
  }
}

async function processState(
  shell: AiAccessShell,
  platform: NodeJS.Platform,
  readCommand: (command: string, args: readonly string[]) => Promise<string>,
  systemRoot: string
): Promise<ShellProcessState> {
  try {
    if (platform === 'win32') {
      for (const name of processNames[shell]) {
        const output = await readCommand(win32.join(systemRoot, 'System32', 'tasklist.exe'), ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'])
        if (new RegExp(`"${escapeRegExp(name)}\\.exe"`, 'i').test(output)) return 'running'
      }
      return 'not-running'
    }
    if (platform === 'darwin' || platform === 'linux') {
      for (const name of processNames[shell]) {
        try {
          await readCommand('/usr/bin/pgrep', ['-x', name])
          return 'running'
        } catch (error) {
          if (String((error as NodeJS.ErrnoException).code) !== '1') return 'unknown'
        }
      }
      return 'not-running'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function defaultReadCommand(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(command, [...args], { encoding: 'utf8', timeout: 3_000, maxBuffer: 16 * 1024, windowsHide: true })
  return stdout
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
