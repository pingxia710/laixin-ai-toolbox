import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/laixin-isolation-unused' }, shell: { openExternal: vi.fn() }, session: { fromPartition: vi.fn() } }))
import { shellConfigFixture } from '../ai-access/fixtures/shell-config'
import { ApplicationIsolationLeaseController } from '../../app/main/ai-access/application-isolation-lease'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerAiAccessActions } from '../../app/main/actions/ai-access'
import { readSelection, registerActions } from '../../app/main/actions/network-diagnostics'
import { diagnosticSelectionFingerprint, runNetworkDiagnostics } from '../../app/main/network-diagnostics/service'
import { parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'
import { AiGateway } from '../../app/main/ai-access/gateway'

afterEach(() => vi.useRealTimers())

describe('应用隔离诊断跟随真实模型出口', () => {
  it.each(['codex', 'claude', 'hermes'] as const)('%s 隔离后使用同一受控 transport，仅发送无认证 HEAD', async shell => {
    const f = shellConfigFixture()
    const egress = { activate: async () => undefined, deactivate: async () => undefined }
    const adapter = shell === 'codex' ? f.service.createCodexIsolationAdapter(egress)
      : shell === 'claude' ? f.service.createClaudeIsolationAdapter(egress) : f.service.createHermesIsolationAdapter(egress)
    const controller = new ApplicationIsolationLeaseController({ applicationId: shell,
      adapter,
      system: { snapshot: async () => 'fixture-system' },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })
    try {
      await f.service.useProviderWithKey(shell, 'deepseek', 'sk-fixture-isolation-diagnostic-0123456789')
      const registry = new BridgeRegistry()
      registerAiAccessActions(registry, f.service)
      await expect(registry.execute('aiaccess.probeDiagnosticPath', { shell, revision: 'fixture', url: 'http://localhost/private' }))
        .rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
      const probe = vi.fn(async () => ({ status: 204, durationMs: 1 }))
      registerActions(registry, { probe, status: () => ({ state: '未连', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }) })
      const before = await readSelection(registry, shell)
      await expect(controller.enable()).resolves.toMatchObject({ available: true })
      const isolated = await readSelection(registry, shell)
      expect(diagnosticSelectionFingerprint(isolated)).not.toBe(diagnosticSelectionFingerprint(before))
      f.fetcher.mockClear().mockResolvedValue(new Response(null, { status: 401 }))
      const run = async () => parseDiagnosticReport((await registry.execute('networkdiagnostics.run', { software: shell }) as { snapshot: string }).snapshot)
      const report = await run()
      expect(report.target.route).toBe('isolated')
      expect(report.checks[1].code).toBe('AI_DIAG_ISOLATED_SERVICE')
      expect(report.checks[2].code).toBe('AI_DIAG_SERVICE_AUTH')
      expect(probe).toHaveBeenCalledTimes(1)
      expect(f.fetcher).toHaveBeenCalledWith('https://api.deepseek.com/', expect.objectContaining({
        method: 'HEAD', credentials: 'omit', redirect: 'manual', signal: expect.any(AbortSignal)
      }), expect.objectContaining({ shell, isolated: true }))
      const init = f.fetcher.mock.calls[0][1]!
      expect(init.headers).toBeUndefined()
      expect(init.body).toBeUndefined()
      expect(JSON.stringify(report)).not.toContain('sk-fixture')
      expect(JSON.stringify(report)).not.toContain(isolated.routeRevision)
      expect(JSON.stringify(report)).not.toContain(f.home)

      // Release the actual lease during the request; a late HTTP response is no longer evidence.
      f.fetcher.mockImplementationOnce(async () => { await controller.disable(); return new Response(null, { status: 200 }) })
      const stale = await run()
      expect(stale.checks[2].code).toBe('AI_DIAG_CONTEXT_CHANGED')
      expect(stale.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
      const restored = await readSelection(registry, shell)
      expect(restored.isolated).not.toBe(true)
      expect(diagnosticSelectionFingerprint(restored)).not.toBe(diagnosticSelectionFingerprint(isolated))
    } finally { await controller.disable(); await f.dispose() }
  })

  it('失效代次、非隔离路由及缺少受控 transport 一律不退回直连', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const gateway = new AiGateway({ fetch: fetcher })
    const route = { shell: 'codex' as const, provider: 'deepseek' as const, model: 'deepseek-chat', key: 'fixture-key', endpoint: 'https://api.deepseek.com/responses', isolated: true }
    gateway.setRoutes([route])
    const revision = gateway.snapshot().routes[0].revision!
    expect(await gateway.probeDiagnosticPath('codex', 'stale')).toMatchObject({ failure: 'path-unavailable' })
    gateway.setRoutes([{ ...route, isolated: false }])
    expect(await gateway.probeDiagnosticPath('codex', revision)).toMatchObject({ failure: 'path-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
    const noTransport = new AiGateway()
    noTransport.setRoutes([route])
    expect(await noTransport.probeDiagnosticPath('codex', noTransport.snapshot().routes[0].revision!)).toMatchObject({ failure: 'path-unavailable' })
  })

  it('黑洞请求到时中止，失败只返回固定枚举，不泄露原始错误', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => undefined) })
    const gateway = new AiGateway({ fetch: fetcher })
    gateway.setRoutes([{ shell: 'codex', provider: 'deepseek', model: 'deepseek-chat', key: 'fixture-key', endpoint: 'https://api.deepseek.com/responses', isolated: true }])
    const revision = gateway.snapshot().routes[0].revision!
    const pending = gateway.probeDiagnosticPath('codex', revision)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toMatchObject({ failure: 'timeout' })
    expect(signal?.aborted).toBe(true)
    fetcher.mockRejectedValueOnce(new Error('private-key and proxy details'))
    expect(await gateway.probeDiagnosticPath('codex', revision)).toMatchObject({ failure: 'unavailable' })
    expect(gateway.snapshot().requests).toEqual([])
  })

  it('目标相同但隔离代次更换，也必须作废旧诊断', async () => {
    let revision = 'lease-before'
    const report = await runNetworkDiagnostics('codex', {
      selection: async () => ({ mode: 'deepseek', isolated: true, routeRevision: revision }),
      probe: async () => ({ status: 204, durationMs: 1 }),
      probeIsolated: async () => { revision = 'lease-after'; return { status: 200, durationMs: 1 } },
      status: () => ({ state: '未连', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' })
    })
    expect(report.checks[2].code).toBe('AI_DIAG_CONTEXT_CHANGED')
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
  })

  it.each(['http://127.0.0.1/private', 'https://private-key@api.deepseek.com/path'])('不探测不安全的上游地址 %s', async endpoint => {
    const fetcher = vi.fn<typeof fetch>()
    const gateway = new AiGateway({ fetch: fetcher })
    gateway.setRoutes([{ shell: 'codex', provider: 'deepseek', model: 'deepseek-chat', key: 'fixture-key', endpoint, isolated: true }])
    expect(await gateway.probeDiagnosticPath('codex', gateway.snapshot().routes[0].revision!)).toMatchObject({ failure: 'path-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
