import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessState, type AiAccessAdapter } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function fixture(gate: (shell: string, provider: string) => Promise<string | undefined>, resolveRoute?: (shell: 'codex' | 'claude' | 'hermes', provider: string) => { endpoint: string; model: string }) {
  let state: AiAccessState = { version: 1, selected: {}, shellKeys: { claude: { deepseek: 'sk-test-key-1234567890' } } }
  const fetcher = vi.fn<typeof fetch>(async () => new Response('should not be called', { status: 500 }))
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined), applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined)) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 500 })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway, { gate: gate as never, resolveRoute: resolveRoute as never })
  services.push(service)
  return { service, fetcher, adapters, state: () => state }
}

describe('壳版本闸门', () => {
  it('被闸门拦下时不探测上游、不写壳配置，状态带具体说明', async () => {
    const f = fixture(async (shell) => shell === 'claude' ? '这个版本的 Claude Code 与第三方模型接口不兼容（会报 400）。' : undefined)
    const status = await f.service.useProvider('claude', 'deepseek')
    expect(status.attempt).toMatchObject({ shell: 'claude', ok: false, code: 'shell_version_incompatible' })
    expect(status.attempt?.notice).toContain('400')
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.adapters.find(a => a.shell === 'claude')!.applyConnection).not.toHaveBeenCalled()
    expect(f.state().selected.claude).toBeUndefined()
    const snapshot = await f.service.testProvider('claude', 'deepseek')
    expect(snapshot.checks[0]).toMatchObject({ code: 'shell_version_incompatible' })
  })
  it('闸门放行时按配方覆盖的接口和模型建路由', async () => {
    let seen: { endpoint: string; model: string } | undefined
    const f = fixture(async () => undefined, (shell, provider) => { seen = { endpoint: `https://override.example/${shell}/${provider}`, model: 'deepseek-next' }; return seen })
    await f.service.testProvider('claude', 'deepseek')
    expect(seen).toEqual({ endpoint: 'https://override.example/claude/deepseek', model: 'deepseek-next' })
    expect(f.fetcher).toHaveBeenCalled()
    expect(String(f.fetcher.mock.calls[0][0])).toBe('https://override.example/claude/deepseek')
  })
})
