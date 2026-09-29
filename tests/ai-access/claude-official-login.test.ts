import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { ClaudeOfficialLoginController, readClaudeAuthStatus, startClaudeLogin, validClaudeAuthUrl } from '../../app/main/ai-access/claude-official-login'

const fixture = resolve('tests/ai-access/fixtures/claude-login-cli.mjs')
const command = (...extra: string[]) => ({ executable: process.execPath, args: [fixture, ...extra] })
const outputCommand = (text: string, delay = 30) => ({ executable: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)}); setTimeout(() => process.exit(0), ${delay})`] })
const options = (openExternal = vi.fn(async () => undefined), statusCheck = vi.fn(async () => false)) => ({ cwd: process.cwd(), platform: 'linux', openExternal, statusCheck, timeoutMs: 5_000 })

describe('Claude 官方登录', () => {
  it('打开官方授权页，出现粘码提示后进入 code-required，提交正确登录码后成功', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command(), options(openExternal, vi.fn(async () => true)))
    await vi.waitFor(() => expect(session.state()).toBe('code-required'))
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?client_id=test&state=abc')
    session.submitCode(' code-1234 ')
    await expect(session.completed).resolves.toBe(true)
    expect(session.state()).toBe('succeeded')
  })

  it('登录码错误 → 失败；进程直接退出时以 auth status 核实为准', async () => {
    const bad = startClaudeLogin(command('bad'), options())
    await vi.waitFor(() => expect(bad.state()).toBe('code-required'))
    bad.submitCode('wrong')
    await expect(bad.completed).resolves.toBe(false)
    const statusCheck = vi.fn(async () => true)
    const exited = startClaudeLogin(command('exit'), options(vi.fn(async () => undefined), statusCheck))
    await expect(exited.completed).resolves.toBe(true)
    expect(statusCheck).toHaveBeenCalled()
  })

  it('只接受 Anthropic/Claude 域名的授权链接', () => {
    expect(validClaudeAuthUrl('https://claude.ai/oauth/authorize?x=1')).toBe(true)
    expect(validClaudeAuthUrl('https://console.anthropic.com/oauth/authorize?x=1')).toBe(true)
    expect(validClaudeAuthUrl('https://evil.example/claude.ai')).toBe(false)
    expect(validClaudeAuthUrl('http://claude.ai/x')).toBe(false)
  })

  it('授权路径按前缀匹配：兼容结尾斜杠和子路径（第 4 轮返修）', () => {
    expect(validClaudeAuthUrl('https://claude.ai/oauth/authorize/')).toBe(true)
    expect(validClaudeAuthUrl('https://platform.claude.com/oauth/authorize/step?x=1')).toBe(true)
    expect(validClaudeAuthUrl('https://claude.ai/oauth/authorize')).toBe(true)
  })

  it('同域名下的帮助/文档页不算授权链接，⛔ 把浏览器开到错误页面（第 4 轮防御）', () => {
    expect(validClaudeAuthUrl('https://docs.anthropic.com/en/docs/claude-code/troubleshooting')).toBe(false)
    expect(validClaudeAuthUrl('https://claude.ai/en/docs/help')).toBe(false)
    expect(validClaudeAuthUrl('https://console.anthropic.com/oauth')).toBe(false)
  })

  it('CLI 先打印帮助链接时，打开的仍是真正的授权页（第 4 轮防御）', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command('docs-first'), options(openExternal, vi.fn(async () => true)))
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?client_id=test&state=abc')
    expect(session.authUrl()).toBe('https://claude.ai/oauth/authorize?client_id=test&state=abc')
    await expect(session.completed).resolves.toBe(true)
  })

  it('兜底在会话活着时开：CLI 问码而没有任何授权形态链接被打开，立刻打开域名命中的最后一条，之后仍能粘码走到成功（第 4 轮返修）', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command('domain-only-hang'), options(openExternal, vi.fn(async () => true)))
    // ⛔ 先 await completed 再断言：浏览器必须开在会话还活着的时候（触发点＝开始问登录码）。
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(session.state()).toBe('code-required')
    expect(session.authUrl()).toBe('https://claude.ai/login?client_id=test&state=abc')
    // 兜底打开之后，这次登录仍然能走到成功：粘码 → 成功。
    session.submitCode('code-1234')
    await expect(session.completed).resolves.toBe(true)
    expect(session.state()).toBe('succeeded')
  })

  it('CLI 一直不问码：几秒量级的保险计时兜底，⛔ 拖到十分钟总超时才开（第 4 轮返修）', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command('domain-only-silent'), { ...options(openExternal), timeoutMs: 2_000, fallbackAfterMs: 150 })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    // 开在会话活着的时候：此刻既没成功也没失败。
    expect(session.state()).toBe('pending')
    await expect(session.completed).resolves.toBe(false)
  })

  it('CLI 持续刷新（转圈、“等待授权中”）时保险计时照样触发：同一条链接重复出现不重置计时（第 4 轮返修 2）', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command('domain-only-chatty'), { ...options(openExternal), timeoutMs: 5_000, fallbackAfterMs: 150 })
    // 真实 CLI 挂在伪终端上每 50ms 刷一行，同一条链接一直在窗口里被重扫——
    // 保险计时若被重复链接归零，1.5 秒内什么都不会开（fallbackAfterMs 只有 150ms）。
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1), { timeout: 1_500 })
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/login?client_id=test&state=abc')
    // 开在会话活着的时候。
    expect(session.state()).toBe('pending')
    await session.cancel()
  })

  it('客户主动取消（兜底还没触发）不弹窗；CLI 直接失败退出也不开——已经没有地方粘码（第 4 轮返修）', async () => {
    const cancelOpen = vi.fn(async () => undefined)
    const cancelled = startClaudeLogin(command('domain-only-silent'), { ...options(cancelOpen), timeoutMs: 1_500, fallbackAfterMs: 60_000 })
    cancelled.cancel()
    await expect(cancelled.completed).resolves.toBe(false)
    expect(cancelOpen).not.toHaveBeenCalled()

    const deadEndOpen = vi.fn(async () => undefined)
    const deadEnd = startClaudeLogin(command('domain-only-fail'), options(deadEndOpen))
    await expect(deadEnd.completed).resolves.toBe(false)
    expect(deadEndOpen).not.toHaveBeenCalled()
  })

  it('auth status --json 只认明确的已登录字段', async () => {
    const exec = (async () => ({ stdout: 'noise\n{"loggedIn":true,"email":"x"}', stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, exec)).toBe(true)
    const no = (async () => ({ stdout: '{"loggedIn":false}', stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, no)).toBe(false)
    const boom = (async () => { throw new Error('not installed') }) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, boom)).toBe(false)
  })

  it.each(['You are not logged in.\n', 'Not logged in. Run /login.\n', 'You are not currently logged in.\n', 'You are no longer logged in.\n'])('否定句不触发成功核实：%s', async text => {
    const statusCheck = vi.fn(async () => false)
    const session = startClaudeLogin(outputCommand(text, 200), options(undefined, statusCheck))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(session.state()).toBe('pending')
    expect(statusCheck).not.toHaveBeenCalled()
    await expect(session.completed).resolves.toBe(false)
    expect(statusCheck).toHaveBeenCalledTimes(1)
  })

  it('肯定成功文字也必须以状态复核为准，未登录不能成功', async () => {
    const statusCheck = vi.fn(async () => false)
    const session = startClaudeLogin(outputCommand('Login successful. You are now logged in.\n'), options(undefined, statusCheck))
    await expect(session.completed).resolves.toBe(false)
    expect(statusCheck).toHaveBeenCalled()
  })

  it.each(['not-ready', 'transient-error'])('成功提示早于凭据状态可用（%s）时，退出复核仍能成功', async mode => {
    const statusCheck = vi.fn(async () => true)
    if (mode === 'not-ready') statusCheck.mockResolvedValueOnce(false)
    else statusCheck.mockRejectedValueOnce(new Error('fixture status not ready'))
    const session = startClaudeLogin(outputCommand('Login successful.\n', 100), options(undefined, statusCheck))
    await expect(session.completed).resolves.toBe(true)
    expect(statusCheck).toHaveBeenCalledTimes(2)
  })

  it('成功提示重复刷新时只启动一次提前核实；取消后迟到的成功不生效', async () => {
    let resolveStatus!: (value: boolean) => void
    const statusCheck = vi.fn(() => new Promise<boolean>(resolve => { resolveStatus = resolve }))
    const cmd = { executable: process.execPath, args: ['-e', 'setInterval(() => process.stdout.write("Login successful.\\n"), 10)'] }
    const session = startClaudeLogin(cmd, options(undefined, statusCheck))
    try {
      await vi.waitFor(() => expect(statusCheck).toHaveBeenCalledTimes(1))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(statusCheck).toHaveBeenCalledTimes(1)
      await session.cancel()
      resolveStatus(true)
      await expect(session.completed).resolves.toBe(false)
      expect(session.state()).toBe('failed')
    } finally { await session.cancel() }
  })

  it.each([
    { loggedIn: true, authMethod: 'api_key' },
    { authenticated: true, authMethod: 'api_key' },
    { status: 'authenticated', authMethod: 'api_key' }
  ])('API Key 认证不是官方订阅登录：%j', async data => {
    const exec = (async () => ({ stdout: JSON.stringify(data), stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, exec)).toBe(false)
  })

  it.each([
    { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
    { loggedIn: true }, { authenticated: true }, { isAuthenticated: true }, { isLoggedIn: true },
    { status: 'authenticated' }, { status: 'logged_in' }
  ])('标准 OAuth 和旧版缺认证方式字段的明确已登录状态保留：%j', async data => {
    const exec = (async () => ({ stdout: `noise\n${JSON.stringify(data)}\nstatus read complete`, stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, exec)).toBe(true)
  })

  it.each([
    ['Logged in as demo@example.test\n', true],
    ['You are not logged in\n', false],
    ['You are no longer logged in.\n', false],
    ['Logged in with an API key\n', false]
  ])('旧文本状态仍区分官方登录与 API Key：%s', async (stdout, expected) => {
    const exec = (async () => ({ stdout, stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, exec)).toBe(expected)
  })

  it.each([
    ['Login successful.\n', '{"loggedIn":true,"authMethod":"api_key"}'],
    ['You are no longer logged in.\n', 'You are no longer logged in.\n']
  ])('控制器不会因文案 %s 和不支持的状态切到官方订阅', async (banner, status) => {
    const useOfficial = vi.fn(async () => undefined)
    const exec = (async () => ({ stdout: status, stderr: '' })) as never
    const cmd = outputCommand(banner)
    const controller = new ClaudeOfficialLoginController({
      findCommand: async () => cmd,
      startLogin: () => startClaudeLogin(cmd, options(undefined, vi.fn(() => readClaudeAuthStatus(cmd, {}, exec)))),
      useOfficial
    })
    await controller.start()
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'failed' }))
    expect(useOfficial).not.toHaveBeenCalled()
  })

  // Phase 2 ⑦:CLI 在 JSON 后面再打一行人类可读的尾随输出时,⛔ 把成功登录判成失败——
  // 登录刚成功,状态核对却说没登录,客户面对「登录失败」重试循环。
  it('JSON 带尾随输出时仍以其中的已登录字段为准', async () => {
    const trailing = (async () => ({ stdout: '{"loggedIn":true,"email":"x"}\nLogged in as x@example.com\n', stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, trailing)).toBe(true)
    const trailingFalse = (async () => ({ stdout: '{"loggedIn":false}\nNot logged in, run /login\n', stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, trailingFalse)).toBe(false)
    const trailingGarbage = (async () => ({ stdout: '{"loggedIn":true}\n>>> 安装向导已退出,代码 0 <<<\n{', stderr: '' })) as never
    expect(await readClaudeAuthStatus({ executable: 'claude', args: [] }, {}, trailingGarbage)).toBe(true)
  })

  it('控制器：未安装 → not-installed；成功后才切官方；取消回到 idle', async () => {
    const useOfficial = vi.fn(async () => undefined)
    const missing = new ClaudeOfficialLoginController({ findCommand: async () => null, startLogin: () => { throw new Error('x') }, useOfficial })
    expect(await missing.start()).toEqual({ status: 'not-installed' })
    const controller = new ClaudeOfficialLoginController({ findCommand: async () => command(), startLogin: (cmd) => startClaudeLogin(cmd, options(undefined, vi.fn(async () => true))), useOfficial })
    expect(await controller.start()).toEqual({ status: 'pending' })
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'code-required' }))
    controller.submitCode('code-1234')
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'connected' }))
    expect(useOfficial).toHaveBeenCalledWith('claude')
    const cancelled = new ClaudeOfficialLoginController({ findCommand: async () => command(), startLogin: (cmd) => startClaudeLogin(cmd, options()), useOfficial })
    await cancelled.start()
    expect(await cancelled.cancel()).toEqual({ status: 'idle' })
  })
})
