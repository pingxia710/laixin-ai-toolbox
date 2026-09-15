import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { codexAccountKey, label, maskAccount, record } from '../codex-usage/normalize'
import { readCodexUsage, UsageReadError } from '../codex-usage/client'
import type { CodexCommand } from '../codex-usage/runtime'
import type { OfficialAccount, OfficialAccountState } from '../../shared/official-account'

const execFile = promisify(execFileCallback)
const empty = (state: OfficialAccountState): OfficialAccount => ({ state, accountLabel: null, plan: null })

export async function readCodexOfficialAccount(command: CodexCommand | null, cwd: string, env?: NodeJS.ProcessEnv): Promise<OfficialAccount> {
  if (!command) return empty('not-installed')
  try {
    const { account } = await readCodexUsage(command, { cwd, env, signal: new AbortController().signal, accountOnly: true })
    return { state: 'signed-in', accountKey: codexAccountKey(account), accountLabel: maskAccount(account.email), plan: label(account.planType, 40) }
  } catch (error) {
    return empty(error instanceof UsageReadError && (error.status === 'signed-out' || error.status === 'unsupported') ? error.status : 'unavailable')
  }
}

/** CLI status returns identity only; raw output and credentials never cross the bridge. */
export function parseClaudeOfficialAccount(stdout: string): OfficialAccount {
  try {
    const data = record(JSON.parse(stdout.slice(stdout.indexOf('{'))))
    if (!data || typeof data.loggedIn !== 'boolean') return empty('unavailable')
    if (!data.loggedIn) return empty('signed-out')
    if (data.authMethod !== 'claude.ai') return empty('unsupported')
    return { state: 'signed-in', accountKey: codexAccountKey({ email: data.email, orgId: data.orgId }), accountLabel: typeof data.email === 'string' ? maskAccount(data.email) : 'Claude 账号', plan: label(data.subscriptionType, 40) }
  } catch { return empty('unavailable') }
}

export async function readClaudeOfficialAccount(executable: string | null, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<OfficialAccount> {
  if (!executable) return empty('not-installed')
  try {
    // 只读的身份查询，超时直接 SIGKILL：子进程忽略 SIGTERM 时 execFile 的 Promise 会永不决，客户卡在「正在确认账号…」（ui.5–ui.9 独立验收 P2-1）。
    const { stdout } = await execFile(executable, ['auth', 'status', '--json'], { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true })
    return parseClaudeOfficialAccount(stdout)
  } catch (error) {
    // The official CLI exits with 1 when signed out; transport/launch errors stay unknown.
    const result = error as { code?: unknown; stdout?: unknown }
    if (result.code === 1 && typeof result.stdout === 'string') return parseClaudeOfficialAccount(result.stdout)
    return empty('unavailable')
  }
}
