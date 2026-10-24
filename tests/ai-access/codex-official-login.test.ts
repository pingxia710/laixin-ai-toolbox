import { describe, expect, it, vi } from 'vitest'
import packageInfo from '../../package.json'

// 模拟带后缀工作包的运行时版本（electron-builder extraMetadata 在编译后改写成品版本）。
vi.mock('electron', () => ({ app: { getVersion: () => '0.6.3-review.1' } }))
import { resolve } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexOfficialLoginController,
  startCodexChatGptLogin,
  type CodexLoginCommand
} from '../../app/main/ai-access/codex-official-login'

const fixture = resolve('tests/ai-access/fixtures/codex-login-server.mjs')
const command: CodexLoginCommand = { executable: process.execPath, args: [fixture] }

describe('Codex 官方登录', () => {
  it('用 Codex 自己的 app-server 发起浏览器授权，成功后才切回官方模式', async () => {
    const openExternal = vi.fn(async () => undefined)
    const captureRoot = await mkdtemp(join(tmpdir(), 'codex-login-identity-'))
    const requests = join(captureRoot, 'requests.jsonl')
    process.env.LOGIN_FIXTURE_REQUESTS = requests
    try {
    const start = await startCodexChatGptLogin(command, { cwd: process.cwd(), openExternal })
    expect(openExternal).toHaveBeenCalledWith('https://chatgpt.com/authorize')
    await expect(start.completed).resolves.toBe(true)

    const useOfficial = vi.fn(async () => ({ deepseekKeySaved: true, shells: {} }))
    const controller = new CodexOfficialLoginController({
      findCommand: async () => command,
      startLogin: async () => startCodexChatGptLogin(command, { cwd: process.cwd(), openExternal }),
      useOfficial
    })
    await expect(controller.start()).resolves.toEqual({ status: 'pending' })
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'connected' }))
    expect(useOfficial).toHaveBeenCalledWith('codex')
    const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: { clientInfo?: { version?: string } } })
    const initialize = calls.find(call => call.method === 'initialize')
    expect(initialize?.params?.clientInfo?.version).toBe(packageInfo.version)
    } finally { delete process.env.LOGIN_FIXTURE_REQUESTS; await rm(captureRoot, { recursive: true, force: true }) }
  })

  it('带后缀工作包上报实际运行版本，不用编译时源码版本', async () => {
    const openExternal = vi.fn(async () => undefined)
    const captureRoot = await mkdtemp(join(tmpdir(), 'codex-login-runtime-version-'))
    const requests = join(captureRoot, 'requests.jsonl')
    const versions = process.versions as { electron?: string }
    const originalElectron = versions.electron
    versions.electron = '33.0.0'
    try {
      process.env.LOGIN_FIXTURE_REQUESTS = requests
      const start = await startCodexChatGptLogin(command, { cwd: process.cwd(), openExternal })
      await expect(start.completed).resolves.toBe(true)
      const calls = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: { clientInfo?: { version?: string } } })
      const initialize = calls.find(call => call.method === 'initialize')
      expect(initialize?.params?.clientInfo?.version).toBe('0.6.3-review.1')
    } finally {
      if (originalElectron === undefined) delete versions.electron
      else versions.electron = originalElectron
      delete process.env.LOGIN_FIXTURE_REQUESTS
      await rm(captureRoot, { recursive: true, force: true })
    }
  })

  it('终端自定义 CODEX_HOME 会传给官方登录子进程，而不是继承错误的默认根', async () => {
    const customRoot = '/customer/terminal-codex'
    const openExternal = vi.fn(async () => undefined)
    const start = await startCodexChatGptLogin({
      executable: process.execPath,
      args: [fixture, 'require-codex-home', customRoot],
      environment: { PATH: process.env.PATH, CODEX_HOME: customRoot }
    }, {
      cwd: process.cwd(),
      // Deliberately differs from the command environment: the verified target must win.
      env: { CODEX_HOME: '/customer/.codex' },
      openExternal
    })

    expect(openExternal).toHaveBeenCalledWith('https://chatgpt.com/authorize')
    await expect(start.completed).resolves.toBe(true)
  })

  it('授权失败不切换使用方式，错误文字也不流向状态', async () => {
    const useOfficial = vi.fn(async () => ({ deepseekKeySaved: true, shells: {} }))
    const controller = new CodexOfficialLoginController({
      findCommand: async () => ({ executable: process.execPath, args: [fixture, 'rejected'] }),
      startLogin: async (candidate) => startCodexChatGptLogin(candidate, { cwd: process.cwd(), openExternal: async () => undefined }),
      useOfficial
    })
    await controller.start()
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'failed' }))
    expect(useOfficial).not.toHaveBeenCalled()
    expect(JSON.stringify(controller.status())).not.toContain('fixture-private-error')
  })

  it('未安装 Codex 时不试图启动浏览器或伪造已登录', async () => {
    const openExternal = vi.fn(async () => undefined)
    const controller = new CodexOfficialLoginController({
      findCommand: async () => null,
      startLogin: async () => startCodexChatGptLogin(command, { cwd: process.cwd(), openExternal }),
      useOfficial: async () => ({ deepseekKeySaved: true, shells: {} })
    })
    await expect(controller.start()).rejects.toThrow('AI_ACCESS_CODEX_NOT_INSTALLED')
    expect(controller.status()).toEqual({ status: 'idle' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('拒绝非官方授权地址', async () => {
    const openExternal = vi.fn(async () => undefined)
    await expect(startCodexChatGptLogin({ executable: process.execPath, args: [fixture, 'unexpected-url'] }, { cwd: process.cwd(), openExternal }))
      .rejects.toThrow('AI_ACCESS_CODEX_LOGIN_FAILED')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('浏览器打开后客户中途放弃：总超时把会话收干净，能重新发起登录（第 4 轮）', async () => {
    const openExternal = vi.fn(async () => undefined)
    // 对照 Claude 登录的 10 分钟总超时：completed 必须决议，⛔ 让控制器停在 pending 直到重启 App。
    const abandoned = await startCodexChatGptLogin(
      { executable: process.execPath, args: [fixture, 'hang'] },
      { cwd: process.cwd(), openExternal, overallTimeoutMs: 150 })
    expect(openExternal).toHaveBeenCalledWith('https://chatgpt.com/authorize')
    await expect(abandoned.completed).resolves.toBe(false)

    let mode: 'hang' | 'ready' = 'hang'
    const useOfficial = vi.fn(async () => ({}))
    const controller = new CodexOfficialLoginController({
      findCommand: async () => ({ executable: process.execPath, args: [fixture, mode] }),
      startLogin: async (candidate) => startCodexChatGptLogin(candidate, { cwd: process.cwd(), openExternal, overallTimeoutMs: 150 }),
      useOfficial
    })
    await controller.start()
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'failed' }), { timeout: 3_000 })
    mode = 'ready'
    await expect(controller.start()).resolves.toEqual({ status: 'pending' })
    await vi.waitFor(() => expect(controller.status()).toEqual({ status: 'connected' }))
    expect(useOfficial).toHaveBeenCalledWith('codex')
  })
})
