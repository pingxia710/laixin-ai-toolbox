import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAccessState } from '../../app/main/ai-access/service'

const openExternal = vi.fn(async () => undefined)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/laixin-fixture-unused' }, shell: { openExternal }, session: { fromPartition: vi.fn() } }))

const { BridgeRegistry } = await import('../../app/main/bridge/bridge-registry')
const { registerAiAccessActions } = await import('../../app/main/actions/ai-access')
const { registerActions, readSelection } = await import('../../app/main/actions/network-diagnostics')
const { diagnosticSelectionFingerprint } = await import('../../app/main/network-diagnostics/service')
const { AiAccessService, aiAccessShells } = await import('../../app/main/ai-access/service')
const { AiGateway } = await import('../../app/main/ai-access/gateway')
const { parseDiagnosticReport } = await import('../../app/renderer/src/pages/network-diagnostics')
type Service = InstanceType<typeof AiAccessService>

const services: Service[] = []
afterEach(async () => {
  try { await Promise.all(services.splice(0).map(service => service.stop())) }
  finally { vi.useRealTimers() }
})

function reply(shell: 'codex' | 'claude' | 'hermes', second: boolean): Response {
  if (second) {
    const frames = shell === 'codex' ? [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      : shell === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const body = shell === 'codex' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }
    : shell === 'claude' ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] }
  return Response.json(body)
}

async function wired() {
  let state: AiAccessState = { version: 1, selected: {} }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = String(url)
    const shell = endpoint.endsWith('/responses') ? 'codex' : endpoint.endsWith('/messages') ? 'claude' : 'hermes'
    return reply(shell, JSON.parse(String(init?.body)).stream === true)
  })
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined),
    applyConnection: vi.fn(async () => undefined), captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000 })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const service = new AiAccessService(store, adapters, gateway)
  services.push(service)
  const registry = new BridgeRegistry()
  registerAiAccessActions(registry, service)
  const probe = vi.fn(async () => ({ status: 204, durationMs: 5 }))
  registerActions(registry, { probe, status: () => ({ state: '已连', lastVerifiedAt: new Date().toISOString(), configVersion: '2', nodeLabel: 'fixture', unrestored: '', componentMissing: '' }) })
  const run = async (software: string) => parseDiagnosticReport(((await registry.execute('networkdiagnostics.run', { software })) as { snapshot: string }).snapshot)
  return { service, gateway, registry, probe, run, state: () => state }
}

describe('诊断入口读到的是这个软件真正在用的服务', () => {
  it('新成功请求刷新诊断证据，但不改变首次验收和配置指纹', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'))
    const f = await wired()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-fresh-diagnostic-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    const call = async () => {
      const response = await fetch(`${route.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ stream: true }) })
      await response.text()
      return response.status
    }
    expect(await call()).toBe(200)
    const before = await readSelection(f.registry, 'codex')
    const first = (await f.service.serviceStatus()).usage.find(stage => stage.shell === 'codex')!.observedClientCall
    vi.setSystemTime(new Date('2026-09-21T00:11:00.000Z'))
    expect((await f.run('codex')).checks.find(check => check.id === 'application')?.code).toBe('AI_DIAG_APPLICATION_STALE')
    expect(await call()).toBe(200)
    expect((await f.run('codex')).checks.find(check => check.id === 'application')?.code).toBe('AI_DIAG_APPLICATION_OBSERVED')
    expect((await f.service.serviceStatus()).usage.find(stage => stage.shell === 'codex')).toMatchObject({
      observedClientCall: first, lastObservedClientCall: '2026-09-21T00:11:00.000Z'
    })
    expect(f.gateway.clientCalls().codex).toBe(first)
    expect(diagnosticSelectionFingerprint(await readSelection(f.registry, 'codex'))).toBe(diagnosticSelectionFingerprint(before))
  })

  it.each([
    [{}, '2026-09-21T00:00:00.000Z'],
    [{ lastObservedClientCall: null }, null],
    [{ lastObservedClientCall: '2026-09-21T00:11:00.000Z' }, '2026-09-21T00:11:00.000Z']
  ])('最近成功缺省兼容首次时间，明确 null 不回退：%j', async (recent, expected) => {
    const snapshots: Record<string, unknown> = {
      'aiaccess.status': { shells: { codex: { selected: 'deepseek' } } },
      'aiaccess.providerConfiguration': { endpoint: 'https://api.deepseek.com/responses' },
      'aiaccess.serviceStatus': { running: true, usage: [{ shell: 'codex', observedClientCall: '2026-09-21T00:00:00.000Z', ...recent }] }
    }
    const registry = new BridgeRegistry()
    vi.spyOn(registry, 'execute').mockImplementation(async (name: string) => ({ snapshot: JSON.stringify(snapshots[name]) }))
    expect(await readSelection(registry, 'codex')).toMatchObject({ observedClientCall: expected })
  })

  it('Codex 切到 DeepSeek 之后，诊断直接检查 DeepSeek，并把「已观察到调用」带出来', async () => {
    const f = await wired()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-diagnostic-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    await expect(f.registry.execute('aiaccess.providerConfiguration', { shell: 'codex', provider: 'deepseek' })).resolves.toMatchObject({
      snapshot: expect.stringContaining('https://api.deepseek.com/responses')
    })
    expect((await f.run('codex')).checks.find(check => check.id === 'application')).toMatchObject({ code: 'AI_DIAG_APPLICATION_UNCONFIRMED' })
    expect(f.probe.mock.calls.at(-1)).toEqual(['https://api.deepseek.com/', 'direct'])

    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    await (await fetch(`${route.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ stream: true }) })).text()
    const report = await f.run('codex')
    expect(report.checks.find(check => check.id === 'application')).toMatchObject({ state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED' })
    expect(report.checks.find(check => check.id === 'account')).toMatchObject({ code: 'AI_DIAG_ACCOUNT_PROVIDER' })
  })

  it('没切过的软件仍按官方站点检查，本机 API 服务停了会被直接指出来', async () => {
    const f = await wired()
    expect((await f.run('claude')).checks.find(check => check.id === 'account')).toMatchObject({ code: 'AI_DIAG_ACCOUNT_MANUAL' })
    expect(f.probe.mock.calls.at(-1)).toEqual(['https://api.anthropic.com/', 'tunnel'])

    await f.service.saveProviderKey('claude', 'zhipu', 'zhipu-fixture-diagnostic-0123456789')
    await f.service.useProvider('claude', 'zhipu')
    await f.gateway.stop()
    const report = await f.run('claude')
    expect(f.probe.mock.calls.at(-1)).toEqual(['https://open.bigmodel.cn/', 'direct'])
    expect(report.checks.find(check => check.id === 'application')).toMatchObject({ state: 'attention', code: 'AI_DIAG_LOCAL_SERVICE_DOWN' })
  })
})
