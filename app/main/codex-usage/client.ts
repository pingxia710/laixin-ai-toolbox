import { spawn } from 'node:child_process'
import { codexAccountKey, record } from './normalize'
import type { CodexCommand } from './runtime'
import type { UsageStatus } from './types'

export class UsageReadError extends Error {
  constructor(readonly status: UsageStatus) { super(status) }
}

export interface CodexReadResult {
  readonly account: Record<string, unknown>
  readonly limits: unknown
}

// This short-lived client has no thread, execution, login, logout or token-export methods.
export function readCodexUsage(command: CodexCommand, options: {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  /** Read identity without making a quota request. */
  readonly accountOnly?: boolean
}): Promise<CodexReadResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(new UsageReadError('unavailable')); return }
    const child = spawn(command.executable, [...command.args], {
      cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let finished = false
    let buffer = ''
    let totalBytes = 0
    let expectedId = 1
    let account: Record<string, unknown> | null = null
    let limits: unknown
    const timer = setTimeout(() => finish(new UsageReadError('timeout')), options.timeoutMs ?? 20_000)
    const abort = (): void => finish(new UsageReadError('unavailable'))
    options.signal.addEventListener('abort', abort, { once: true })

    function finish(error?: UsageReadError): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      child.stdin.end()
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      killTimer.unref()
      child.once('close', () => clearTimeout(killTimer))
      if (error || !account) reject(error ?? new UsageReadError('unavailable'))
      else resolve({ account, limits })
    }

    function send(method: string, params?: unknown): void {
      if (!finished) child.stdin.write(`${JSON.stringify({ id: expectedId, method, ...(params === undefined ? {} : { params }) })}\n`)
    }

    function receive(line: string): void {
      if (finished) return
      let message: Record<string, unknown> | null
      try { message = record(JSON.parse(line)) } catch { finish(new UsageReadError('unavailable')); return }
      if (!message) { finish(new UsageReadError('unavailable')); return }
      // Notifications contain no needed data. Deny unexpected server requests.
      if (typeof message.method === 'string') {
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only usage client' } })}\n`)
        return
      }
      if (message.id !== expectedId) return
      if (message.error !== undefined || !record(message.result)) {
        finish(new UsageReadError(record(message.error)?.code === -32601 ? 'update-required' : 'unavailable'))
        return
      }
      const result = record(message.result)!
      if (expectedId === 1) {
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
        expectedId = 2
        send('account/read', { refreshToken: false })
      } else if (expectedId === 2) {
        account = record(result.account)
        if (result.account === null) { finish(new UsageReadError('signed-out')); return }
        if (!account || typeof account.type !== 'string') { finish(new UsageReadError('unavailable')); return }
        if (account.type !== 'chatgpt') { finish(new UsageReadError('unsupported')); return }
        if (options.accountOnly) { finish(); return }
        expectedId = 3
        send('account/rateLimits/read')
      } else if (expectedId === 3) {
        limits = result
        expectedId = 4
        send('account/read', { refreshToken: false })
      } else {
        const after = record(result.account)
        if (!after || after.type !== account?.type || after.email !== account?.email || after.planType !== account?.planType) {
          finish(new UsageReadError('account-changed'))
        } else finish()
      }
    }

    child.on('error', () => finish(new UsageReadError('unavailable')))
    child.stdin.on('error', () => finish(new UsageReadError('unavailable')))
    child.on('close', () => finish(new UsageReadError('unavailable')))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (finished) return
      totalBytes += Buffer.byteLength(chunk)
      if (totalBytes > 1_048_576) { finish(new UsageReadError('unavailable')); return }
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) receive(line)
      }
    })
    send('initialize', { clientInfo: { name: 'laixin_usage_monitor', title: '来信 AI 用量监测', version: '0.1.0' }, capabilities: null })
  })
}

const authoritativeUsageStatuses: readonly UsageStatus[] = ['signed-out', 'unsupported', 'account-changed']

/**
 * 依次尝试每个受信 codex 二进制。账号结论（未登录/不支持/换了账号）是权威答案，
 * ⛔ 换个二进制重试把它盖掉；读不到、超时、二进制太旧这类传输级失败才换下一个——
 * 装 ChatGPT.app 的机器上自带 codex 可能拉不到额度接口，同机 npm 全局包里的正式版往往可用。
 */
export async function readCodexUsageWithFallback(commands: readonly CodexCommand[], options: {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  /** Read identity without making a quota request. */
  readonly accountOnly?: boolean
}): Promise<CodexReadResult> {
  if (commands.length === 0) throw new UsageReadError('not-installed')
  let lastError: unknown = new UsageReadError('unavailable')
  for (const command of commands) {
    try {
      return await readCodexUsage(command, options)
    } catch (error) {
      lastError = error
      if (error instanceof UsageReadError && authoritativeUsageStatuses.includes(error.status)) throw error
    }
  }
  throw lastError
}

/**
 * 只为「已在工具箱登记的账号」读取用量：读到手的账号指纹必须与登记一致，
 * 机器上换了号就按换号处理，⛔ 把别人账号的额度当当前账号显示。
 */
export async function readCodexUsageForAddedAccount(commands: readonly CodexCommand[], options: {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  readonly addedAccountKey: string
}): Promise<CodexReadResult> {
  const data = await readCodexUsageWithFallback(commands, options)
  if (codexAccountKey(data.account) !== options.addedAccountKey) throw new UsageReadError('account-changed')
  return data
}
