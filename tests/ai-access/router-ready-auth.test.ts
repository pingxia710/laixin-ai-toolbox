import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { createHeadlessRouterControl } from '../../app/main/ai-access/headless-router'
import { chooseAiRouterPort } from '../../app/main/ai-access/router-controller'
import { routerNonce, routerProof } from '../../app/main/ai-access/router-protocol'

const gateways: AiGateway[] = []
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())) })

describe('ready 查询的调用方身份', () => {
  it('本机无签名查询不能取得最近模型，正确签名查询仍可读安全摘要', async () => {
    const port = await chooseAiRouterPort(), secret = 'b'.repeat(64), bootId = 'a'.repeat(32)
    const holder: { gateway?: AiGateway } = {}
    const control = createHeadlessRouterControl({ binding: { port, identitySecret: secret }, bootId, initialModelCount: 1,
      readState: async () => ({ version: 1, selected: {} }), gateway: () => holder.gateway!, onStop: () => undefined })
    const gateway = new AiGateway({ routerControl: control })
    holder.gateway = gateway
    gateways.push(gateway)
    const lastDesktopUse = { provider: 'deepseek' as const, model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash', at: '2026-10-02T00:00:00.000Z' }
    const read = vi.spyOn(gateway, 'latestSettledMultiModelDesktopUse').mockReturnValue(lastDesktopUse)
    await gateway.start(port, 'fixture-token-0123456789')
    const nonce = routerNonce(), url = `${gateway.baseUrl}/_laixin/router/ready?nonce=${nonce}`
    const unsigned = await fetch(url)
    expect(unsigned.status).toBe(403)
    expect(await unsigned.text()).toBe('')
    expect(read).not.toHaveBeenCalled()
    for (const proof of [routerProof('c'.repeat(64), 'ready', nonce, bootId, port),
      routerProof(secret, 'stop', nonce, bootId, port), routerProof(secret, 'ready', routerNonce(), bootId, port),
      routerProof(secret, 'ready', nonce, 'd'.repeat(32), port), routerProof(secret, 'ready', nonce, bootId, port + 1)]) {
      const denied = await fetch(url, { headers: { 'x-laixin-proof': proof } })
      expect(denied.status).toBe(403)
      expect(await denied.text()).toBe('')
    }
    const signed = await fetch(url, { headers: { 'x-laixin-proof': routerProof(secret, 'ready', nonce, bootId, port) } })
    expect(signed.status).toBe(200)
    expect(await signed.json()).toMatchObject({ lastDesktopUse,
      proof: routerProof(secret, 'ready-ack', nonce, bootId, port) })
  })
})
