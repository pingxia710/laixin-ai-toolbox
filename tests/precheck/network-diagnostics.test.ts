import { describe, expect, it, vi } from 'vitest'
import { diagnosticProbeAllowed, DiagnosticProbeError, resolveDiagnosticTarget, runNetworkDiagnostics, type DiagnosticSelection, type DiagnosticTunnel } from '../../app/main/network-diagnostics/service'

const now = 1_800_000_000_000
const connected: DiagnosticTunnel = { state: '已连', lastVerifiedAt: new Date(now).toISOString(), configVersion: '2', nodeLabel: 'fixture-node', unrestored: '', componentMissing: '' }
const options = (status = connected) => ({ status: () => status, now: () => now, probe: vi.fn(async () => ({ status: 204, durationMs: 47 })) })

describe('AI 打不开的分层检查', () => {
  it('未连接时不试连、不把目标软件失败误报为账号问题', async () => {
    const deps = options({ ...connected, state: '未配置', lastVerifiedAt: '' })
    const report = await runNetworkDiagnostics('codex', deps)
    expect(deps.probe).toHaveBeenCalledTimes(1)
    expect(report.checks.find((check) => check.id === 'service')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_TUNNEL_REQUIRED' })
    expect(report.checks.find((check) => check.id === 'account')?.state).toBe('not-checked')
  })

  it('目标经当前通道检查，网页响应不能变成账号或对话验证通过', async () => {
    const deps = options()
    const report = await runNetworkDiagnostics('codex', deps)
    expect(deps.probe.mock.calls).toEqual([
      ['https://connectivitycheck.platform.hicloud.com/generate_204', 'direct'], ['https://chatgpt.com/', 'tunnel']
    ])
    expect(report.checks.find((check) => check.id === 'service')?.state).toBe('passed')
    expect(report.checks.find((check) => check.id === 'account')?.state).toBe('not-checked')
    expect(report.checks.find((check) => check.id === 'internet')).toMatchObject({ elapsedMs: 47, message: expect.stringContaining('47 ms') })
    expect(report.checks.find((check) => check.id === 'service')).toMatchObject({ elapsedMs: 47, message: expect.stringContaining('47 ms') })
    expect(report.checks.find((check) => check.id === 'application')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_APPLICATION_UNCONFIRMED' })
    expect(report.checks.find((check) => check.id === 'application')?.message).toContain('尚无法确认')
  })

  it.each([401, 403, 429, 503])('HTTP %s 不能显示目标服务正常', async (status) => {
    const report = await runNetworkDiagnostics('codex', { ...options(), probe: vi.fn(async () => ({ status, durationMs: 31 })) })
    expect(report.checks.find((check) => check.id === 'service')?.state).not.toBe('passed')
    expect(JSON.stringify(report)).not.toContain('额度已用完')
  })

  it('断开或配置变化使在途结果失效，不能显示已通过', async () => {
    let current = connected
    const deps = { ...options(), status: () => current, probe: vi.fn(async (_url: string, route: string) => {
      if (route === 'tunnel') current = { ...connected, state: '已停止并恢复原设置' }
      return { status: 200, durationMs: 12 }
    }) }
    const report = await runNetworkDiagnostics('codex', deps)
    expect(report.checks.find((check) => check.id === 'service')).toMatchObject({ state: 'unknown', code: 'AI_DIAG_TUNNEL_CHANGED' })
  })

  it('过期出口读数不充当当前连接，DeepSeek 可独立直连检查', async () => {
    const stale = options({ ...connected, lastVerifiedAt: new Date(now - 300_000).toISOString() })
    expect((await runNetworkDiagnostics('codex', stale)).checks.find((check) => check.id === 'service')?.state).toBe('not-checked')
    const direct = options({ ...connected, state: '未配置', lastVerifiedAt: '' })
    const report = await runNetworkDiagnostics('hermes', direct)
    expect(direct.probe.mock.calls[1]).toEqual(['https://api.deepseek.com/', 'direct'])
    expect(report.checks.find((check) => check.id === 'service')?.state).toBe('passed')
  })

  it('拒绝任意地址和未知软件，异常正文不进入诊断信息', async () => {
    const deps = options()
    await expect(runNetworkDiagnostics('https://secret.invalid/', deps)).rejects.toThrow('DIAGNOSTIC_SOFTWARE_INVALID')
    expect(deps.probe).not.toHaveBeenCalled()
    const report = await runNetworkDiagnostics('codex', { ...deps, probe: async () => { throw new Error('credential=private-fixture') } })
    expect(report.checks.find((check) => check.id === 'internet')?.state).toBe('unknown')
    expect(report.checks.find((check) => check.id === 'service')?.state).toBe('unknown')
    expect(JSON.stringify(report)).not.toContain('private-fixture')
  })

  it('超时、不可达和服务拒绝分别说明原因与耗时，不据此判断应用未接入', async () => {
    const timeout = await runNetworkDiagnostics('codex', {
      ...options(), probe: vi.fn(async (_url: string, route: string) => {
        if (route === 'tunnel') throw new DiagnosticProbeError('timeout', 5_000)
        return { status: 204, durationMs: 22 }
      })
    })
    expect(timeout.checks.find((check) => check.id === 'service')).toMatchObject({
      state: 'unknown', code: 'AI_DIAG_SERVICE_TIMEOUT', elapsedMs: 5_000
    })
    expect(timeout.checks.find((check) => check.id === 'service')?.message).toContain('超时')
    expect(timeout.checks.find((check) => check.id === 'application')?.message).toContain('尚无法确认')

    const refused = await runNetworkDiagnostics('codex', {
      ...options(), probe: vi.fn(async (_url: string, route: string) => route === 'tunnel'
        ? { status: 403, durationMs: 63 }
        : { status: 204, durationMs: 22 })
    })
    expect(refused.checks.find((check) => check.id === 'service')).toMatchObject({
      state: 'attention', code: 'AI_DIAG_SERVICE_RESTRICTED', elapsedMs: 63
    })
    expect(refused.checks.find((check) => check.id === 'service')?.message).toContain('63 ms')
  })
})

describe('按这个软件实际在用的服务检查', () => {
  const withSelection = (selection: DiagnosticSelection, status = connected) => ({ ...options(status), selection: vi.fn(async () => selection) })

  it('Codex 选了 DeepSeek 就检查 DeepSeek，不再去探 chatgpt.com', async () => {
    const deps = withSelection({ mode: 'deepseek' })
    const report = await runNetworkDiagnostics('codex', deps)
    expect(deps.probe.mock.calls).toEqual([
      ['https://connectivitycheck.platform.hicloud.com/generate_204', 'direct'], ['https://api.deepseek.com/', 'direct']
    ])
    expect(JSON.stringify(report)).not.toContain('chatgpt.com')
    expect(report.checks.find((check) => check.id === 'tunnel')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_DIRECT_SERVICE' })
    expect(report.checks.find((check) => check.id === 'tunnel')?.message).toContain('DeepSeek API')
    expect(report.checks.find((check) => check.id === 'account')).toMatchObject({ code: 'AI_DIAG_ACCOUNT_PROVIDER' })
    expect(report.checks.find((check) => check.id === 'account')?.message).toContain('DeepSeek API')
  })

  it('Claude 选了智谱走国内直连，仍然选官方就走通道探官方站点', async () => {
    const zhipu = withSelection({ mode: 'zhipu' })
    await runNetworkDiagnostics('claude', zhipu)
    expect(zhipu.probe.mock.calls[1]).toEqual(['https://open.bigmodel.cn/', 'direct'])
    const official = withSelection({ mode: 'official' })
    const report = await runNetworkDiagnostics('claude', official)
    expect(official.probe.mock.calls[1]).toEqual(['https://api.anthropic.com/', 'tunnel'])
    expect(report.checks.find((check) => check.id === 'account')).toMatchObject({ code: 'AI_DIAG_ACCOUNT_MANUAL' })
  })

  it('Codex 的智谱套餐已验收时按智谱国内直连检查，诊断白名单仍拒绝空地址', async () => {
    const selected = withSelection({ mode: 'zhipu' })

    expect(resolveDiagnosticTarget('codex', { mode: 'zhipu' })).toEqual({ url: 'https://open.bigmodel.cn/', route: 'direct', label: '智谱 GLM Coding Plan' })
    expect(diagnosticProbeAllowed('', 'direct')).toBe(false)
    await runNetworkDiagnostics('codex', selected)
    expect(selected.probe.mock.calls[1]).toEqual(['https://open.bigmodel.cn/', 'direct'])
  })

  it('四类各自判定：本机网络 / 通道 / 目标服务 / 账号，判不出就说未知', async () => {
    const offline = { ...withSelection({ mode: 'deepseek' }), probe: vi.fn(async () => { throw new DiagnosticProbeError('unavailable', 12) }) }
    expect((await runNetworkDiagnostics('hermes', offline)).checks.find((check) => check.id === 'internet')?.state).toBe('unknown')

    const noTunnel = withSelection({ mode: 'official' }, { ...connected, state: '未配置', lastVerifiedAt: '' })
    const tunnelReport = await runNetworkDiagnostics('codex', noTunnel)
    expect(tunnelReport.checks.find((check) => check.id === 'tunnel')?.state).toBe('attention')
    expect(tunnelReport.checks.find((check) => check.id === 'service')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_TUNNEL_REQUIRED' })

    const rejected = { ...withSelection({ mode: 'deepseek' }), probe: vi.fn(async () => ({ status: 401, durationMs: 9 })) }
    expect((await runNetworkDiagnostics('hermes', rejected)).checks.find((check) => check.id === 'service')).toMatchObject({ state: 'attention', code: 'AI_DIAG_SERVICE_AUTH' })

    const unknown = withSelection({ mode: 'unknown' })
    const unknownReport = await runNetworkDiagnostics('codex', unknown)
    expect(unknownReport.checks.find((check) => check.id === 'account')).toMatchObject({ state: 'unknown', code: 'AI_DIAG_ACCOUNT_UNKNOWN' })
    expect(unknown.probe.mock.calls[1]).toEqual(['https://chatgpt.com/', 'tunnel'])
  })

  it('本机 API 服务没在跑就直说本机服务的问题，⛔ 让客户去查服务商', async () => {
    const deps = withSelection({ mode: 'deepseek', routed: true, serviceRunning: false })
    const report = await runNetworkDiagnostics('codex', deps)
    expect(report.checks.find((check) => check.id === 'application')).toMatchObject({ state: 'attention', code: 'AI_DIAG_LOCAL_SERVICE_DOWN' })
    expect(report.checks.find((check) => check.id === 'application')?.message).toContain('重启本机 API 服务')
  })

  it('观察到这个软件自己调用成功过才算「真的在用」', async () => {
    const observed = withSelection({ mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: new Date(now).toISOString() })
    expect((await runNetworkDiagnostics('codex', observed)).checks.find((check) => check.id === 'application')).toMatchObject({ state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED' })
    const silent = withSelection({ mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: null })
    expect((await runNetworkDiagnostics('codex', silent)).checks.find((check) => check.id === 'application')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_APPLICATION_UNCONFIRMED' })
  })

  it('读不出当前选择时按官方站点检查，报告照样完整，异常正文不外泄', async () => {
    const deps = { ...options(), selection: vi.fn(async () => { throw new Error('selection=private-fixture') }) }
    const report = await runNetworkDiagnostics('codex', deps)
    expect(report.checks).toHaveLength(5)
    expect(deps.probe.mock.calls[1]).toEqual(['https://chatgpt.com/', 'tunnel'])
    expect(JSON.stringify(report)).not.toContain('private-fixture')
  })

  it('配方把地址换到别处就按通道走，探测地址仍然只允许清单内的目标', () => {
    expect(resolveDiagnosticTarget('codex', { mode: 'deepseek', endpoint: 'https://relay.example.com/v1/responses' }))
      .toMatchObject({ url: 'https://relay.example.com/', route: 'tunnel' })
    expect(resolveDiagnosticTarget('codex', { mode: 'kimi' })).toMatchObject({ url: 'https://api.kimi.com/', route: 'direct' })
    expect(diagnosticProbeAllowed('https://api.deepseek.com/', 'direct')).toBe(true)
    expect(diagnosticProbeAllowed('https://api.deepseek.com/', 'tunnel')).toBe(false)
    // 诊断执行器会直接请求这个值；白名单只能接受规范 origin，不能把同域任意路径或查询串拿去探测。
    expect(diagnosticProbeAllowed('https://api.deepseek.com/v1/models?token=private-fixture', 'direct')).toBe(false)
    expect(diagnosticProbeAllowed('https://evil.example/', 'direct')).toBe(false)
    expect(diagnosticProbeAllowed('https://relay.example.com/', 'tunnel', ['https://relay.example.com/v1/responses'])).toBe(true)
  })
})
