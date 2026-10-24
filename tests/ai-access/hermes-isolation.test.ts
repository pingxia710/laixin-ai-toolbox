import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { ApplicationIsolationLeaseController } from '../../app/main/ai-access/application-isolation-lease'
import type { AiAccessAdapter, ApplicationIsolationEgress, AiAccessService } from '../../app/main/ai-access/service'
import { shellConfigFixture } from './fixtures/shell-config'

const key = 'sk-hermes-isolation-fixture-key-1234567890'

type HermesIsolationService = AiAccessService & {
  createHermesIsolationAdapter(egress: ApplicationIsolationEgress): ConstructorParameters<typeof ApplicationIsolationLeaseController>[0]['adapter']
}

type HermesIsolationAdapter = AiAccessAdapter & Required<Pick<AiAccessAdapter,
  'captureIsolation' | 'applyIsolationConnection' | 'recoverIsolationLease' | 'clearIsolationLease'>>

function hermesAdapter(fixture: ReturnType<typeof shellConfigFixture>): HermesIsolationAdapter {
  const adapter = fixture.adapters.find(value => value.shell === 'hermes')
  if (adapter === undefined || adapter.captureIsolation === undefined || adapter.applyIsolationConnection === undefined ||
      adapter.recoverIsolationLease === undefined || adapter.clearIsolationLease === undefined) throw new Error('fixture Hermes isolation adapter unavailable')
  return adapter as HermesIsolationAdapter
}

function isolationConnection(fixture: ReturnType<typeof shellConfigFixture>) {
  const relay = fixture.state().relay
  if (relay === undefined || fixture.gateway.baseUrl === null) throw new Error('fixture relay unavailable')
  return { baseUrl: `${fixture.gateway.baseUrl}/hermes/deepseek/v1`, apiKey: relay.token, model: 'deepseek-flash' }
}

function capturedTarget(capture: Awaited<ReturnType<HermesIsolationAdapter['captureIsolation']>>): string {
  if (capture.targetIdentity === undefined) throw new Error('fixture Hermes isolation capture target unavailable')
  return capture.targetIdentity
}

describe('N-58 Hermes 模型 API 隔离', () => {
  const fixtures: Array<ReturnType<typeof shellConfigFixture>> = []
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())) })

  it('仅 Hermes 上游路由使用独立 transport；Codex、Claude 与普通路由不误走', async () => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    await fixture.service.useProviderWithKey('codex', 'deepseek', key)
    await fixture.service.useProviderWithKey('claude', 'deepseek', key)

    expect(Object.fromEntries(fixture.hermesSettings)).toEqual({
      'model.provider': 'custom',
      'model.default': 'deepseek-flash',
      'model.base_url': `${fixture.gateway.baseUrl}/hermes/deepseek/v1`,
      'model.api_key': fixture.state().relay?.token,
      'model.api_mode': 'chat_completions',
      'model.context_length': '1048576'
    })

    const egress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'hermes',
      adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(egress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ application: 'hermes', scope: 'model-api-egress', capability: 'http-connect', available: true, code: 'AVAILABLE' })
    expect(egress.activate).toHaveBeenCalledOnce()
    const isolatedCall = fixture.fetcher.mock.calls.at(-1) as unknown as readonly unknown[] | undefined
    expect(isolatedCall?.[2]).toMatchObject({ shell: 'hermes', isolated: true })

    await expect(controller.disable()).resolves.toMatchObject({ available: false, code: 'RESTORED' })
    expect(egress.deactivate).toHaveBeenCalledOnce()
  })

  it('Codex 与 Hermes 租约、路由标记和撤销彼此独立', async () => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('codex', 'deepseek', key)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const codexEgress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const hermesEgress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const entry = async () => ({ capability: 'http-connect' as const, id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    const system = { snapshot: vi.fn(async () => 'read-only-system-path') }
    const codex = new ApplicationIsolationLeaseController({
      applicationId: 'codex', adapter: fixture.service.createCodexIsolationAdapter(codexEgress), system, entry
    })
    const hermes = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(hermesEgress), system, entry
    })

    await expect(codex.enable()).resolves.toMatchObject({ application: 'codex', available: true })
    await expect(hermes.enable()).resolves.toMatchObject({ application: 'hermes', available: true })
    expect(codexEgress.activate).toHaveBeenCalledOnce()
    expect(hermesEgress.activate).toHaveBeenCalledOnce()

    // A replacement Key is a distinct target: its candidate probe and the new gateway route
    // must not borrow the older Hermes lease's transport while Codex remains unchanged.
    fixture.fetcher.mockClear()
    await fixture.service.useProviderWithKey('hermes', 'deepseek', 'sk-hermes-isolation-replacement-key-1234567890')
    const fetchCalls = fixture.fetcher.mock.calls as unknown as readonly (readonly unknown[])[]
    const hermesCalls = fetchCalls.filter(call => (call[2] as { shell?: string } | undefined)?.shell === 'hermes')
    expect(hermesCalls).not.toHaveLength(0)
    expect(hermesCalls.every(call => (call[2] as { isolated?: boolean } | undefined)?.isolated !== true)).toBe(true)
    fixture.fetcher.mockClear()
    await expect(codex.reverify()).resolves.toMatchObject({ application: 'codex', available: true })
    expect((fixture.fetcher.mock.calls as unknown as readonly (readonly unknown[])[]).at(-1)?.[2]).toMatchObject({ shell: 'codex', isolated: true })
    await expect(hermes.reverify()).resolves.toMatchObject({ application: 'hermes', code: 'CONFIG_READBACK_MISMATCH' })
    expect(hermesEgress.deactivate).toHaveBeenCalledOnce()
    expect(codexEgress.deactivate).not.toHaveBeenCalled()

    await expect(hermes.disable()).resolves.toMatchObject({ application: 'hermes', code: 'RESTORED' })
    expect(hermesEgress.deactivate).toHaveBeenCalledOnce()
    expect(codexEgress.deactivate).not.toHaveBeenCalled()
    await expect(codex.reverify()).resolves.toMatchObject({ application: 'codex', available: true })
  })

  it('目标探测失败，或探测期间六字段被外改，都会撤销 Hermes transport 而不宣布可用', async () => {
    const targetFailure = shellConfigFixture()
    fixtures.push(targetFailure)
    await targetFailure.service.useProviderWithKey('hermes', 'deepseek', key)
    targetFailure.fetcher.mockImplementation(async () => Response.json({ choices: [] }))
    const failedEgress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const failedController = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (targetFailure.service as HermesIsolationService).createHermesIsolationAdapter(failedEgress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })
    await expect(failedController.enable()).resolves.toMatchObject({ available: false, code: 'TARGET_UNREACHABLE' })
    expect(failedEgress.deactivate).toHaveBeenCalledOnce()

    const changedDuringProbe = shellConfigFixture()
    fixtures.push(changedDuringProbe)
    await changedDuringProbe.service.useProviderWithKey('hermes', 'deepseek', key)
    changedDuringProbe.fetcher.mockImplementationOnce(async () => {
      changedDuringProbe.hermesSettings.set('model.default', 'customer-final-model')
      changedDuringProbe.syncHermesConfig()
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] })
    })
    const changedEgress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const changedController = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (changedDuringProbe.service as HermesIsolationService).createHermesIsolationAdapter(changedEgress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })
    await expect(changedController.enable()).resolves.toMatchObject({ available: false, code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(changedDuringProbe.hermesSettings.get('model.default')).toBe('customer-final-model')
    expect(changedEgress.deactivate).toHaveBeenCalledOnce()
  })

  it.each([
    ['默认 HERMES_HOME', undefined],
    ['绝对 HERMES_HOME', '/customer/controlled-hermes']
  ])('%s 只在经核对的目标创建 Hermes 隔离租约', async (_name, hermesHome) => {
    const fixture = shellConfigFixture({ version: 1, selected: {} }, {}, { hermesHome })
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const hermes = hermesAdapter(fixture)
    const captured = await hermes.captureIsolation()
    const root = hermesHome ?? join(fixture.home, '.hermes')

    expect(fixture.data.get(join(root, 'laixin-hermes-isolation-lease.json'))).toBeDefined()
    await hermes.clearIsolationLease(captured.leaseId, capturedTarget(captured))
  })

  it('捕获 A 后 HERMES_HOME 切至相同六字段的 B 时，只结算 A，失败和重启都不误写 B', async () => {
    const homeA = '/customer/hermes-home-A'
    const homeB = '/customer/hermes-home-B'
    let currentHome = homeA
    const fixture = shellConfigFixture({ version: 1, selected: {} }, {}, {
      observeConfigurationExecution: async () => ({ hermes: { source: 'observed', userConfigPath: join(currentHome, '.env') } })
    })
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    // B deliberately starts with byte-identical six fields. Its root, not the model route,
    // differentiates the two configuration targets.
    fixture.syncHermesConfig(homeB)
    const bConfigPath = join(homeB, 'config.yaml')
    const bBefore = fixture.data.get(bConfigPath)
    const leaseA = join(homeA, 'laixin-hermes-isolation-lease.json')
    const leaseB = join(homeB, 'laixin-hermes-isolation-lease.json')
    const egress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(egress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ available: true, code: 'AVAILABLE' })
    expect(fixture.data.get(leaseA)).toBeDefined()
    currentHome = homeB
    await expect(controller.reverify()).resolves.toMatchObject({ available: false, code: 'CONFIG_READBACK_MISMATCH' })
    expect(fixture.data.get(leaseA)).toBeUndefined()
    expect(fixture.data.get(leaseB)).toBeUndefined()
    expect(fixture.data.get(bConfigPath)).toBe(bBefore)

    currentHome = homeA
    await expect(controller.enable()).resolves.toMatchObject({ available: true, code: 'AVAILABLE' })
    expect(fixture.data.get(leaseA)).toBeDefined()
    currentHome = homeB
    // A fresh controller is the startup path. It must settle the recorded A lease rather than
    // treating current B as evidence that no lease exists.
    const restarted = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(egress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })
    await expect(restarted.recover()).resolves.toMatchObject({ available: false, code: 'RESTORED' })
    expect(fixture.data.get(leaseA)).toBeUndefined()
    expect(fixture.data.get(leaseB)).toBeUndefined()
    expect(fixture.data.get(bConfigPath)).toBe(bBefore)
    expect(fixture.hermesRunRoots()).not.toContain(homeB)
  })

  it('网关恢复在重启或端口回写前先撤销 Hermes 隔离；撤销失败时零配置回写', async () => {
    let rejectRelease = false
    const release = vi.fn(async () => {
      if (rejectRelease) throw new Error('fixture isolation release failed')
    })
    const fixture = shellConfigFixture({ version: 1, selected: {} }, { beforeHermesRouteMutation: release })
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const before = Object.fromEntries(fixture.hermesSettings)
    const configurationBefore = fixture.data.get(fixture.hermesConfigPath)
    await fixture.gateway.stop()
    release.mockClear()
    rejectRelease = true

    await expect(fixture.service.recoverAccess('manual')).resolves.toMatchObject({ outcome: 'still_failing', code: 'configuration_failed' })
    expect(release).toHaveBeenCalledOnce()
    expect(Object.fromEntries(fixture.hermesSettings)).toEqual(before)
    expect(fixture.data.get(fixture.hermesConfigPath)).toBe(configurationBefore)
    expect(fixture.gateway.snapshot()).toMatchObject({ running: false, baseUrl: null, routes: [] })
  })

  it.each([
    ['冲突命令行覆盖', { commandLine: true }],
    ['未知运行态', { source: 'unknown' as const }]
  ])('%s时零写入 Hermes 配置或隔离租约', async (_name, execution) => {
    const fixture = shellConfigFixture({ version: 1, selected: {} }, {}, { configurationExecution: { hermes: execution } })
    fixtures.push(fixture)
    const hermes = hermesAdapter(fixture)

    await expect(hermes.captureIsolation()).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(fixture.hermesRunCount()).toBe(0)
    expect([...fixture.data.keys()].some(path => path.endsWith('laixin-hermes-isolation-lease.json'))).toBe(false)
  })

  it('租约只保存六字段摘要和目标身份；在落盘、部分字段和完整字段崩溃后只释放租约', async () => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const hermes = hermesAdapter(fixture)
    const leasePath = join(fixture.home, '.hermes', 'laixin-hermes-isolation-lease.json')
    const recoveryPointPath = join(fixture.home, '.hermes', 'laixin-model-api-backup.json')
    const envPath = join(fixture.home, '.hermes', '.env')
    const recoveryPointBefore = fixture.data.get(recoveryPointPath)
    const envBefore = fixture.data.get(envPath)
    // Stage 1: a crash immediately after durable lease creation has no config to reconstruct.
    const landedCapture = await hermes.captureIsolation()
    expect(landedCapture.leaseId).toMatch(/^[0-9a-f-]{36}$/i)
    await expect(hermes.recoverIsolationLease()).resolves.toBe('restored')
    expect(fixture.data.get(leasePath)).toBeUndefined()

    const capture = await hermes.captureIsolation()
    const rawLease = fixture.data.get(leasePath) ?? ''
    expect(rawLease).not.toContain(key)
    expect(rawLease).not.toContain(fixture.state().relay!.token)
    expect(rawLease).not.toContain('deepseek-flash')
    expect(rawLease).not.toContain('chat_completions')

    fixture.hermesSettings.set('model.default', 'customer-final-model')
    fixture.syncHermesConfig()
    await expect(hermes.applyIsolationConnection('deepseek', isolationConnection(fixture), capture.beforeIsolationFingerprint, capture.leaseId, capturedTarget(capture))).resolves.toBe('stale')
    expect(fixture.hermesSettings.get('model.default')).toBe('customer-final-model')
    await hermes.clearIsolationLease(capture.leaseId, capturedTarget(capture))

    // Stage 2: a persisted expected fingerprint with incomplete six-field state is never
    // rebuilt at startup; the current final value is retained and only the lease is released.
    fixture.hermesSettings.set('model.default', 'deepseek-flash')
    fixture.syncHermesConfig()
    const partialCapture = await hermes.captureIsolation()
    await expect(hermes.applyIsolationConnection('deepseek', isolationConnection(fixture), partialCapture.beforeIsolationFingerprint, partialCapture.leaseId, capturedTarget(partialCapture))).resolves.toMatchObject({ outcome: 'applied' })
    fixture.hermesSettings.set('model.context_length', 'customer-partial-final-value')
    fixture.syncHermesConfig()
    await expect(hermes.recoverIsolationLease()).resolves.toBe('preserved-external')
    expect(fixture.hermesSettings.get('model.context_length')).toBe('customer-partial-final-value')
    expect(fixture.data.get(leasePath)).toBeUndefined()

    // Stage 3: a complete matching configuration similarly just settles the lease; it does
    // not recreate an Electron session or a system-network entry during recovery.
    fixture.hermesSettings.set('model.context_length', '1048576')
    fixture.syncHermesConfig()
    const restartCapture = await hermes.captureIsolation()
    await expect(hermes.applyIsolationConnection('deepseek', isolationConnection(fixture), restartCapture.beforeIsolationFingerprint, restartCapture.leaseId, capturedTarget(restartCapture))).resolves.toMatchObject({ outcome: 'applied' })
    await expect(hermes.recoverIsolationLease()).resolves.toBe('restored')
    expect(fixture.data.get(leasePath)).toBeUndefined()
    expect(fixture.data.get(recoveryPointPath)).toBe(recoveryPointBefore)
    expect(fixture.data.get(envPath)).toBe(envBefore)
  })

  it.each([1, 2, 3, 4, 5, 6])('第 %i 个 Hermes config set 失败时逆序恢复并严格读回旧六字段', async (failedWrite) => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const hermes = hermesAdapter(fixture)
    const before = Object.fromEntries(fixture.hermesSettings)
    const capture = await hermes.captureIsolation()
    fixture.failHermesWriteAt(failedWrite)

    await expect(hermes.applyIsolationConnection('deepseek', isolationConnection(fixture), capture.beforeIsolationFingerprint, capture.leaseId, capturedTarget(capture))).rejects.toThrow('fixture hermes config write failed')
    expect(Object.fromEntries(fixture.hermesSettings)).toEqual(before)
    await hermes.clearIsolationLease(capture.leaseId, capturedTarget(capture))
  })

  it('客户在隔离后修改 YAML 时，停用只释放 transport 并保留最终六字段', async () => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    const egress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'hermes',
      adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(egress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })
    await controller.enable()
    fixture.hermesSettings.set('model.default', 'customer-final-model')
    fixture.syncHermesConfig()

    await expect(controller.disable()).resolves.toMatchObject({ code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(fixture.hermesSettings.get('model.default')).toBe('customer-final-model')
    expect(egress.deactivate).toHaveBeenCalledOnce()
  })

  it('六字段写完到严格读回之间出现客户最终值时，不用旧值回滚覆盖它', async () => {
    const fixture = shellConfigFixture()
    fixtures.push(fixture)
    await fixture.service.useProviderWithKey('hermes', 'deepseek', key)
    fixture.changeHermesAfterWriteAt(6, 'model.default', 'customer-final-model')
    const egress: ApplicationIsolationEgress = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined) }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'hermes', adapter: (fixture.service as HermesIsolationService).createHermesIsolationAdapter(egress),
      system: { snapshot: vi.fn(async () => 'read-only-system-path') },
      entry: async () => ({ capability: 'http-connect', id: 'fixture-local-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ available: false, code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(fixture.hermesSettings.get('model.default')).toBe('customer-final-model')
    expect(egress.deactivate).toHaveBeenCalledOnce()
  })
})
