import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { shellConfigFixture } from './fixtures/shell-config'

const fixtures: { dispose(): Promise<void> }[] = []
const blockers: AiGateway[] = []
afterEach(async () => {
  await Promise.all(blockers.splice(0).map(blocker => blocker.stop()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})

async function connected(shells: readonly ('codex' | 'claude')[] = ['codex', 'claude']) {
  const f = shellConfigFixture()
  fixtures.push(f)
  for (const shell of shells) {
    await f.service.saveProviderKey(shell, 'deepseek', `sk-fixture-recovery-${shell}-0123456789`)
    await f.service.configureProvider(shell, 'deepseek', `sk-fixture-recovery-${shell}-0123456789`, 'deepseek-v4-pro')
  }
  return f
}
const port = (f: { state: () => { relay?: { port: number } } }) => f.state().relay!.port

describe('重开 / 唤醒 / 断网恢复后的接入核对', () => {
  it('一切正常时只报「对得上」，不动配置也不花上游额度', async () => {
    const f = await connected()
    const before = { codex: f.data.get(f.codexPath), claude: f.data.get(f.claudePath) }
    f.fetcher.mockClear()
    const result = await f.service.recoverAccess('wake')
    expect(result).toMatchObject({ reason: 'wake', outcome: 'ok', configurations: { codex: 'ok', claude: 'ok', hermes: 'not-managed' } })
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.data.get(f.codexPath)).toBe(before.codex)
    expect(f.data.get(f.claudePath)).toBe(before.claude)
  })

  it('端口被别的程序占了：换一个端口并把各壳配置改到新地址，已选模型不变', async () => {
    const f = await connected()
    const original = port(f)
    await f.gateway.stop()
    const blocker = new AiGateway({ fetch: f.fetcher })
    blockers.push(blocker)
    await blocker.start(original, 'laixin-fixture-blocker-token-0123456789')

    const result = await f.service.recoverAccess('startup')
    expect(result).toMatchObject({ outcome: 'repaired', rewroteShells: ['codex', 'claude'] })
    expect(port(f)).not.toBe(original)
    expect(f.data.get(f.codexPath)).toContain(`127.0.0.1:${String(port(f))}`)
    expect(f.data.get(f.claudePath)).toContain(`127.0.0.1:${String(port(f))}`)
    expect(f.data.get(f.codexPath)).not.toContain(`127.0.0.1:${String(original)}`)
    // 换端口 ⛔ 顺手改客户选的模型。
    expect(f.state().shellModels?.codex?.deepseek).toBe('deepseek-v4-pro')
    expect(f.data.get(f.codexPath)).toContain('model = "deepseek-v4-pro"')
    expect(result.message).toContain('模型选择不变')
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok', claude: 'ok' })
    expect((await f.service.serviceStatus()).running).toBe(true)
  })

  it('换端口之后客户端用新地址能通，旧地址不再是我们的服务', async () => {
    const f = await connected(['codex'])
    const original = port(f)
    await f.gateway.stop()
    const blocker = new AiGateway({ fetch: f.fetcher })
    blockers.push(blocker)
    await blocker.start(original, 'laixin-fixture-blocker-token-0123456789')
    await f.service.recoverAccess('startup')

    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    expect(route.baseUrl).toContain(String(port(f)))
    const response = await fetch(`${route.baseUrl}/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ stream: true }) })
    expect(response.status).toBe(200)
    await response.text()
  })

  it('本机服务完全起不来就报本机服务未运行，⛔ 说成服务商的问题', async () => {
    const f = await connected(['codex'])
    await f.gateway.stop()
    vi.spyOn(f.gateway, 'start').mockRejectedValue(new Error('fixture cannot listen'))
    const result = await f.service.recoverAccess('periodic')
    expect(result).toMatchObject({ outcome: 'still_failing', code: 'local_service_down' })
    expect(result.message).toContain('本机 API 服务')
  })

  it('服务在跑但配置被别的工具改了，恢复结论是仍有问题并指名是哪个 AI', async () => {
    const f = await connected(['codex'])
    f.data.set(f.codexPath, f.data.get(f.codexPath)!.replace(/model_reasoning_effort = "[^"]*"/, 'model_reasoning_effort = "low"'))
    const result = await f.service.recoverAccess('wake')
    expect(result).toMatchObject({ outcome: 'still_failing', code: 'configuration_failed', configurations: { codex: 'modified-externally' } })
    expect(result.message).toContain('Codex')
  })

  it('没有 AI 在用模型 API 时不做任何事', async () => {
    const f = shellConfigFixture()
    fixtures.push(f)
    const result = await f.service.recoverAccess('startup')
    expect(result).toMatchObject({ outcome: 'not-managed', configurations: { codex: 'not-managed', claude: 'not-managed', hermes: 'not-managed' } })
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('恢复过程与结果都会留一条故障记录给客服', async () => {
    const f = await connected(['codex'])
    const original = port(f)
    await f.gateway.stop()
    const blocker = new AiGateway({ fetch: f.fetcher })
    blockers.push(blocker)
    await blocker.start(original, 'laixin-fixture-blocker-token-0123456789')
    f.faults.length = 0
    await f.service.recoverAccess('startup')
    expect(f.faults.some(fault => fault.outcome === 'recovered' && fault.action === 'restartGateway')).toBe(true)
    expect(JSON.stringify(f.faults)).not.toContain(f.state().relay!.token)
  })
})
