// Claude Code 官方登录：由工具箱发起 `claude auth login`，打开官方授权页；官方流程若要求粘贴登录码，
// 由工具箱提供输入面，写回给 CLI。登录状态以 `claude auth status --json` 为准，不伪造。
import { spawn as spawnImpl, execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface ClaudeLoginCommand { readonly executable: string; readonly args: readonly string[] }
export type ClaudeLoginState = 'pending' | 'code-required' | 'succeeded' | 'failed'
export interface ClaudeLoginSession {
  readonly completed: Promise<boolean>
  state(): ClaudeLoginState
  authUrl(): string | undefined
  submitCode(code: string): void
  cancel(): Promise<void>
}
export interface StartClaudeLoginOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: string
  readonly openExternal: (url: string) => Promise<void>
  /** 进程结束后核实是否真的登录了。 */
  readonly statusCheck: () => Promise<boolean>
  readonly spawn?: typeof spawnImpl
  readonly timeoutMs?: number
  /** 兜底保险计时的毫秒数（默认 5 秒）：CLI 一直不问登录码时，等这么久就打开域名兜底。
   * 每出现一条新的域名命中都会重新计时——真正的授权链接可能还在后面。⛔ 用十分钟总超时当兜底，
   * 那时 CLI 已经死了，没有地方粘码。 */
  readonly fallbackAfterMs?: number
}

// 终端控制序列（颜色、光标、OSC 标题）在匹配前先去掉。
// eslint-disable-next-line no-control-regex -- 终端控制序列本身就是控制字符
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g
const URL_PATTERN = /https:\/\/[^\s'"<>)\]]+/g
const CODE_PROMPT = /(paste|enter|input|provide)[^\n]{0,60}code|code[^\n]{0,40}(paste|enter|here)|登录码|授权码|verification code|authorization code/i
const SUCCESS = /login successful|logged in|successfully (logged|authenticated)|登录成功|已登录/i

const authHosts = ['claude.ai', 'anthropic.com', 'console.anthropic.com', 'platform.claude.com', 'claude.com']

function sameAuthHost(value: URL): boolean {
  return authHosts.some((host) => value.hostname === host || value.hostname.endsWith(`.${host}`))
}

/** 授权链接：路径按前缀匹配（兼容结尾斜杠与子路径）。同域名的帮助/文档页不算，⛔ 把浏览器开到错误页面。 */
export function validClaudeAuthUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.pathname.startsWith('/oauth/authorize') && sameAuthHost(url)
  } catch { return false }
}

/** 域名白名单兜底：授权路径形态万一整体对不上，客户也不能面对一片空白。 */
function validClaudeDomainUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && sameAuthHost(url)
  } catch { return false }
}

export function startClaudeLogin(command: ClaudeLoginCommand, options: StartClaudeLoginOptions): ClaudeLoginSession {
  const platform = options.platform ?? process.platform
  // macOS 用 script 给 CLI 一个伪终端，交互提示与粘码才会出现；Windows 直接管道。
  const [executable, args] = platform === 'darwin'
    ? ['/usr/bin/script', ['-q', '/dev/null', command.executable, ...command.args]]
    : [command.executable, [...command.args]]
  const child = (options.spawn ?? spawnImpl)(executable, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let state: ClaudeLoginState = 'pending'
  let url: string | undefined
  let fallbackCandidate: string | undefined
  let cancelled = false
  let buffer = ''
  let bytes = 0
  let finished = false
  let resolveCompletion!: (value: boolean) => void
  const completed = new Promise<boolean>((done) => { resolveCompletion = done })
  const timer = setTimeout(() => finish(false), options.timeoutMs ?? 10 * 60_000)

  /** 兜底必须在会话还活着的时候开：开晚了客户授权完拿到码，已经没有地方粘。 */
  function openFallback(): void {
    if (finished || cancelled || url !== undefined || fallbackCandidate === undefined) return
    url = fallbackCandidate
    clearTimeout(fallbackTimer)
    void options.openExternal(fallbackCandidate).catch(() => undefined)
  }
  // 保险计时：CLI 万一一直不问码，几秒内兜底；每出现一条新的域名命中就重新计时——
  // 真正的授权链接可能还在后面（docs-first 就是这个顺序）。
  let fallbackTimer = setTimeout(() => openFallback(), options.fallbackAfterMs ?? 5_000)

  const stop = (): void => {
    try { child.stdin?.end() } catch { /* 已关闭 */ }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 1_000)
    force.unref()
  }
  const finish = (value: boolean): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearTimeout(fallbackTimer)
    state = value ? 'succeeded' : 'failed'
    stop()
    resolveCompletion(value)
  }
  const consume = (chunk: Buffer): void => {
    bytes += chunk.length
    if (bytes > 1_048_576) { finish(false); return }
    buffer = (buffer + chunk.toString('utf8').replace(ANSI, '')).slice(-8_000)
    const candidates = buffer.match(URL_PATTERN) ?? []
    if (url === undefined) {
      const found = candidates.find((candidate) => validClaudeAuthUrl(candidate))
      if (found) {
        url = found
        clearTimeout(fallbackTimer)
        void options.openExternal(found).catch(() => finish(false))
      }
    }
    for (const candidate of candidates) {
      if (!validClaudeDomainUrl(candidate)) continue
      // 只在候选真的变了的时候重设计时。真实 CLI 挂在伪终端上持续刷新（转圈、“等待授权中…”），
      // 同一条链接每来一块输出都会在 8KB 窗口里被重扫一遍——重复出现也重置的话，计时永远到不了。
      // 「docs 链接先出现、真授权链接还在路上」要重新等：换成新链接才重设，这个原意仍然满足。
      if (fallbackCandidate === candidate) continue
      fallbackCandidate = candidate
      if (url === undefined) {
        clearTimeout(fallbackTimer)
        fallbackTimer = setTimeout(() => openFallback(), options.fallbackAfterMs ?? 5_000)
      }
    }
    if (SUCCESS.test(buffer)) { finish(true); return }
    // CLI 开始问登录码＝地址已经打印完了：这时若还没有任何授权形态的链接被打开，立刻兜底。
    if (state === 'pending' && CODE_PROMPT.test(buffer)) { state = 'code-required'; openFallback() }
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.once('error', () => finish(false))
  child.once('close', () => {
    if (finished) return
    void options.statusCheck().then((ok) => finish(ok), () => finish(false))
  })
  return {
    completed,
    state: () => state,
    authUrl: () => url,
    submitCode(code: string) {
      const trimmed = code.trim()
      if (finished || !trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) return
      state = 'pending'
      buffer = ''
      try { child.stdin?.write(`${trimmed}\n`) } catch { finish(false) }
    },
    async cancel() { cancelled = true; finish(false) }
  }
}

/** `claude auth status --json`：只认明确的已登录字段；任何异常都当未登录。 */
export async function readClaudeAuthStatus(command: ClaudeLoginCommand, env: NodeJS.ProcessEnv = process.env, exec = execFile): Promise<boolean> {
  try {
    const { stdout } = await exec(command.executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, env, windowsHide: true })
    const text = String(stdout)
    const start = text.indexOf('{')
    if (start >= 0) {
      const data = JSON.parse(text.slice(start)) as Record<string, unknown>
      for (const key of ['loggedIn', 'authenticated', 'isAuthenticated', 'isLoggedIn']) if (data[key] === true) return true
      if (data.status === 'authenticated' || data.status === 'logged_in') return true
      return false
    }
    return /logged in/i.test(text) && !/not logged in/i.test(text)
  } catch { return false }
}

export type ClaudeOfficialLoginStatus = 'idle' | 'pending' | 'code-required' | 'connected' | 'failed' | 'not-installed'

export interface ClaudeOfficialLoginControllerDeps {
  readonly findCommand: () => Promise<ClaudeLoginCommand | null>
  readonly startLogin: (command: ClaudeLoginCommand) => ClaudeLoginSession
  readonly useOfficial: (shell: 'claude') => Promise<unknown>
}

export class ClaudeOfficialLoginController {
  private current: ClaudeOfficialLoginStatus = 'idle'
  private generation = 0
  private session: ClaudeLoginSession | undefined
  constructor(private readonly deps: ClaudeOfficialLoginControllerDeps) {}

  status(): { readonly status: ClaudeOfficialLoginStatus } {
    if (this.session && (this.current === 'pending' || this.current === 'code-required')) {
      const live = this.session.state()
      if (live === 'code-required') this.current = 'code-required'
      else if (live === 'pending') this.current = 'pending'
    }
    return { status: this.current }
  }

  async start(): Promise<{ readonly status: ClaudeOfficialLoginStatus }> {
    if (this.current === 'pending' || this.current === 'code-required') return this.status()
    const generation = ++this.generation
    this.current = 'pending'
    let command: ClaudeLoginCommand | null
    try { command = await this.deps.findCommand() } catch { command = null }
    if (command === null) { if (generation === this.generation) this.current = 'not-installed'; return this.status() }
    let session: ClaudeLoginSession
    try { session = this.deps.startLogin(command) } catch { if (generation === this.generation) this.current = 'failed'; return this.status() }
    this.session = session
    void session.completed.then(async (succeeded) => {
      if (generation !== this.generation) return
      this.session = undefined
      if (!succeeded) { this.current = 'failed'; return }
      try { await this.deps.useOfficial('claude'); if (generation === this.generation) this.current = 'connected' }
      catch { if (generation === this.generation) this.current = 'failed' }
    })
    return this.status()
  }

  submitCode(code: string): { readonly status: ClaudeOfficialLoginStatus } {
    this.session?.submitCode(code)
    return this.status()
  }

  async cancel(): Promise<{ readonly status: ClaudeOfficialLoginStatus }> {
    ++this.generation
    const session = this.session
    this.session = undefined
    this.current = 'idle'
    await session?.cancel()
    return this.status()
  }
}
