import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../app/main/ai-access/service'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function response(): Response {
  const frames = [
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed' }
  ]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

function fixture(fetcher: typeof fetch) {
  let state: AiAccessState = {
    version: 1,
    selected: { codex: 'official' },
    shellKeys: { codex: { deepseek: 'sk-existing-working-key-1234567890' } }
  }
  const store = { read: vi.fn(async () => state), write: vi.fn(async (next: AiAccessState) => { state = next }) }
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 100 })
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined) }))
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  return { service, store, adapters, state: () => state }
}

describe('工作窗口 Key 验证', () => {
  it('错误 Key 不覆盖已存 Key，不切换官方来源，不写 Codex 配置', async () => {
    const f = fixture(async () => new Response('', { status: 401 }))
    const result = await f.service.verifyAndSaveProviderKey('codex', 'deepseek', 'sk-rejected-candidate-key-1234567890')

    expect(result.attempt).toMatchObject({ shell: 'codex', provider: 'deepseek', ok: false, code: 'key_rejected' })
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.state()).toMatchObject({ selected: { codex: 'official' }, shellKeys: { codex: { deepseek: 'sk-existing-working-key-1234567890' } } })
    expect(f.adapters.every(adapter => adapter.applyDeepSeek.mock.calls.length === 0)).toBe(true)
  })

  it('验证通过只更新加密 Key，官方选择和全局配置保持原样', async () => {
    const f = fixture(async () => response())
    const candidate = 'sk-verified-candidate-key-1234567890'
    const result = await f.service.verifyAndSaveProviderKey('codex', 'deepseek', candidate)

    expect(result.attempt).toMatchObject({ shell: 'codex', provider: 'deepseek', ok: true })
    expect(f.store.write).toHaveBeenCalledOnce()
    expect(f.state()).toMatchObject({ selected: { codex: 'official' }, shellKeys: { codex: { deepseek: candidate } } })
    expect(JSON.stringify(result)).not.toContain(candidate)
  })
})
