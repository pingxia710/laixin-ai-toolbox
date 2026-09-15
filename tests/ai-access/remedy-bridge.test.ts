import { afterEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn(async () => undefined)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/laixin-fixture-unused' }, shell: { openExternal } }))

const { BridgeRegistry } = await import('../../app/main/bridge/bridge-registry')
const { registerAiAccessActions } = await import('../../app/main/actions/ai-access')
const { AiAccessService, aiAccessShells } = await import('../../app/main/ai-access/service')
const { AiGateway } = await import('../../app/main/ai-access/gateway')
type Service = InstanceType<typeof AiAccessService>

const services: Service[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); openExternal.mockClear() })

function reply(second: boolean): Response {
  if (second) {
    return new Response([{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] })
}

async function fixture() {
  let state = { version: 1 as const, selected: {} as Record<string, string> }
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(JSON.parse(String(init?.body)).stream === true))
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn(async () => undefined), captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const store = { read: async () => state as never, write: async (next: never) => { state = next } }
  const service = new AiAccessService(store, adapters, new AiGateway({ fetch: fetcher, timeoutMs: 1000 }))
  services.push(service)
  const registry = new BridgeRegistry()
  registerAiAccessActions(registry, service)
  await service.saveProviderKey('codex', 'deepseek', 'sk-fixture-bridge-remedy-0123456789')
  await service.useProvider('codex', 'deepseek')
  return { service, registry, fetcher }
}
// provider 传空串＝界面也指不出这次针对谁，回退看 selected；指得出时必须原样传过来。
const remedy = async (registry: InstanceType<typeof BridgeRegistry>, shell: string, action: string, provider = '') =>
  JSON.parse(((await registry.execute('aiaccess.remedy', { shell, action, provider })) as { snapshot: string }).snapshot) as Record<string, unknown>

describe('处理动作的后台入口', () => {
  it('打开控制台没有可复验的结果，只报「不能确认」并建议回来重新测试', async () => {
    const f = await fixture()
    const result = await remedy(f.registry, 'codex', 'openConsole')
    expect(openExternal).toHaveBeenCalledWith('https://platform.deepseek.com/api_keys')
    expect(result).toMatchObject({ action: 'openConsole', outcome: 'unknown', provider: 'deepseek', next: 'retest' })
  })

  it('用官方配置的壳没有服务商控制台可开', async () => {
    const f = await fixture()
    const result = await remedy(f.registry, 'claude', 'openConsole')
    expect(openExternal).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'unknown', provider: null })
  })

  it('动作名与壳名都要在清单内，⛔ 放任意字符串进来', async () => {
    const f = await fixture()
    await expect(f.registry.execute('aiaccess.remedy', { shell: 'codex', action: 'rm -rf', provider: '' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(f.registry.execute('aiaccess.remedy', { shell: 'unknown', action: 'retest', provider: '' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    // 服务商名同样只收清单内的。
    await expect(f.registry.execute('aiaccess.remedy', { shell: 'codex', action: 'retest', provider: '../etc' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    // 少传字段的旧调用直接被桥挡下，⛔ 悄悄按 selected 猜。
    await expect(f.registry.execute('aiaccess.remedy', { shell: 'codex', action: 'retest' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })

  it('界面指明了这次失败针对谁，打开的就是那家的控制台，⛔ 按 selected 猜', async () => {
    const f = await fixture()
    // selected 是 deepseek，但这次失败针对的是智谱：要打开智谱的控制台。
    const result = await remedy(f.registry, 'codex', 'openConsole', 'zhipu')
    expect(openExternal).toHaveBeenCalledWith('https://open.bigmodel.cn/')
    expect(result).toMatchObject({ action: 'openConsole', outcome: 'unknown', provider: 'zhipu' })
  })

  it('配置核对与接入恢复也能从后台入口调用', async () => {
    const f = await fixture()
    const configurations = JSON.parse(((await f.registry.execute('aiaccess.verifyConfiguration', undefined)) as { snapshot: string }).snapshot) as Record<string, string>
    expect(configurations).toMatchObject({ claude: 'not-managed', hermes: 'not-managed' })
    const recovery = JSON.parse(((await f.registry.execute('aiaccess.recover', undefined)) as { snapshot: string }).snapshot) as Record<string, unknown>
    expect(recovery).toMatchObject({ reason: 'manual' })
    expect(['ok', 'repaired', 'still_failing', 'not-managed']).toContain(recovery.outcome)
  })

  it('重新测试的结果原样过桥，Key 不进快照', async () => {
    const f = await fixture()
    f.fetcher.mockResolvedValue(new Response('{"error":{"type":"authentication_error"}}', { status: 401 }))
    const result = await remedy(f.registry, 'codex', 'retest')
    expect(result).toMatchObject({ outcome: 'still_failing', code: 'key_rejected' })
    expect(JSON.stringify(result)).not.toContain('sk-fixture-bridge-remedy')
  })
})
