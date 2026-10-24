import { describe, expect, it, vi } from 'vitest'
import { startClaudeLogin } from '../../app/main/ai-access/claude-official-login'

const fallback = 'https://claude.ai/login?fixture=browser-failure'
const authorization = 'https://claude.ai/oauth/authorize?fixture=browser-failure'
const command = { executable: process.execPath, args: ['-e', `
  const readline = require('node:readline');
  process.stdout.write('${fallback}\\nPaste code here > ');
  let step = 0;
  readline.createInterface({ input: process.stdin }).on('line', () => {
    if (++step === 1) process.stdout.write('${authorization}\\nPaste code here > ');
    else { process.stdout.write('\\nLogin successful.\\n'); process.exit(0); }
  });
`] }

describe('Claude 兜底浏览器失败后的授权继续', () => {
  it('兜底打开失败后，后续真实授权链接仍会打开且本次登录可完成', async () => {
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined).mockRejectedValueOnce(new Error('fixture browser unavailable'))
    const session = startClaudeLogin(command, { cwd: process.cwd(), platform: 'linux', openExternal,
      statusCheck: async () => true, timeoutMs: 5000 })
    try {
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(fallback))
      await vi.waitFor(() => expect(session.authUrl()).toBeUndefined())
      session.submitCode('reveal-fixture-url')
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorization))
      expect(session.authUrl()).toBe(authorization)
      session.submitCode('fixture-code')
      await expect(session.completed).resolves.toBe(true)
    } finally { await session.cancel() }
  })

  it('真实链接已进入缓冲区才收到兜底失败时，立即继续授权；取消后失败不再打开', async () => {
    let reject!: (reason: Error) => void
    const held = new Promise<void>((_resolve, fail) => { reject = fail })
    const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined).mockReturnValueOnce(held)
    const session = startClaudeLogin(command, { cwd: process.cwd(), platform: 'linux', openExternal,
      statusCheck: async () => false, timeoutMs: 5000 })
    try {
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(fallback))
      session.submitCode('reveal-fixture-url')
      // Let the real child emit its authorization URL while the fallback browser call is unresolved.
      await new Promise(resolve => setTimeout(resolve, 100))
      reject(new Error('fixture late browser failure'))
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorization))
      expect(session.authUrl()).toBe(authorization)
    } finally { await session.cancel() }

    let cancelReject!: (reason: Error) => void
    const cancelling = new Promise<void>((_resolve, fail) => { cancelReject = fail })
    const cancelledOpen = vi.fn<(url: string) => Promise<void>>(async () => undefined).mockReturnValueOnce(cancelling)
    const cancelled = startClaudeLogin(command, { cwd: process.cwd(), platform: 'linux', openExternal: cancelledOpen,
      statusCheck: async () => false, timeoutMs: 5000 })
    await vi.waitFor(() => expect(cancelledOpen).toHaveBeenCalledTimes(1))
    cancelled.submitCode('reveal-fixture-url')
    await cancelled.cancel()
    cancelReject(new Error('fixture cancelled browser failure'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancelledOpen).toHaveBeenCalledTimes(1)
    expect(cancelled.state()).toBe('failed')
  })
})
