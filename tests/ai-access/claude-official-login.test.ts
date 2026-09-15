import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { ClaudeOfficialLoginController, readClaudeAuthStatus, startClaudeLogin, validClaudeAuthUrl } from '../../app/main/ai-access/claude-official-login'

const fixture = resolve('tests/ai-access/fixtures/claude-login-cli.mjs')
const command = (...extra: string[]) => ({ executable: process.execPath, args: [fixture, ...extra] })
const options = (openExternal = vi.fn(async () => undefined), statusCheck = vi.fn(async () => false)) => ({ cwd: process.cwd(), platform: 'linux', openExternal, statusCheck, timeoutMs: 5_000 })

describe('Claude 官方登录', () => {
  it('打开官方授权页，出现粘码提示后进入 code-required，提交正确登录码后成功', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command(), options(openExternal))
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
    const session = startClaudeLogin(command('docs-first'), options(openExternal))
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?client_id=test&state=abc')
    expect(session.authUrl()).toBe('https://claude.ai/oauth/authorize?client_id=test&state=abc')
    await expect(session.completed).resolves.toBe(true)
  })

  it('兜底在会话活着时开：CLI 问码而没有任何授权形态链接被打开，立刻打开域名命中的最后一条，之后仍能粘码走到成功（第 4 轮返修）', async () => {
    const openExternal = vi.fn(async () => undefined)
    const session = startClaudeLogin(command('domain-only-hang'), options(openExternal))
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

  it('控制器：未安装 → not-installed；成功后才切官方；取消回到 idle', async () => {
    const useOfficial = vi.fn(async () => undefined)
    const missing = new ClaudeOfficialLoginController({ findCommand: async () => null, startLogin: () => { throw new Error('x') }, useOfficial })
    expect(await missing.start()).toEqual({ status: 'not-installed' })
    const controller = new ClaudeOfficialLoginController({ findCommand: async () => command(), startLogin: (cmd) => startClaudeLogin(cmd, options()), useOfficial })
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
