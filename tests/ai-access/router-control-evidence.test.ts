import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { chooseAiRouterPort } from '../../app/main/ai-access/router-controller'
import { routerControlTimeoutMs, routerNonce, routerProof } from '../../app/main/ai-access/router-protocol'
import type { AiAccessState } from '../../app/main/ai-access/service'
import { providerShellContract } from '../../app/shared/model-providers'
import * as headlessRouter from '../../app/main/ai-access/headless-router'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

describe('headless 控制 ACK 与 Desktop 证明解耦', () => {
  it('证明未结算时 ready、refresh、stop 都在 800ms 截止内返回，下一轮状态才出现证据', async () => {
    type ControlFactory = (options: {
      readonly binding: { readonly port: number; readonly identitySecret: string }
      readonly bootId: string
      readonly initialModelCount: number
      readonly readState: () => Promise<AiAccessState>
      readonly gateway: () => AiGateway
      readonly onStop: () => void
    }) => NonNullable<ConstructorParameters<typeof AiGateway>[0]>['routerControl']
    const createControl = (headlessRouter as unknown as { createHeadlessRouterControl?: ControlFactory }).createHeadlessRouterControl
    expect(createControl).toBeTypeOf('function')
    if (!createControl) return

    const port = await chooseAiRouterPort()
    const binding = { port, identitySecret: 'b'.repeat(64) }
    const bootId = 'a'.repeat(32)
    const contract = providerShellContract('deepseek', 'codex')
    if (contract.status !== 'supported') throw new Error('fixture contract unavailable')
    const model = { internalModelId: 'laixin.deepseek.deepseek-flash', provider: 'deepseek' as const,
      model: 'deepseek-flash', endpoint: contract.endpoint, key: 'sk-fixture-deepseek-0123456789' }
    const state: AiAccessState = { version: 1, selected: {}, codexMode: 'multi', codexMultiRelay: binding,
      shellKeys: { codex: { deepseek: model.key } }, codexMultiModelPool: [model] }
    let settleDesktop: ((value: { status: 'verified'; at: string; reason: 'verified_socket_bound_desktop' }) => void) | undefined
    const pendingDesktop = new Promise<{ status: 'verified'; at: string; reason: 'verified_socket_bound_desktop' }>(resolve => { settleDesktop = resolve })
    const stopped = vi.fn()
    const gatewayHolder: { current?: AiGateway } = {}
    const control = createControl({ binding, bootId, initialModelCount: 1, readState: async () => state,
      gateway: () => gatewayHolder.current!, onStop: stopped })
    const gateway = new AiGateway({ routerControl: control, desktopAttestor: { observe: async () => pendingDesktop },
      fetch: async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }) })
    gatewayHolder.current = gateway
    gateways.push(gateway)
    await gateway.start(port, 'fixture-client-token-0123456789')
    gateway.setMultiModelRoute({ provider: 'laixin-multi', models: [model] })

    const completed = await fetch(`${gateway.baseUrl}/codex/multi/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer fixture-client-token-0123456789' },
      body: JSON.stringify({ model: model.internalModelId, input: 'fixture' }) })
    expect(completed.status).toBe(200)

    const request = async (action: 'ready' | 'refresh' | 'stop') => {
      const nonce = routerNonce()
      const response = await fetch(`${gateway.baseUrl}/_laixin/router/${action}${action === 'ready' ? `?nonce=${nonce}` : ''}`, {
        method: action === 'ready' ? 'GET' : 'POST',
        headers: action === 'ready' ? undefined : {
          'x-laixin-nonce': nonce,
          'x-laixin-proof': routerProof(binding.identitySecret, action, nonce, bootId, port)
        },
        signal: AbortSignal.timeout(routerControlTimeoutMs)
      })
      expect(response.ok).toBe(true)
      return await response.json() as Record<string, unknown>
    }

    for (const action of ['ready', 'refresh', 'stop'] as const) {
      const value = await request(action)
      expect(value).not.toHaveProperty('lastDesktopUse')
    }
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce())

    settleDesktop?.({ status: 'verified', at: '2026-09-27T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })
    await expect(gateway.latestMultiModelDesktopUse()).resolves.toMatchObject({ internalModelId: model.internalModelId })
    await expect(request('ready')).resolves.toMatchObject({
      lastDesktopUse: { provider: 'deepseek', model: 'deepseek-flash', internalModelId: model.internalModelId }
    })
  })
})
