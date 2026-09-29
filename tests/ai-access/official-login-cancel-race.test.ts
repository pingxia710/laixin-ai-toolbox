import { expect, it, vi } from 'vitest'
import type { CodexChatGptLogin, CodexLoginCommand } from '../../app/main/ai-access/codex-official-login'
import { CodexOfficialLoginController } from '../../app/main/ai-access/codex-official-login'
import type { ClaudeLoginSession } from '../../app/main/ai-access/claude-official-login'
import { ClaudeOfficialLoginController } from '../../app/main/ai-access/claude-official-login'

// N-59:客户点「取消官方登录」后,取消可能落在 start() 的 await 窗口内(findCommand / startLogin)。
// 修复前:start 恢复后不复查代次,把控制器拽回 pending、把已取消的会话登记成 this.pending,
// 浏览器照常弹授权页,迟到的 completed 还会把状态永久卡在 pending。修复后:复查代次,
// 会话立即取消,状态留在 idle。

const command: CodexLoginCommand = { executable: '/usr/local/bin/codex-fixture', args: ['login'] }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeCodexSession(cancelled: string[]) {
  return {
    completed: Promise.resolve(false),
    cancel: async () => { cancelled.push('codex-cancel') }
  } as unknown as CodexChatGptLogin
}

it('Codex:取消落在 startLogin await 窗口内,不回弹 pending,新会话立即取消', async () => {
  const startLogin = deferred<CodexChatGptLogin>()
  const cancelled: string[] = []
  const controller = new CodexOfficialLoginController({
    findCommand: async () => command,
    startLogin: () => startLogin.promise,
    useOfficial: async () => undefined
  })
  const started = controller.start()
  // 先让 findCommand 落定、start() 走到 await startLogin 窗口,再取消——这才是 startLogin 窗口竞态
  await Promise.resolve(); await Promise.resolve()
  const cancelling = controller.cancel()
  startLogin.resolve(fakeCodexSession(cancelled))
  expect((await started).status).toBe('idle')
  await cancelling
  expect(cancelled).toEqual(['codex-cancel'])
  expect(controller.status().status).toBe('idle')
})

it('Codex:取消落在 findCommand await 窗口内,不回弹 pending,不调 startLogin', async () => {
  const findCommand = deferred<CodexLoginCommand | null>()
  const startLogin = vi.fn()
  const controller = new CodexOfficialLoginController({
    findCommand: () => findCommand.promise,
    startLogin,
    useOfficial: async () => undefined
  })
  const started = controller.start()
  await controller.cancel()
  findCommand.resolve(command)
  expect((await started).status).toBe('idle')
  expect(startLogin).not.toHaveBeenCalled()
  expect(controller.status().status).toBe('idle')
})

it('Codex:无竞态的正常路径不受影响,完成后进入 connected', async () => {
  let complete!: (value: boolean) => void
  const completed = new Promise<boolean>((done) => { complete = done })
  const controller = new CodexOfficialLoginController({
    findCommand: async () => command,
    startLogin: async () => ({ completed, cancel: async () => undefined }) as CodexChatGptLogin,
    useOfficial: async () => undefined
  })
  expect((await controller.start()).status).toBe('pending')
  complete(true)
  await completed
  await Promise.resolve()
  expect(controller.status().status).toBe('connected')
})

function fakeClaudeSession(cancelled: string[]): ClaudeLoginSession {
  return {
    completed: Promise.resolve(false),
    state: () => 'awaiting-code' as never,
    authUrl: () => 'https://claude.ai/oauth/authorize',
    submitCode: () => undefined,
    cancel: async () => { cancelled.push('claude-cancel') }
  } as unknown as ClaudeLoginSession
}

it('Claude:取消落在 findCommand await 窗口内,不回弹 pending,不建会话', async () => {
  const findCommand = deferred<null | { executable: string; args: readonly string[] }>()
  const startLogin = vi.fn(() => fakeClaudeSession([]))
  const controller = new ClaudeOfficialLoginController({
    findCommand: () => findCommand.promise,
    startLogin,
    useOfficial: async () => undefined
  })
  const started = controller.start()
  await controller.cancel()
  findCommand.resolve({ executable: '/usr/local/bin/claude-fixture', args: [] })
  expect((await started).status).toBe('idle')
  expect(startLogin).not.toHaveBeenCalled()
  expect(controller.status().status).toBe('idle')
})

it('Claude:无竞态的正常路径不受影响,完成后进入 connected', async () => {
  let complete!: (value: boolean) => void
  const completed = new Promise<boolean>((done) => { complete = done })
  const controller = new ClaudeOfficialLoginController({
    findCommand: async () => ({ executable: '/usr/local/bin/claude-fixture', args: [] }),
    startLogin: () => ({ completed, state: () => 'awaiting-code' as never, authUrl: () => undefined,
      submitCode: () => undefined, cancel: async () => undefined }) as unknown as ClaudeLoginSession,
    useOfficial: async () => undefined
  })
  expect((await controller.start()).status).toBe('pending')
  complete(true)
  await completed
  await Promise.resolve()
  expect(controller.status().status).toBe('connected')
})
