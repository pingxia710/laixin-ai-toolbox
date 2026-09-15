import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiAccessService, aiAccessProviders, aiAccessShells, validAiAccessState, type AiAccessState, type AiAccessShell, type AiAccessAdapter } from '../../app/main/ai-access/service'
import { AiGateway } from '../../app/main/ai-access/gateway'
import { isProviderShellSupported, providerShellContract } from '../../app/shared/model-providers'
import type { FaultInput } from '../../app/main/diagnostics/fault-log'

const services: AiAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())) })
function reply(shell: AiAccessShell, second: boolean): Response {
  if (second) {
    const frames = shell === 'codex' ? [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 21, output_tokens: 2 } } }]
      : shell === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 2 } }]
    return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const body = shell === 'codex' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }
    : shell === 'claude' ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] }
  return Response.json(body)
}
function fixture(initial: AiAccessState = { version: 1, selected: {} }, status = 200) {
  let state = initial
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (status !== 200) return new Response('private provider detail', { status })
    const endpoint = String(url)
    const shell = endpoint.endsWith('/responses') ? 'codex' : endpoint.endsWith('/messages') ? 'claude' : 'hermes'
    return reply(shell, JSON.parse(String(init?.body)).stream === true)
  })
  const adapters = aiAccessShells.map(shell => ({ shell, applyDeepSeek: vi.fn(async () => undefined), applyConnection: vi.fn<NonNullable<AiAccessAdapter['applyConnection']>>(async () => undefined),
    captureConnection: vi.fn(async () => vi.fn(async () => undefined)),
    ...(shell !== 'hermes' ? { activateOfficial: vi.fn(async () => undefined) } : {}) }))
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000 })
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const faults: FaultInput[] = []
  const service = new AiAccessService(store, adapters, gateway, { recordFault: fault => { faults.push(fault) } })
  services.push(service)
  return { service, adapters, fetcher, gateway, store, faults, state: () => state }
}
function supportedProviders(shell: AiAccessShell) {
  return aiAccessProviders.filter(provider => isProviderShellSupported(provider, shell))
}
function supportedContract(shell: AiAccessShell, provider: typeof aiAccessProviders[number]) {
  const contract = providerShellContract(provider, shell)
  if (contract.status !== 'supported') throw new Error('fixture requested a pending provider shell')
  return contract
}
describe('保存 Key 到真实路由的闭环（隔离上游）', () => {
  it('智谱普通 API 与 Coding Plan 都能在 Codex 按各自合同完成探测和写入', async () => {
    const f = fixture()
    for (const provider of ['zhipu-api', 'zhipu'] as const) {
      const contract = supportedContract('codex', provider)
      const key = `sk-fixture-${provider}-codex-0123456789`
      const configured = await f.service.configureProvider('codex', provider, key, 'glm-5.3-flash')
      expect(configured.attempt).toMatchObject({ ok: true, shell: 'codex', provider })
      expect(await f.service.providerConfiguration('codex', provider)).toMatchObject({ endpoint: contract.endpoint, model: 'glm-5.3-flash', models: ['glm-5.3-flash'] })
      expect(f.fetcher.mock.lastCall?.[0]).toBe(contract.endpoint)
      expect(f.adapters[0].applyConnection.mock.lastCall?.[1].model).toBe('glm-5.3-flash')
    }
  })

  it('历史模型只迁移到当前白名单；新的选择按产品和壳精确校验，保留 Kimi Claude 的 k3[1m]', async () => {
    const zhipuKey = 'sk-fixture-zhipu-migration-0123456789'
    const f = fixture({
      version: 1,
      shellKeys: { claude: { zhipu: zhipuKey } },
      shellModels: { claude: { zhipu: 'glm-5.3' } },
      selected: {}
    })

    await f.service.useProvider('claude', 'zhipu')
    expect(f.state().shellModels?.claude?.zhipu).toBe('glm-5.3-flash')
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('glm-5.3-flash')
    expect((await f.service.providerConfiguration('claude', 'zhipu')).models).not.toContain('glm-5.3')
    await expect(f.service.configureProvider('claude', 'zhipu', zhipuKey, 'glm-5.3')).rejects.toThrow('AI_ACCESS_MODEL_INVALID')

    await f.service.configureProvider('claude', 'kimi', 'sk-fixture-kimi-claude-0123456789', 'k3[1m]')
    expect(f.adapters[1].applyConnection.mock.lastCall?.[1].model).toBe('k3[1m]')
  })

  it('Codex 项目配置只作诊断，服务始终走用户级目标且拒绝项目选择', async () => {
    const f = fixture()
    const userTarget = {
      shell: 'codex' as const,
      scope: 'user' as const,
      override: 'none' as const,
      writable: true as const,
      reason: 'project-configuration-ignored' as const
    }
    const status = vi.fn(async () => userTarget)
    const choose = vi.fn(async () => userTarget)
    Object.assign(f.adapters[0], { configurationTargetStatus: status, selectConfigurationTarget: choose })

    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-project-target-0123456789')
    const applied = await f.service.useProvider('codex', 'deepseek')
    expect(applied.attempt).toMatchObject({ ok: true, shell: 'codex', provider: 'deepseek' })
    expect(f.adapters[0].applyConnection).toHaveBeenCalledOnce()
    expect(applied.configurationTargets?.codex).toEqual(userTarget)
    await expect(f.service.selectConfigurationTarget('codex', 'project')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
    expect(choose).not.toHaveBeenCalled()
    expect(f.state().configurationTargetScopes?.codex).toBeUndefined()
  })

  it('受控目录选择只交给主进程适配器：状态只保留 project 决定，不保存客户目录', async () => {
    const f = fixture()
    const evidence = { shell: 'claude' as const, scope: 'project' as const, override: 'project' as const, writable: true as const }
    const selectProject = vi.fn(async (projectDir: string) => {
      expect(projectDir).toBe('/customer/selected-project')
      return evidence
    })
    Object.assign(f.adapters[1], { selectConfigurationProject: selectProject })

    const status = await f.service.selectConfigurationProject('claude', '/customer/selected-project')
    expect(selectProject).toHaveBeenCalledOnce()
    expect(status.configurationTargets?.claude).toEqual(evidence)
    expect(f.state().configurationTargetScopes?.claude).toBe('project')
    expect(JSON.stringify(status)).not.toContain('/customer/selected-project')
    expect(JSON.stringify(f.state())).not.toContain('/customer/selected-project')
  })

  it('Claude 接管时拒绝改变配置目标；解除工具箱接管后可直接选择新的项目目录', async () => {
    const f = fixture()
    const evidence = { shell: 'claude' as const, scope: 'project' as const, override: 'project' as const, writable: true as const }
    const selectTarget = vi.fn(async () => evidence)
    const selectProject = vi.fn(async () => evidence)
    Object.assign(f.adapters[1], { selectConfigurationTarget: selectTarget, selectConfigurationProject: selectProject })

    await f.service.configureProvider('claude', 'deepseek', 'sk-fixture-target-lock-0123456789', 'deepseek-flash')
    const active = structuredClone(f.state())
    await expect(f.service.selectConfigurationTarget('claude', 'project')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_CHANGE_REQUIRES_CLEAN_CONNECTION')
    await expect(f.service.selectConfigurationProject('claude', '/customer/project-a')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_CHANGE_REQUIRES_CLEAN_CONNECTION')
    expect(selectTarget).not.toHaveBeenCalled()
    expect(selectProject).not.toHaveBeenCalled()
    expect(f.state()).toEqual(active)

    await f.service.useOfficial('claude')
    await expect(f.service.selectConfigurationProject('claude', '/customer/project-a')).resolves.toMatchObject({
      configurationTargets: { claude: evidence }
    })
    expect(selectProject).toHaveBeenCalledWith('/customer/project-a')
  })

  it('Kimi Key 产品错配时只在姐妹入口探测成功后给出可一键切换的安全建议', async () => {
    const f = fixture()
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes('api.kimi.com/coding')) return new Response('{"error":{"code":"invalid_token"}}', { status: 401 })
      const shell = String(url).endsWith('/responses') ? 'codex' : String(url).endsWith('/messages') ? 'claude' : 'hermes'
      return reply(shell, JSON.parse(String(init?.body)).stream === true)
    })
    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-kimi-open-key-0123456789')
    const status = await f.service.useProvider('codex', 'kimi')

    expect(status.attempt).toMatchObject({ ok: false, code: 'key_product_mismatch', suggestedProvider: 'moonshot' })
    expect(status.attempt?.notice).toContain('Kimi 开放平台 API')
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect(JSON.stringify(status)).not.toContain('sk-fixture-kimi-open-key')
  })

  it('Kimi Key 在姐妹入口也未通过时只说 Key 未通过，不误导客户切换产品', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValue(new Response('{"error":{"code":"invalid_token"}}', { status: 401 }))
    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-invalid-kimi-key-0123456789')

    const status = await f.service.useProvider('codex', 'kimi')

    expect(status.attempt).toMatchObject({ ok: false, code: 'key_rejected' })
    expect(status.attempt?.suggestedProvider).toBeUndefined()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
  })

  it('Claude 的同一条 401 自动重试会保留每次请求记录，但客服故障短窗口内只记一次', async () => {
    const f = fixture()
    await f.service.configureProvider('claude', 'deepseek', 'sk-fixture-claude-retry-0123456789', 'deepseek-v4-pro')
    f.faults.length = 0
    f.fetcher.mockResolvedValue(new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }))
    const upstreamCallsBeforeRetries = f.fetcher.mock.calls.length
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'claude')!
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${route.baseUrl}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ messages: [] })
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Key 未通过认证')
    }
    const clientFailures = (await f.service.serviceStatus()).requests.filter(record => record.source === 'client' && record.code === 'key_rejected')
    expect(clientFailures).toHaveLength(8)
    expect(f.fetcher).toHaveBeenCalledTimes(upstreamCallsBeforeRetries + 1)
    expect(f.faults.filter(fault => fault.shell === 'claude' && fault.provider === 'deepseek' && fault.code === 'key_rejected')).toHaveLength(1)
  })

  it('恢复上一次连接是明确的第三方恢复操作，不能标作恢复官方', async () => {
    const f = fixture()
    await f.service.configureProvider('codex', 'deepseek', 'sk-fixture-restore-previous-0123456789', 'deepseek-v4-pro')
    const restore = vi.fn(async () => undefined)
    Object.assign(f.adapters[0], { restorePreviousConnection: restore })

    await f.service.useOfficial('codex')
    const status = await f.service.restorePreviousConnection('codex')
    expect(restore).toHaveBeenCalledOnce()
    expect(status.shells.codex.selected).toBeNull()
    expect((await f.service.serviceStatus()).routes.find(route => route.shell === 'codex')).toBeUndefined()
  })

  it('客户仍在使用工具箱 API 时，主进程拒绝恢复旧第三方连接且不改动配置', async () => {
    const f = fixture()
    await f.service.configureProvider('codex', 'deepseek', 'sk-fixture-restore-guard-0123456789', 'deepseek-v4-pro')
    const restore = vi.fn(async () => undefined)
    Object.assign(f.adapters[0], { restorePreviousConnection: restore })
    const before = structuredClone(f.state())

    await expect(f.service.restorePreviousConnection('codex')).rejects.toThrow('AI_ACCESS_RESTORE_PREVIOUS_REQUIRES_OFFICIAL')
    expect(restore).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)
  })

  it('解除 Codex 工具箱路由后，未确认官方登录会给出登录所需提示而不冒充已恢复官方', async () => {
    const f = fixture()
    const deactivateToolboxConnection = vi.fn(async () => undefined)
    const officialAuthenticationStatus = vi.fn(async () => ({ state: 'login-required' as const, reason: 'other-tool-api-key' as const }))
    Object.assign(f.adapters[0], { deactivateToolboxConnection, officialAuthenticationStatus })
    await f.service.configureProvider('codex', 'deepseek', 'sk-fixture-official-auth-0123456789', 'deepseek-v4-pro')

    const result = await f.service.remedy('codex', 'useOfficial')
    expect(deactivateToolboxConnection).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ action: 'useOfficial', outcome: 'unknown', provider: null })
    expect(result.message).toBe('工具箱 API 路由已解除，但当前没有可确认的官方登录。请在 Codex 中完成官方登录后再试。')
    await expect(f.service.status()).resolves.toMatchObject({
      shells: { codex: { selected: 'official' } },
      officialAuthentication: { codex: { state: 'login-required', reason: 'other-tool-api-key' } }
    })
  })

  it('各产品的模型名单按已验收壳隔离，模型按壳与渠道保存，切换离开再启用仍使用原选择', async () => {
    const f = fixture()
    for (const shell of aiAccessShells) for (const provider of supportedProviders(shell)) {
      const models = supportedContract(shell, provider).models
      for (const model of models) {
        const status = await f.service.configureProvider(shell, provider, 'sk-fixture-model-options-123456789', model)
        expect(status.attempt?.ok).toBe(true)
        expect(f.state().shellModels?.[shell]?.[provider]).toBe(model)
        expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe(model)
      }
    }
    for (const provider of supportedProviders('codex')) {
      const saved = f.state().shellModels!.codex![provider]
      await f.service.useProvider('codex', provider)
      expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe(saved)
    }
  })
  it.each(aiAccessShells)('%s 编辑模型后验证、壳配置、实际请求与重启都使用所选模型，失败保留原配置', async shell => {
    const f = fixture()
    const key = 'sk-fixture-selected-model-0123456789'
    await f.service.configureProvider(shell, 'deepseek', key, 'deepseek-v4-pro')
    expect(f.state().shellModels?.[shell]?.deepseek).toBe('deepseek-v4-pro')
    expect(f.adapters.find(a => a.shell === shell)!.applyConnection.mock.lastCall?.[1].model).toBe('deepseek-v4-pro')
    expect(f.fetcher.mock.calls.slice(-2).map(c => JSON.parse(String(c[1]?.body)).model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro'])
    expect(await f.service.providerConfiguration(shell, 'deepseek')).toMatchObject({ model: 'deepseek-v4-pro', models: expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']) })
    for (const other of aiAccessShells.filter(s => s !== shell)) {
      expect((await f.service.providerConfiguration(other, 'deepseek')).model).toBe('deepseek-flash')
      expect(f.adapters.find(a => a.shell === other)!.applyConnection).not.toHaveBeenCalled()
    }
    const before = structuredClone(f.state())
    await f.service.measureProviderLatency(shell, 'deepseek', '', 'deepseek-flash')
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('deepseek-flash')
    expect(f.state()).toEqual(before)
    for (const failure of ['key_rejected', 'configuration_failed', 'persistence'] as const) {
      if (failure === 'key_rejected') f.fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
      if (failure === 'configuration_failed') f.adapters.find(a => a.shell === shell)!.applyConnection.mockRejectedValueOnce(new Error('fixture'))
      const write = f.store.write
      if (failure === 'persistence') f.store.write = async state => {
        if (state.shellModels?.[shell]?.deepseek === 'deepseek-flash') throw new Error('fixture disk full')
        await write(state)
      }
      const result = await f.service.configureProvider(shell, 'deepseek', 'sk-fixture-replacement-0123456789', 'deepseek-flash')
      expect(result.attempt?.ok).toBe(false)
      expect(f.state()).toEqual(before)
      f.store.write = write
    }
    await expect(f.service.configureProvider(shell, 'deepseek', '', 'kimi-k3')).rejects.toThrow('MODEL_INVALID')
    await expect(f.service.configureProvider(shell, 'deepseek', '', 'bad"\nmodel_provider="evil')).rejects.toThrow('MODEL_INVALID')
    await f.service.stop()
    const restored = new AiAccessService(f.store, f.adapters, new AiGateway({ fetch: f.fetcher }))
    services.push(restored)
    await restored.initialize()
    expect((await restored.providerConfiguration(shell, 'deepseek')).model).toBe('deepseek-v4-pro')
    const route = (await restored.serviceStatus()).routes[0]
    const suffix = shell === 'codex' ? '/responses' : shell === 'claude' ? '/v1/messages' : '/chat/completions'
    const response = await fetch(`${route.baseUrl}${suffix}`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ model: 'client-stale-model', stream: true }) })
    expect(response.status).toBe(200); await response.text()
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('deepseek-v4-pro')
  })
  it.each(aiAccessShells)('%s 多渠道来回启动后，客户端请求的地址、模型和 Key 全部切换；失败保留旧渠道', async shell => {
    const f = fixture()
    const suffix = shell === 'codex' ? '/responses' : shell === 'claude' ? '/v1/messages' : '/chat/completions'
    const request = async (baseUrl: string) => fetch(`${baseUrl}${suffix}`, {
      method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` },
      body: JSON.stringify({ model: 'old-client-model', stream: true })
    })
    let previousUrl: string | undefined
    const providers = supportedProviders(shell)
    for (const provider of providers) {
      const key = `sk-fixture-${shell}-${provider}-0123456789`
      await f.service.saveProviderKey(shell, provider, key)
      const status = await f.service.useProvider(shell, provider)
      expect(status.shells[shell].selected).toBe(provider)
      expect(status.attempt).toMatchObject({ ok: true, shell, provider })
      const connection = f.adapters.find(a => a.shell === shell)!.applyConnection.mock.lastCall![1]
      const routes = (await f.service.serviceStatus()).routes
      expect(routes).toHaveLength(1)
      expect(connection.baseUrl).toBe(routes[0].baseUrl)
      const response = await request(connection.baseUrl)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('OK')
      const [url, init] = f.fetcher.mock.lastCall!
      expect(url).toBe(supportedContract(shell, provider).endpoint)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
      expect(JSON.parse(String(init?.body)).model).toBe(supportedContract(shell, provider).defaultModel)
      expect((await f.service.serviceStatus()).requests[0]).toMatchObject({ source: 'client', shell, provider, ok: true })
      if (previousUrl && previousUrl !== connection.baseUrl) {
        const count = f.fetcher.mock.calls.length
        expect((await request(previousUrl)).status).toBe(409)
        expect(f.fetcher).toHaveBeenCalledTimes(count)
      }
      previousUrl = connection.baseUrl
    }
    const stableProvider = providers.at(-1)!
    const failingProvider = stableProvider === 'kimi' ? 'deepseek' : 'kimi'
    for (const cause of ['key_rejected', 'configuration_failed'] as const) {
      if (cause === 'key_rejected') f.fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
      else f.adapters.find(a => a.shell === shell)!.applyConnection.mockRejectedValueOnce(new Error('fixture config failure'))
      const status = await f.service.useProvider(shell, failingProvider)
      expect(status.attempt).toMatchObject({ ok: false, code: cause })
      expect(status.shells[shell].selected).toBe(stableProvider)
      const response = await request(previousUrl!)
      expect(response.status).toBe(200); await response.text()
      expect(f.fetcher.mock.lastCall![0]).toBe(supportedContract(shell, stableProvider).endpoint)
    }
    expect(f.adapters.filter(a => a.shell !== shell).every(a => a.applyConnection.mock.calls.length === 0)).toBe(true)
  })
  it('只改当前壳的 Key；同服务商的其他壳、路由和配置均不受影响', async () => {
    const f = fixture()
    const first = 'sk-fixture-codex-0123456789'
    const second = 'sk-fixture-claude-0123456789'
    await f.service.saveProviderKey('codex', 'deepseek', first)
    expect((await f.service.status()).shells).toMatchObject({
      codex: { providerKeys: { deepseek: true } },
      claude: { providerKeys: { deepseek: false } }, hermes: { providerKeys: { deepseek: false } }
    })
    await expect(f.service.useProvider('claude', 'deepseek')).rejects.toThrow('KEY_MISSING')
    await f.service.useProvider('codex', 'deepseek')
    expect(f.adapters[1].applyConnection).not.toHaveBeenCalled()
    expect(f.adapters[2].applyConnection).not.toHaveBeenCalled()
    await f.service.saveProviderKey('claude', 'deepseek', second)
    await f.service.useProvider('claude', 'deepseek')
    const claudeRoute = (await f.service.serviceStatus()).routes.find(r => r.shell === 'claude')
    const replacement = 'sk-fixture-new-codex-0123456789'
    await f.service.saveProviderKey('codex', 'deepseek', replacement)
    // 换 Key ⛔ 摘掉自己的路由（摘了就是 CLI 409），更 ⛔ 动别的壳那条。
    const afterSave = (await f.service.serviceStatus()).routes
    expect(afterSave.find(route => route.shell === 'claude')).toEqual(claudeRoute)
    expect(afterSave.find(route => route.shell === 'codex')).toMatchObject({ shell: 'codex', provider: 'deepseek' })
    expect(f.state().shellKeys?.claude?.deepseek).toBe(second)
    expect(f.adapters[1].applyConnection).toHaveBeenCalledOnce()
    expect((await f.service.serviceStatus()).routes.find(r => r.shell === 'claude')).toEqual(claudeRoute)
    const headers = f.fetcher.mock.calls.map(call => (call[1]?.headers as Record<string,string>).authorization)
    expect(headers).toEqual([first,first,second,second,replacement,replacement].map(key => `Bearer ${key}`))
  })
  it('旧版共享 Key 只保留原先已选择它的壳，不自动分给未配置的壳', async () => {
    const original = 'sk-fixture-legacy-0123456789'
    const f = fixture({ version: 1, deepseekKey: original, selected: { codex: 'deepseek', claude: 'deepseek' } })
    expect((await f.service.status()).shells.hermes.providerKeys.deepseek).toBe(false)
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-replacement-0123456789')
    expect(f.state().shellKeys?.claude?.deepseek).toBe(original)
    await expect(f.service.useProvider('hermes', 'deepseek')).rejects.toThrow('KEY_MISSING')
    // Replacing the Key for an already selected Codex route is deliberately a
    // verified switch. The legacy Claude selection is not rewritten and Hermes
    // never receives the inherited historical Key.
    expect(f.adapters[0].applyConnection).toHaveBeenCalledOnce()
    expect(f.adapters.slice(1).every(adapter => adapter.applyConnection.mock.calls.length === 0)).toBe(true)
  })
  it('每个已验收入口和壳使用各自官方 POST 地址；工具往返与流式通过后才配置本机令牌', async () => {
    const f = fixture()
    for (const provider of aiAccessProviders) {
      const key = `sk-fixture-${provider}-0123456789`
      for (const shell of aiAccessShells.filter(shell => isProviderShellSupported(provider, shell))) {
        await f.service.saveProviderKey(shell, provider, key)
        const status = await f.service.useProvider(shell, provider)
        expect(status.attempt).toMatchObject({ shell, provider, ok: true })
        const configured = f.adapters.find(a => a.shell === shell)!.applyConnection.mock.lastCall
        expect(configured).toEqual([provider, expect.objectContaining({ model: supportedContract(shell, provider).defaultModel, apiKey: f.state().relay!.token })])
        expect(JSON.stringify(configured)).not.toContain(key)
        const calls = f.fetcher.mock.calls.slice(-2)
        expect(calls.map(c => String(c[0]))).toEqual([supportedContract(shell, provider).endpoint, supportedContract(shell, provider).endpoint])
        expect(JSON.stringify(await f.service.serviceStatus())).not.toContain(key)
      }
    }
    expect(f.fetcher).toHaveBeenCalledTimes(aiAccessShells.reduce((count, shell) => count + supportedProviders(shell).length, 0) * 2)
    expect((await f.service.serviceStatus()).requests.every(r => r.source === 'test')).toBe(true)
  })
  it('Key 错误只保存，不覆盖现有官方配置，也不伪报测试成功', async () => {
    const f = fixture({ version: 1, selected: { codex: 'official' } }, 401)
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    const status = await f.service.useProvider('codex', 'deepseek')
    expect(status.attempt).toMatchObject({ ok: false, code: 'key_rejected' })
    expect(status.shells.codex.selected).toBe('official')
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect((await f.service.serviceStatus()).routes).toEqual([])
  })
  it('配置失败区分于接口已通，当前来源保持原样', async () => {
    const f = fixture()
    f.adapters[1].applyConnection.mockRejectedValueOnce(new Error('private path'))
    await f.service.saveProviderKey('claude', 'deepseek', 'sk-fixture-deepseek-0123456789')
    const status = await f.service.useProvider('claude', 'deepseek')
    expect(status.attempt).toMatchObject({ ok: false, code: 'configuration_failed' })
    expect(status.shells.claude.selected).toBe(null)
  })
  it('重启恢复原端口与令牌，不写壳配置、不花费上游额度；恢复官方关闭该路由', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const before = await f.service.serviceStatus()
    await f.service.stop()
    const restored = new AiAccessService(f.store, f.adapters, new AiGateway({ fetch: f.fetcher }))
    services.push(restored)
    f.fetcher.mockClear(); f.adapters.forEach(a => a.applyConnection.mockClear())
    await restored.initialize()
    expect((await restored.serviceStatus()).baseUrl).toBe(before.baseUrl)
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    await restored.useOfficial('codex')
    expect((await restored.serviceStatus()).routes).toEqual([])
  })
  it('旧 Z.AI 国际站 Key 不变成国内 Key，也不会凭它创建国内智谱路由', async () => {
    const f = fixture({ version: 1, zaiKey: 'sk-fixture-legacy-zai-0123456789', selected: { codex: 'zai' } })
    await f.service.initialize()
    expect(await f.service.status()).toMatchObject({ legacyZaiKeySaved: true, shells: { codex: { providerKeys: { zhipu: false } } } })
    await expect(f.service.useProvider('codex','zhipu')).rejects.toThrow('AI_ACCESS_ZHIPU_KEY_MISSING')
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.state().zaiKey).toBe('sk-fixture-legacy-zai-0123456789')
  })
  it('升级后的历史 Coding Plan Codex 路由按当前合同继续使用，不改写客户配置', async () => {
    const zhipuKey = 'sk-fixture-zhipu-paused-0123456789'
    const deepseekKey = 'sk-fixture-deepseek-preserved-0123456789'
    const f = fixture({ version: 1, selected: { codex: 'zhipu' }, shellKeys: { codex: { zhipu: zhipuKey, deepseek: deepseekKey } } })
    const token = 'a'.repeat(64)
    const port = await f.gateway.start(0, token)
    await f.store.write({ ...f.state(), relay: { port, token }, relayShells: ['codex'] })
    const before = structuredClone(f.state())

    expect(validAiAccessState(before)).toBe(true)
    await f.service.initialize()

    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'codex', provider: 'zhipu', model: 'glm-5.3-flash' }])
    expect((await f.service.serviceStatus()).startupError).toBeUndefined()
    expect(await f.service.status()).toMatchObject({ shells: { codex: { selected: 'zhipu' } } })
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)

    await f.service.useOfficial('codex')
    expect((await f.service.status()).shells.codex.selected).toBe('official')
    expect(f.state().shellKeys?.codex?.deepseek).toBe(deepseekKey)
    expect((await f.service.serviceStatus()).routes).toEqual([])

    await f.service.useProvider('codex', 'deepseek')
    expect((await f.service.status()).shells.codex.selected).toBe('deepseek')
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'codex', provider: 'deepseek', model: 'deepseek-flash' }])
  })

  it('缺少 relayShells 的历史 Coding Plan Codex 选择仍不冒充当前网关路由', async () => {
    const zhipuKey = 'sk-fixture-zhipu-no-relay-0123456789'
    const deepseekKey = 'sk-fixture-deepseek-no-relay-0123456789'
    const f = fixture({
      version: 1,
      selected: { codex: 'zhipu' },
      shellKeys: { codex: { zhipu: zhipuKey, deepseek: deepseekKey } }
    })
    const before = structuredClone(f.state())

    expect(validAiAccessState(before)).toBe(true)
    await f.service.initialize()

    expect((await f.service.serviceStatus())).toMatchObject({ routes: [] })
    expect(await f.service.status()).toMatchObject({ shells: { codex: {
      selected: null, legacyDirect: { provider: 'zhipu', reason: 'not-managed-by-current-gateway' }
    } } })
    expect((await f.service.serviceStatus()).usage.find(stage => stage.shell === 'codex')).toMatchObject({ configuration: 'not-managed' })
    expect(f.gateway.snapshot().running).toBe(false)
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)

    const recovery = await f.service.recoverAccess('manual')
    expect(recovery).toMatchObject({ outcome: 'not-managed' })
    expect(f.gateway.snapshot().running).toBe(false)
    expect(f.state()).toEqual(before)

    await f.service.useOfficial('codex')
    expect((await f.service.status()).shells.codex.selected).toBe('official')
    expect(f.state().shellKeys?.codex?.deepseek).toBe(deepseekKey)
  })

  it('旧版受支持直连记录不冒充当前网关路由，显式启用才迁移到本机路由', async () => {
    const key = 'sk-fixture-legacy-direct-deepseek-0123456789'
    const f = fixture({ version: 1, selected: { codex: 'deepseek' }, shellKeys: { codex: { deepseek: key } } })
    const before = structuredClone(f.state())

    await f.service.initialize()

    expect((await f.service.serviceStatus()).routes).toEqual([])
    expect(await f.service.status()).toMatchObject({ shells: { codex: {
      selected: null,
      legacyDirect: { provider: 'deepseek', reason: 'not-managed-by-current-gateway' },
      providerKeys: { deepseek: true }
    } } })
    expect(f.state()).toEqual(before)
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()

    const enabled = await f.service.useProvider('codex', 'deepseek')
    expect(enabled.shells.codex).toMatchObject({ selected: 'deepseek', providerKeys: { deepseek: true } })
    expect(enabled.shells.codex.legacyDirect).toBeUndefined()
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'codex', provider: 'deepseek' }])
    expect(f.adapters[0].applyConnection).toHaveBeenCalledOnce()
  })

  it('受支持路由的中断状态不冒充当前配置，恢复前不写文件，客户可显式重新启用', async () => {
    const key = 'sk-fixture-interrupted-deepseek-0123456789'
    const f = fixture({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: key } },
      relayShells: ['codex'],
      pendingShells: ['codex']
    })
    const before = structuredClone(f.state())

    await f.service.initialize()

    expect(await f.service.status()).toMatchObject({ shells: { codex: {
      selected: null,
      interrupted: { provider: 'deepseek', reason: 'configuration-interrupted' },
      providerKeys: { deepseek: true }
    } } })
    expect((await f.service.serviceStatus())).toMatchObject({ routes: [], startupError: 'configuration_interrupted' })
    await expect(f.service.recoverAccess('manual')).resolves.toMatchObject({ outcome: 'still_failing', code: 'configuration_interrupted' })
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)

    const enabled = await f.service.useProvider('codex', 'deepseek')
    expect(enabled.shells.codex).toMatchObject({ selected: 'deepseek' })
    expect(enabled.shells.codex.interrupted).toBeUndefined()
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'codex', provider: 'deepseek' }])
  })

  it('relayShells 留有支持的 Codex 但缺少 relay 凭据时，初始化和恢复都只报告中断，不写壳配置', async () => {
    const key = 'sk-fixture-missing-relay-codex-0123456789'
    const f = fixture({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: key } },
      relayShells: ['codex']
    })
    const before = structuredClone(f.state())

    expect(validAiAccessState(before)).toBe(true)
    await f.service.initialize()

    expect((await f.service.serviceStatus())).toMatchObject({ routes: [], startupError: 'configuration_interrupted' })
    expect((await f.service.status()).shells.codex).toMatchObject({
      selected: null,
      interrupted: { provider: 'deepseek', reason: 'configuration-interrupted' }
    })
    await expect(f.service.recoverAccess('manual')).resolves.toMatchObject({ outcome: 'still_failing', code: 'configuration_interrupted' })
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)
  })

  it.each(['glm-5.3', 'glm-5.3-flash'] as const)('历史 Codex Coding Plan %s 不隔离整包状态；未接管的记录不生成本机路由', async model => {
    const zhipuKey = `sk-fixture-zhipu-${model.replace(/[^a-z0-9]/gi, '')}-0123456789`
    const otherKey = 'sk-fixture-claude-deepseek-preserved-0123456789'
    const f = fixture({
      version: 1,
      selected: {},
      shellKeys: { codex: { zhipu: zhipuKey }, claude: { deepseek: otherKey } },
      shellModels: { codex: { zhipu: model } }
    })

    expect(validAiAccessState(f.state())).toBe(true)
    await f.service.initialize()
    expect((await f.service.serviceStatus()).routes).toEqual([])
    expect(f.state().shellKeys?.codex?.zhipu).toBe(zhipuKey)
    expect(f.state().shellKeys?.claude?.deepseek).toBe(otherKey)
    expect(f.state().shellModels?.codex?.zhipu).toBe(model)

    await f.service.useProvider('claude', 'deepseek')
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'claude', provider: 'deepseek' }])
    expect(f.state().shellKeys?.codex?.zhipu).toBe(zhipuKey)
    expect(f.state().shellModels?.codex?.zhipu).toBe(model)
  })

  it.each([
    ['codex', 'glm-5.2'], ['codex', 'glm-5.3'], ['codex', 'glm-5.3-flash'],
    ['claude', 'glm-5.2'], ['claude', 'glm-5.3'], ['claude', 'glm-5.3-flash'],
    ['hermes', 'glm-5.2'], ['hermes', 'glm-5.3'], ['hermes', 'glm-5.3-flash']
  ] as const)('历史 Coding Plan %s %s 重启时仅路由归一为 glm-5.3-flash，显式启用才写回', async (shell, model) => {
    const key = `sk-fixture-${shell}-${model.replace(/[^a-z0-9]/gi, '')}-0123456789`
    const f = fixture({ version: 1, selected: { [shell]: 'zhipu' }, shellKeys: { [shell]: { zhipu: key } }, shellModels: { [shell]: { zhipu: model } } })
    const token = 'b'.repeat(64)
    const port = await f.gateway.start(0, token)
    await f.store.write({ ...f.state(), relay: { port, token }, relayShells: [shell] })

    await f.service.initialize()
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === shell)!
    expect(route).toMatchObject({ provider: 'zhipu', model: 'glm-5.3-flash' })
    const suffix = shell === 'codex' ? '/responses' : shell === 'claude' ? '/v1/messages' : '/chat/completions'
    const response = await fetch(`${route.baseUrl}${suffix}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(shell === 'codex' ? { input: [], stream: true } : { messages: [], stream: true })
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('glm-5.3-flash')
    expect(f.state().shellModels?.[shell]?.zhipu).toBe(model)

    await f.service.useProvider(shell, 'zhipu')
    expect(f.state().shellModels?.[shell]?.zhipu).toBe('glm-5.3-flash')
  })

  it('已移除的历史 DeepSeek 模型保留状态与其他壳 Key，重启路由回退当前默认，下一次启用才写回', async () => {
    const deepseekKey = 'sk-fixture-codex-legacy-deepseek-0123456789'
    const otherKey = 'sk-fixture-hermes-moonshot-preserved-0123456789'
    const f = fixture({
      version: 1,
      selected: { codex: 'deepseek' },
      shellKeys: { codex: { deepseek: deepseekKey }, hermes: { moonshot: otherKey } },
      shellModels: { codex: { deepseek: 'deepseek-v3' } }
    })
    const token = 'c'.repeat(64)
    const port = await f.gateway.start(0, token)
    await f.store.write({ ...f.state(), relay: { port, token }, relayShells: ['codex'] })

    expect(validAiAccessState(f.state())).toBe(true)
    await f.service.initialize()
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    expect(route.model).toBe('deepseek-flash')
    const response = await fetch(`${route.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ input: [], stream: true })
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(JSON.parse(String(f.fetcher.mock.lastCall?.[1]?.body)).model).toBe('deepseek-flash')
    expect(f.state().shellModels?.codex?.deepseek).toBe('deepseek-v3')
    expect(f.state().shellKeys?.hermes?.moonshot).toBe(otherKey)

    await f.service.useProvider('codex', 'deepseek')
    expect(f.state().shellModels?.codex?.deepseek).toBe('deepseek-flash')
    expect(f.state().shellKeys?.hermes?.moonshot).toBe(otherKey)
  })

  it('历史 Claude Kimi Open Platform 方括号模型只归一到同一产品', async () => {
    const key = 'sk-fixture-moonshot-claude-legacy-0123456789'
    const f = fixture({ version: 1, selected: { claude: 'moonshot' }, shellKeys: { claude: { moonshot: key } }, shellModels: { claude: { moonshot: 'kimi-k3[1m]' } } })
    const token = 'd'.repeat(64)
    const port = await f.gateway.start(0, token)
    await f.store.write({ ...f.state(), relay: { port, token }, relayShells: ['claude'] })

    expect(validAiAccessState(f.state())).toBe(true)
    await f.service.initialize()
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'claude', provider: 'moonshot', model: 'kimi-k3' }])
    await f.service.useProvider('claude', 'moonshot')
    expect(f.state().shellModels?.claude?.moonshot).toBe('kimi-k3')
    expect(f.state().shellKeys?.claude?.kimi).toBeUndefined()
  })
  it('验证通过的 Key 更换不会断掉本机路由；旧地址不会偷偷切换服务商', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const address = (await f.service.serviceStatus()).routes[0].baseUrl
    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-kimi-0123456789')
    await f.service.useProvider('codex','kimi')
    const old = await fetch(`${address}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: '{}' })
    expect(old.status).toBe(409)
    // Active route replacement is itself a probe-and-switch transaction, never a blind route swap.
    await f.service.saveProviderKey('codex', 'kimi', 'sk-fixture-new-kimi-0123456789')
    const routes = (await f.service.serviceStatus()).routes
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ shell: 'codex', provider: 'kimi' })
    const live = await fetch(`${routes[0].baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: '{}' })
    expect(live.status).toBe(200); await live.text()
    expect((f.fetcher.mock.lastCall![1]?.headers as Record<string, string>).authorization).toBe('Bearer sk-fixture-new-kimi-0123456789')
  })
  it('当前路由的替换 Key 上游 401 时，旧 Key 和客户正在使用的路由保持可用', async () => {
    const oldKey = 'sk-fixture-old-live-key-0123456789'
    const rejectedKey = 'sk-fixture-rejected-live-key-0123456789'
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', oldKey)
    await f.service.useProvider('codex', 'deepseek')
    const route = (await f.service.serviceStatus()).routes.find(item => item.shell === 'codex')!
    f.fetcher.mockImplementation(async (url, init) => {
      if (new Headers(init?.headers).get('authorization') === `Bearer ${rejectedKey}`) {
        return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 })
      }
      return reply(String(url).endsWith('/responses') ? 'codex' : String(url).endsWith('/messages') ? 'claude' : 'hermes', JSON.parse(String(init?.body)).stream === true)
    })

    const status = await f.service.saveProviderKey('codex', 'deepseek', rejectedKey)

    expect(status.attempt).toMatchObject({ shell: 'codex', provider: 'deepseek', ok: false, code: 'key_rejected' })
    expect(f.state().shellKeys?.codex?.deepseek).toBe(oldKey)
    expect((await f.service.serviceStatus()).routes).toMatchObject([{ shell: 'codex', provider: 'deepseek' }])
    const live = await fetch(`${route.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${f.state().relay!.token}` }, body: JSON.stringify({ input: [], stream: true })
    })
    expect(live.status).toBe(200)
    await live.text()
    expect(new Headers(f.fetcher.mock.lastCall?.[1]?.headers).get('authorization')).toBe(`Bearer ${oldKey}`)
  })
  it('配置成功后状态保存失败，必须回滚壳配置并保留原路由', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    await f.service.saveProviderKey('codex', 'kimi','sk-fixture-kimi-0123456789')
    const rollback = vi.fn(async () => undefined)
    f.adapters[0].captureConnection.mockResolvedValueOnce(rollback)
    const persist = f.store.write
    const write = vi.spyOn(f.store,'write').mockImplementation(async next => {
      if (next.selected.codex === 'kimi') throw new Error('disk full')
      await persist(next)
    })
    const result = await f.service.useProvider('codex','kimi')
    expect(result.attempt).toMatchObject({ ok: false, code: 'configuration_failed' })
    expect(rollback).toHaveBeenCalledOnce()
    expect(f.state().selected.codex).toBe('deepseek')
    expect((await f.service.serviceStatus()).routes[0].provider).toBe('deepseek')
    write.mockRestore()
  })
  it('配置写不进去时，attempt 带上目录、属主和能照做的一句话，⛔ 只回一句 configuration_failed（纪律 2）', async () => {
    const f = fixture()
    await f.service.saveProviderKey('claude', 'deepseek', 'sk-fixture-deepseek-0123456789')
    const home = await mkdtemp(join(tmpdir(), 'laixin-write-fault-'))
    const target = join(home, 'settings.json')
    f.adapters[1].applyConnection.mockRejectedValueOnce(new Error('AI_ACCESS_CONFIG_FILE_INVALID', {
      cause: Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: 'EACCES', path: target })
    }))
    try {
      const result = await f.service.useProvider('claude', 'deepseek')
      expect(result.attempt).toMatchObject({ ok: false, code: 'configuration_failed' })
      expect(result.attempt?.notice).toContain(home)
      expect(result.attempt?.notice).toContain('属主')
      expect(result.attempt?.notice).toContain('chown')
      expect(result.attempt?.notice).not.toContain('sk-fixture-deepseek')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('配置文件是软链时，attempt 说清是软链、真身在哪、让客户自己决定（纪律 2）', async () => {
    const f = fixture()
    await f.service.saveProviderKey('claude', 'deepseek', 'sk-fixture-deepseek-0123456789')
    const claude = f.adapters[1] as AiAccessAdapter
    claude.configurationTargetStatus = vi.fn(async () => ({
      shell: 'claude' as const, scope: 'unknown' as const, override: 'unknown' as const, writable: false,
      reason: 'symlinked-configuration' as const,
      symlink: { path: '/customer/.claude/settings.json', target: '/customer/dotfiles/settings.json' }
    }))
    const result = await f.service.useProvider('claude', 'deepseek')
    expect(result.attempt).toMatchObject({ ok: false, code: 'configuration_failed' })
    expect(result.attempt?.notice).toContain('软链')
    expect(result.attempt?.notice).toContain('/customer/dotfiles/settings.json')
    expect(result.attempt?.notice).toContain('同一个文件')
  })
  it('恢复官方后状态保存失败，也要恢复原 API 配置', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    const rollback = vi.fn(async () => undefined)
    f.adapters[0].captureConnection.mockResolvedValueOnce(rollback)
    const persist = f.store.write
    vi.spyOn(f.store,'write').mockImplementation(async next => {
      if (next.selected.codex === 'official') throw new Error('disk full')
      await persist(next)
    })
    await expect(f.service.useOfficial('codex')).rejects.toThrow('AI_ACCESS_APPLY_FAILED')
    expect(rollback).toHaveBeenCalledOnce()
    expect(f.state().selected.codex).toBe('deepseek')
  })
  it('配置提交与回滚均失败后，重启仍隔离故障壳；修复其他壳不会清除阻断', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    await f.service.saveProviderKey('codex', 'kimi','sk-fixture-kimi-0123456789')
    f.adapters[0].captureConnection.mockResolvedValueOnce(vi.fn(async () => { throw new Error('rollback disk failure') }))
    const persist = f.store.write
    const writer = vi.spyOn(f.store,'write').mockImplementation(async next => {
      if (next.selected.codex === 'kimi') throw new Error('disk full')
      await persist(next)
    })
    expect((await f.service.useProvider('codex','kimi')).attempt).toMatchObject({ ok: false, code: 'configuration_rollback_failed' })
    writer.mockRestore()
    await f.service.stop()
    const restored = new AiAccessService(f.store, f.adapters, new AiGateway({ fetch: f.fetcher }))
    services.push(restored)
    await restored.initialize()
    expect(await restored.serviceStatus()).toMatchObject({ routes: [], startupError: 'configuration_interrupted' })
    await restored.saveProviderKey('claude', 'deepseek', 'sk-fixture-claude-0123456789')
    await restored.useProvider('claude', 'deepseek')
    expect((await restored.serviceStatus()).routes.map(r => r.shell)).toEqual(['claude'])
    expect((await restored.serviceStatus()).startupError).toBeUndefined()
    await restored.useProvider('codex', 'deepseek')
    expect((await restored.serviceStatus()).routes.map(r => r.shell)).toEqual(['codex','claude'])
    expect((await restored.serviceStatus()).startupError).toBeUndefined()
  })
  it('写前中断标记不能保存时，不触碰壳配置', async () => {
    const f = fixture()
    await f.service.saveProviderKey('codex', 'deepseek', 'sk-fixture-deepseek-0123456789')
    await f.service.useProvider('codex', 'deepseek')
    f.adapters[0].applyConnection.mockClear()
    vi.spyOn(f.store,'write').mockRejectedValueOnce(new Error('disk full'))
    expect((await f.service.useProvider('codex', 'deepseek')).attempt).toMatchObject({ ok: false, code: 'configuration_failed' })
    expect(f.adapters[0].applyConnection).not.toHaveBeenCalled()
    expect((await f.service.serviceStatus()).routes[0].provider).toBe('deepseek')
  })
})
