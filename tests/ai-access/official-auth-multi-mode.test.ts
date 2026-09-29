import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAccessService, aiAccessShells, type AiAccessAdapter, type AiAccessState } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'

// 创始人 2026-09-29 定案：多模型共用模式下 OpenAI 官方是池内一条线，官方登录状态
//（工具箱发起或桌面端直登，同一份 Codex 凭据文件）必须随 status 下发，供界面显示
// 绿色「已启用」。单模型模式未选官方时行为不变。
const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })

function fixture(initial: AiAccessState) {
  let state = initial
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn(async () => undefined), captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}),
    ...(shell === 'codex' ? { officialAuthenticationStatus: vi.fn(async () =>
      ({ state: 'official' as const, reason: 'chatgpt-session' as const })) } : {}) }))
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters as AiAccessAdapter[], new AiGateway({ fetch: fetcher, timeoutMs: 1_000 }))
  services.push(service)
  return { service }
}

const pool = [{ provider: 'deepseek' as const, model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }]

describe('多模型模式的官方登录状态下发', () => {
  it('codexMode=multi 且未选官方时，status 仍探测并下发 codex 官方登录状态', async () => {
    const { service } = fixture({ version: 1, selected: {}, codexMode: 'multi', codexMultiModelPool: pool })
    const view = await service.status()
    expect(view.officialAuthentication?.codex).toEqual({ state: 'official', reason: 'chatgpt-session' })
  })

  it('单模型模式未选官方时行为不变：不下发 codex 官方登录状态', async () => {
    const { service } = fixture({ version: 1, selected: {}, codexMode: 'single' })
    const view = await service.status()
    expect(view.officialAuthentication?.codex).toBeUndefined()
  })
})
