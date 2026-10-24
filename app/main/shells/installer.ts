// 调官方安装方式装壳：npm 包走 npm（注册表多源回退），脚本走官方安装脚本（通道可用时经通道），应用类打开官方页。
// 一次只跑一个安装任务；结果只报「装好了/没装好 + 原因类别 + 输出尾部」。
import { spawn } from 'node:child_process'
import { npmRegistries, type Recipes, type ShellId } from '../recipes/recipes'
import { resolveCommand } from './win-command'
import type { ShellInventory, ShellInventoryEntry } from './inventory'

export type InstallPhase = 'idle' | 'running' | 'succeeded' | 'failed'
export interface InstallJob {
  readonly shell: ShellId
  readonly phase: InstallPhase
  readonly startedAt: string
  readonly finishedAt: string
  readonly attempt: number
  readonly message: string
  /** 输出尾部（最多 40 行），供诊断与客服。 */
  readonly log: readonly string[]
  readonly after?: ShellInventoryEntry
}

export interface InstallerDeps {
  readonly platform: string
  readonly recipes: () => Recipes
  readonly inventory: ShellInventory
  /** 通道可用时的本机代理地址（http://127.0.0.1:port），没有则 undefined。 */
  readonly proxyUrl: () => string | undefined
  readonly spawn?: typeof spawn
  readonly timeoutMs?: number
  /** 超时后先 SIGTERM,再等这么久仍不退就连整个进程组一起 SIGKILL。 */
  readonly killGraceMs?: number
  /** running 超过这么久就按卡死处理,允许新任务顶掉——⛔ 让客户点什么都只拿到旧任务。 */
  readonly stallMs?: number
}

export class ShellInstaller {
  private job: InstallJob = { shell: 'codex', phase: 'idle', startedAt: '', finishedAt: '', attempt: 0, message: '', log: [] }
  /** 每启动一单加一;被顶掉的旧任务据此不再往回写状态。 */
  private generation = 0
  constructor(private readonly deps: InstallerDeps) {}

  status(): InstallJob { return this.job }

  /** 启动安装；已有任务在跑时返回当前任务——除非它已经卡过了阈值。 */
  start(shell: ShellId): InstallJob {
    if (this.job.phase === 'running' && !this.stalled()) return this.job
    const generation = ++this.generation
    const recipe = this.deps.recipes().shells[shell]
    const command = recipe.install?.[this.deps.platform as 'darwin' | 'win32']
    if (!command) {
      this.job = { shell, phase: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempt: 0, message: 'no-command', log: [] }
      return this.job
    }
    this.job = { shell, phase: 'running', startedAt: new Date().toISOString(), finishedAt: '', attempt: 1, message: '', log: [] }
    void this.run(generation, shell, command)
    return this.job
  }

  /** 卡死判定:超时与收尸的时间都过完了还停在 running,就当它回不来,放行新任务。
   * ⛔ 无条件返回旧任务:实测过「点 Claude Code 却拿到 codex 的旧任务」,界面从此再也动不了。 */
  private stalled(): boolean {
    const startedAt = Date.parse(this.job.startedAt)
    if (!Number.isFinite(startedAt)) return true
    const limit = this.deps.stallMs ?? (this.deps.timeoutMs ?? 15 * 60_000) + (this.deps.killGraceMs ?? 1_000) + 60_000
    return Date.now() - startedAt > limit
  }

  private async run(generation: number, shell: ShellId, command: readonly string[]): Promise<void> {
    const attempts = this.attempts(shell, command)
    let log: string[] = []
    for (let index = 0; index < attempts.length; index++) {
      const { argv, env, label } = attempts[index]
      if (generation !== this.generation) return
      this.job = { ...this.job, attempt: index + 1, message: label, log }
      const result = await this.execute(argv, env)
      log = [...log, `[${label}]`, ...result.lines].slice(-40)
      if (generation !== this.generation) return
      if (result.ok) {
        const after = await this.deps.inventory.inspect(shell)
        if (generation !== this.generation) return
        const succeeded = after.installed === true
        this.job = { ...this.job, phase: succeeded ? 'succeeded' : 'failed', finishedAt: new Date().toISOString(),
          message: succeeded ? 'installed' : 'not-detected', log, after }
        return
      }
    }
    if (generation !== this.generation) return
    this.job = { ...this.job, phase: 'failed', finishedAt: new Date().toISOString(), message: 'command-failed', log }
  }

  /** 多源回退：npm 依次换注册表；脚本类先直连再走通道。 */
  private attempts(shell: ShellId, command: readonly string[]): { argv: readonly string[]; env: NodeJS.ProcessEnv; label: string }[] {
    const base = this.deps.inventory.environment()
    const proxy = this.deps.proxyUrl()
    const withProxy = proxy ? { ...base, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : undefined
    if (command[0] === 'npm') {
      const list = npmRegistries.map((registry, index) => ({ argv: [...command, '--registry', registry], env: base, label: `npm 源 ${index + 1}` }))
      return withProxy ? [...list, { argv: [...command, '--registry', npmRegistries[0]], env: withProxy, label: 'npm 经 AI网络' }] : list
    }
    const attempts = [{ argv: command, env: base, label: '官方安装脚本（直连）' }]
    if (withProxy) attempts.push({ argv: command, env: withProxy, label: '官方安装脚本（经 AI网络）' })
    return attempts
  }

  private execute(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; lines: string[] }> {
    return new Promise((resolve) => {
      const lines: string[] = []
      const push = (chunk: Buffer) => { for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) lines.push(line.slice(0, 300)) }
      let settled = false
      const timers: NodeJS.Timeout[] = []
      const settle = (ok: boolean, extra: readonly string[] = []) => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        resolve({ ok, lines: [...lines, ...extra].slice(-40) })
      }
      let child: ReturnType<typeof spawn>
      // Windows 上 npm 是 npm.cmd:直接 spawn 恒 ENOENT,给全路径也会因 CVE-2024-27980 的修复抛 EINVAL。
      const resolved = resolveCommand(this.deps.platform, argv[0], argv.slice(1), env)
      try {
        child = (this.deps.spawn ?? spawn)(resolved.file, [...resolved.args], {
          env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          // 自成一个进程组,超时时才能把 `bash -lc 'curl … | bash'` 的孙进程一起收掉;
          // Windows 没有进程组,那边靠 taskkill /T 按父子关系收。
          ...(this.deps.platform === 'win32' ? {} : { detached: true }),
          ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
        })
      } catch (error) { settle(false, [`spawn failed: ${(error as Error).message}`]); return }
      timers.push(setTimeout(() => {
        lines.push('timeout')
        this.killTree(child, 'SIGTERM', false)
        timers.push(setTimeout(() => {
          this.killTree(child, 'SIGKILL', true)
          // 孙进程攥着同一根 stdout 时 'close' 永远不会来,⛔ 再等它——那一等就是永远卡在「正在安装」。
          settle(false, ['killed'])
        }, this.deps.killGraceMs ?? 1_000))
      }, this.deps.timeoutMs ?? 15 * 60_000))
      child.stdout?.on('data', push); child.stderr?.on('data', push)
      child.once('error', (error) => settle(false, [`error: ${error.message}`]))
      child.once('close', (code) => settle(code === 0))
    })
  }

  /** 收掉整棵进程树:只杀直接子进程等于没杀——官方安装脚本几乎都是父进程再起孙进程。 */
  private killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, force: boolean): void {
    const pid = child.pid
    if (!pid) return
    if (this.deps.platform === 'win32') {
      // Windows 没有进程组信号;taskkill /T 按父子关系整棵收,先礼(不带 /F)后兵(/F)。
      try {
        (this.deps.spawn ?? spawn)('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
      } catch { /* taskkill 起不来就退回单进程处理。 */ }
      try { child.kill(signal) } catch { /* 已经没了。 */ }
      return
    }
    // detached 让子进程自成一组,负 pid 把这一组全收掉;组不在了就退回只杀它自己。
    try { process.kill(-pid, signal) } catch { try { child.kill(signal) } catch { /* 已经没了。 */ } }
  }
}
