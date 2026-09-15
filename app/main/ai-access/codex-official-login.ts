import { spawn } from 'node:child_process'

export interface CodexLoginCommand {
  readonly executable: string
  readonly args: readonly string[]
  /** Main-process-only environment selected with the verified Codex configuration root. */
  readonly environment?: NodeJS.ProcessEnv
}

export interface CodexChatGptLogin {
  readonly completed: Promise<boolean>
  cancel(): Promise<void>
}

export interface StartCodexLoginOptions {
  readonly cwd: string
  readonly openExternal: (url: string) => Promise<void>
  readonly timeoutMs?: number
  /** 整场登录的总超时（默认 10 分钟，与 Claude 登录一致）：浏览器开着但客户放弃时把会话收干净，
   * ⛔ 让控制器停在 pending、只能重启 App。 */
  readonly overallTimeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

export async function startCodexChatGptLogin(command: CodexLoginCommand, options: StartCodexLoginOptions): Promise<CodexChatGptLogin> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: options.cwd, env: command.environment ?? options.env ?? process.env, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let bytes = 0
    let buffer = ''
    let loginId: string | undefined
    let started = false
    let finished = false
    let resolveCompletion!: (value: boolean) => void
    const completed = new Promise<boolean>((done) => { resolveCompletion = done })
    const timer = setTimeout(() => failStart(), options.timeoutMs ?? 20_000)
    // 总超时从发起就计：浏览器打开后 20 秒的启动计时器会被清掉，整场授权仍要有终点。
    const overallTimer = setTimeout(() => finish(false), options.overallTimeoutMs ?? 10 * 60_000)
    const session: CodexChatGptLogin = {
      completed,
      async cancel() {
        if (finished || loginId === undefined) return
        send(3, 'account/login/cancel', { loginId })
        setTimeout(() => finish(false), 1_000).unref()
      }
    }

    function stop(): void {
      child.stdin.end()
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 1_000)
      force.unref()
      child.once('close', () => clearTimeout(force))
    }

    function failStart(): void {
      if (finished) return
      if (started) { finish(false); return }
      finished = true
      clearTimeout(timer)
      clearTimeout(overallTimer)
      stop()
      reject(new Error('AI_ACCESS_CODEX_LOGIN_FAILED'))
    }

    function resolveStarted(): void {
      if (started) return
      started = true
      clearTimeout(timer)
      resolve(session)
    }

    function finish(value: boolean): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(overallTimer)
      resolveStarted()
      resolveCompletion(value)
      stop()
    }

    function send(id: number, method: string, params?: unknown): void {
      if (!finished) child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`)
    }

    async function received(line: string): Promise<void> {
      let message: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line)
        if (!record(parsed)) throw new Error('invalid')
        message = parsed
      } catch { failStart(); return }
      if (typeof message.method === 'string') {
        if (message.method === 'account/login/completed') {
          const params = record(message.params) ? message.params : undefined
          if (params !== undefined && params.loginId === loginId && typeof params.success === 'boolean') finish(params.success)
        }
        return
      }
      if (message.id === 1) {
        if (message.error !== undefined) { failStart(); return }
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
        send(2, 'account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' })
        return
      }
      if (message.id !== 2 || message.error !== undefined || !record(message.result) || message.result.type !== 'chatgpt' ||
        typeof message.result.loginId !== 'string' || typeof message.result.authUrl !== 'string' || !validHttpsUrl(message.result.authUrl)) {
        failStart(); return
      }
      if (loginId !== undefined) { failStart(); return }
      loginId = message.result.loginId
      try {
        await options.openExternal(message.result.authUrl)
      } catch { failStart(); return }
      resolveStarted()
    }

    child.on('error', failStart)
    child.on('close', () => { if (!finished) failStart() })
    child.stdin.on('error', failStart)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1_048_576) { failStart(); return }
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) void received(line)
      }
    })
    send(1, 'initialize', { clientInfo: { name: 'laixin_ai_toolbox', title: '来信 AI 工具箱', version: '0.4.6' }, capabilities: null })
  })
}

export type CodexOfficialLoginStatus = 'idle' | 'pending' | 'connected' | 'failed'

export interface CodexOfficialLoginControllerDeps {
  readonly findCommand: () => Promise<CodexLoginCommand | null>
  readonly startLogin: (command: CodexLoginCommand) => Promise<CodexChatGptLogin>
  readonly useOfficial: (shell: 'codex') => Promise<unknown>
}

/** Keeps a browser OAuth ceremony separate from the selected shell mode. */
export class CodexOfficialLoginController {
  private current: CodexOfficialLoginStatus = 'idle'
  private generation = 0
  private pending: CodexChatGptLogin | undefined

  constructor(private readonly deps: CodexOfficialLoginControllerDeps) {}

  status(): { readonly status: CodexOfficialLoginStatus } {
    return { status: this.current }
  }

  async start(): Promise<{ readonly status: CodexOfficialLoginStatus }> {
    if (this.current === 'pending') return this.status()
    const generation = ++this.generation
    this.current = 'pending'
    let command: CodexLoginCommand | null
    try { command = await this.deps.findCommand() } catch {
      if (generation === this.generation) this.current = 'failed'
      throw new Error('AI_ACCESS_CODEX_LOGIN_FAILED')
    }
    if (command === null) {
      if (generation === this.generation) this.current = 'idle'
      throw new Error('AI_ACCESS_CODEX_NOT_INSTALLED')
    }
    let pending: CodexChatGptLogin
    try {
      pending = await this.deps.startLogin(command)
    } catch {
      if (generation === this.generation) this.current = 'failed'
      throw new Error('AI_ACCESS_CODEX_LOGIN_FAILED')
    }
    this.pending = pending
    void pending.completed.then(async (succeeded) => {
      if (generation !== this.generation) return
      this.pending = undefined
      if (!succeeded) { this.current = 'failed'; return }
      try {
        await this.deps.useOfficial('codex')
        if (generation === this.generation) this.current = 'connected'
      } catch {
        if (generation === this.generation) this.current = 'failed'
      }
    }, () => {
      if (generation === this.generation) { this.pending = undefined; this.current = 'failed' }
    })
    return this.status()
  }

  async cancel(): Promise<{ readonly status: CodexOfficialLoginStatus }> {
    ++this.generation
    const pending = this.pending
    this.pending = undefined
    this.current = 'idle'
    await pending?.cancel()
    return this.status()
  }
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'))
  } catch { return false }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
