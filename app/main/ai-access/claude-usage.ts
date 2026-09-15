import { spawn } from 'node:child_process'
import { label, record } from '../codex-usage/normalize'
import type { PlanQuota, PlanQuotaWindow } from '../../shared/plan-usage-types'

export interface ClaudeQuotaResult { readonly status: 'plan' | 'official-unavailable'; readonly plan: PlanQuota | null }
const unavailable: ClaudeQuotaResult = { status: 'official-unavailable', plan: null }

/** Official Claude Code get_usage response; no transcript, credential or session content is returned. */
export function parseClaudeQuota(value: unknown): ClaudeQuotaResult {
  const data = record(value), limits = record(data?.rate_limits)
  if (data?.rate_limits_available !== true || !limits) return unavailable
  const windows: PlanQuotaWindow[] = []
  const add = (id: string, name: string, value: unknown): void => {
    const row = record(value)
    if (!row) return
    const used = typeof row.utilization === 'number' && Number.isFinite(row.utilization) && row.utilization >= 0 ? Math.min(100, row.utilization) : null
    const reset = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN
    windows.push({ id, name, usedPercent: used, remainingPercent: used === null ? null : 100 - used, used: null, limit: null, resetsAt: Number.isFinite(reset) ? reset : null })
  }
  for (const [id, name] of [['five_hour', '5 小时额度'], ['seven_day', '每周额度'], ['seven_day_oauth_apps', 'OAuth 应用每周额度'], ['seven_day_opus', 'Opus 每周额度'], ['seven_day_sonnet', 'Sonnet 每周额度']]) add(id, name, limits[id])
  if (Array.isArray(limits.model_scoped)) limits.model_scoped.slice(0, 16).forEach((row, index) => add(`model-${index}`, label(record(row)?.display_name, 60) ?? '模型每周额度', row))
  return windows.length ? { status: 'plan', plan: { level: label(data.subscription_type, 40), windows } } : unavailable
}

// Start the official CLI with no prompt, tools, MCP servers, project settings or session persistence.
// Only initialize and get_usage are sent; skip_behaviors prevents scanning local conversations.
export function readClaudeQuota(command: { executable: string; args?: readonly string[] }, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000, signal?: AbortSignal): Promise<ClaudeQuotaResult> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(unavailable); return }
    const child = spawn(command.executable, [...(command.args ?? []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''],
    { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let done = false, bytes = 0, buffer = '', request = 'initialize'
    const timer = setTimeout(() => finish(unavailable), timeoutMs)
    const finish = (result: ClaudeQuotaResult): void => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.stdin.end(); child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref()
      child.once('close', () => clearTimeout(force)); resolve(result)
    }
    const abort = (): void => finish(unavailable)
    signal?.addEventListener('abort', abort, { once: true })
    const send = (subtype: string): void => { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: subtype, request: { subtype, ...(subtype === 'get_usage' ? { skip_behaviors: true } : {}) } }) + '\n') }
    child.on('error', () => finish(unavailable)); child.stdin.on('error', () => finish(unavailable)); child.on('close', () => finish(unavailable))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (done) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1_048_576) { finish(unavailable); return }
      buffer += chunk
      let end: number
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          const message = record(JSON.parse(line))
          if (message?.type === 'control_request') { finish(unavailable); return }
          if (message?.type !== 'control_response') continue
          const response = record(message.response)
          if (response?.request_id !== request) continue
          if (response.subtype !== 'success') { finish(unavailable); return }
          if (request === 'initialize') { request = 'get_usage'; send(request) }
          else finish(parseClaudeQuota(response.response))
        } catch { finish(unavailable) }
      }
    })
    send(request)
  })
}
