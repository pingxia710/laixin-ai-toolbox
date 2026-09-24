import { spawn } from 'node:child_process'
import type { CodexCommand } from '../codex-usage/runtime'
import type { CodexWorkspaceSource } from './codex-workspace-sources'

export interface CodexWorkspaceLaunchOptions {
  readonly cwd: string
  readonly codexHome: string
  readonly source: CodexWorkspaceSource
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

export interface CodexWorkspaceLaunchResult {
  readonly threadId: string
  readonly provider: string
  readonly model: string
}

/** Creates and materializes one native Codex thread, then always stops its temporary app-server. */
export async function launchCodexWorkspaceThread(command: CodexCommand, options: CodexWorkspaceLaunchOptions): Promise<CodexWorkspaceLaunchResult> {
  const child = spawn(command.executable, [...command.args], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), CODEX_HOME: options.codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let buffer = ''
  let totalBytes = 0
  let nextId = 1
  let finished = false
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const timeout = setTimeout(() => failAll(new Error('CODEX_WORKSPACE_TIMEOUT')), options.timeoutMs ?? 15_000)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))

  const request = (method: string, params?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (finished) { reject(new Error('CODEX_WORKSPACE_UNAVAILABLE')); return }
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`)
  })
  const notify = (method: string): void => { if (!finished) child.stdin.write(`${JSON.stringify({ method })}\n`) }

  function failAll(error: Error): void {
    if (finished) return
    finished = true
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  child.on('error', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdin.on('error', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.on('close', () => failAll(new Error('CODEX_WORKSPACE_UNAVAILABLE')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (finished) return
    totalBytes += Buffer.byteLength(chunk)
    if (totalBytes > 1_048_576) { failAll(new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')); return }
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      receive(line)
    }
  })

  function receive(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      const object = record(parsed)
      if (object === undefined) throw new Error()
      message = object
    } catch { failAll(new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')); return }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })}\n`)
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error('CODEX_WORKSPACE_REQUEST_FAILED'))
    else waiter.resolve(message.result)
  }

  try {
    await request('initialize', { clientInfo: { name: 'laixin_codex_workspace', title: '来信 AI 工作窗口', version: '0.5.17' }, capabilities: null })
    notify('initialized')
    const startParams: Record<string, unknown> = { cwd: options.cwd, modelProvider: options.source.provider, ephemeral: false }
    if (options.source.model !== undefined) startParams.model = options.source.model
    const started = record(await request('thread/start', startParams))
    const thread = record(started?.thread)
    const threadId = typeof thread?.id === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(thread.id) ? thread.id : undefined
    const provider = typeof started?.modelProvider === 'string' ? started.modelProvider : undefined
    const model = typeof started?.model === 'string' ? started.model : undefined
    if (threadId === undefined || provider !== options.source.provider || model === undefined ||
      (options.source.model !== undefined && model !== options.source.model)) throw new Error('CODEX_WORKSPACE_PROTOCOL_INVALID')
    await request('thread/inject_items', {
      threadId,
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `Laixin source binding: ${options.source.id}.` }] }]
    })
    await request('thread/name/set', { threadId, name: options.source.title })
    return { threadId, provider, model }
  } finally {
    clearTimeout(timeout)
    finished = true
    child.stdin.end()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
    force.unref()
    await closed
    clearTimeout(force)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
