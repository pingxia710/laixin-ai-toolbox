import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
  closeAllConnections: vi.fn(async (): Promise<void> => undefined), setProxy: vi.fn(async (): Promise<void> => undefined),
  resolveProxy: vi.fn(async () => 'DIRECT'),
  fetch: vi.fn(async () => new Response(null, { status: 200 })), fromPartition: vi.fn(),
  onErrorOccurred: vi.fn(), webRequest: undefined as unknown as { onErrorOccurred: ReturnType<typeof vi.fn> }
}))
fake.webRequest = { onErrorOccurred: fake.onErrorOccurred }
vi.mock('electron', () => ({ session: { fromPartition: fake.fromPartition } }))
import { DiagnosticProbeError, probeDiagnosticUrl, readDiagnosticPathContext } from '../../app/main/network-diagnostics/electron-probe'
import { runNetworkDiagnostics } from '../../app/main/network-diagnostics/service'
import { registerActions } from '../../app/main/actions/network-diagnostics'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { DEFAULT_BRIDGE_PORT, type TunnelService } from '../../app/main/tunnel/tunnel-service'
import { initializeTunnelRuntime } from '../../app/main/tunnel/runtime-owner'
import { parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'

let reused: ReturnType<TunnelService['reusedProxy']>
let tunnelStatusOverride: ReturnType<TunnelService['status']> | undefined
let claimedLaixinEndpoint: string | undefined
let recoveredExistingProxy: string | undefined
let recoveredExistingContext: string
let recoveredExistingEvidenceReadable: boolean
let recoveredExistingEvidenceHook: (() => void) | undefined
let diagnosticErrorListener: ((details: { url: string; error: string }) => void) | undefined
beforeEach(() => {
  reused = undefined
  tunnelStatusOverride = undefined
  claimedLaixinEndpoint = `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`
  recoveredExistingProxy = undefined
  recoveredExistingContext = 'active-path-a'
  recoveredExistingEvidenceReadable = true
  recoveredExistingEvidenceHook = undefined
  diagnosticErrorListener = undefined
  fake.closeAllConnections.mockReset().mockResolvedValue(undefined)
  fake.setProxy.mockReset().mockResolvedValue(undefined)
  fake.fromPartition.mockReset().mockReturnValue(fake)
  fake.fetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }))
  fake.resolveProxy.mockReset().mockResolvedValue('DIRECT')
  fake.onErrorOccurred.mockReset().mockImplementation((_filter, listener?: (details: { url: string; error: string }) => void) => {
    diagnosticErrorListener = listener
  })
  initializeTunnelRuntime(() => ({
    activeBridgePort: () => DEFAULT_BRIDGE_PORT,
    reusedProxy: () => reused,
    diagnosticBridgeEndpoint: () => claimedLaixinEndpoint,
    diagnosticExistingProxy: () => recoveredExistingProxy,
    diagnosticExistingProxyEvidence: () => {
      recoveredExistingEvidenceHook?.()
      return recoveredExistingEvidenceReadable ? ({
        ...(recoveredExistingProxy === undefined ? {} : { proxyUrl: recoveredExistingProxy }),
        pathFingerprint: recoveredExistingContext
      }) : undefined
    },
    status: () => tunnelStatusOverride ?? ({
      state: '已连', pathSource: reused === undefined ? 'laixin' : 'reused', lastVerifiedAt: new Date().toISOString(),
      unrestored: '', componentMissing: ''
    } as ReturnType<TunnelService['status']>)
  }) as TunnelService)
})
afterEach(() => { vi.clearAllMocks() })

it.each([
  [{ kind: 'direct' as const }, { mode: 'direct' }],
  [{ kind: 'http' as const, host: '127.0.0.1', port: 47891 }, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:47891', proxyBypassRules: '<-loopback>' }],
  [{ kind: 'socks' as const, host: '::1', port: 47892 }, { mode: 'fixed_servers', proxyRules: 'socks5://[::1]:47892', proxyBypassRules: '<-loopback>' }]
])('复用通路 %j 时私有探针跟随真实入口', async (path, proxy) => {
  reused = path
  fake.fromPartition.mockReturnValue(fake)
  await probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')
  expect(fake.setProxy).toHaveBeenCalledWith(proxy)
  expect(fake.setProxy).not.toHaveBeenCalledWith(expect.objectContaining({ proxyRules: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}` }))
  expect(fake.fetch).toHaveBeenCalledWith('https://chatgpt.com/', expect.objectContaining({ credentials: 'omit', redirect: 'manual' }))
})

it('复用不可读的 PAC 不回退到不存在的本地入口或系统代理', async () => {
  reused = { kind: 'pac' }
  fake.fromPartition.mockReturnValue(fake)
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')).rejects.toThrow()
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('国内服务不受当前外网复用入口影响，仍使用私有直连', async () => {
  reused = { kind: 'http', host: '127.0.0.1', port: 47891 }
  fake.fromPartition.mockReturnValue(fake)
  await probeDiagnosticUrl('https://api.deepseek.com/', 'direct')
  expect(fake.setProxy).toHaveBeenCalledWith({ mode: 'direct' })
})

it('系统现有代理使用独立 system 会话；没有代理时明确标为路径不可用', async () => {
  fake.fromPartition.mockReturnValue(fake)
  fake.resolveProxy.mockResolvedValueOnce('PROXY proxy.fixture.invalid:7890')

  const result = await probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')

  expect(fake.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^toolbox-network-diagnostic-existing-proxy-\d+$/), { cache: false })
  expect(fake.setProxy).toHaveBeenCalledWith({ mode: 'system' })
  expect(fake.setProxy).toHaveBeenCalledWith({
    mode: 'fixed_servers', proxyRules: 'http://proxy.fixture.invalid:7890', proxyBypassRules: '<-loopback>'
  })
  expect(fake.resolveProxy).toHaveBeenCalledWith('https://chatgpt.com/')
  expect(result).toMatchObject({ status: 200, phase: 'http' })
  expect(JSON.stringify(result)).not.toContain('proxy.fixture.invalid')

  fake.resolveProxy.mockResolvedValueOnce('DIRECT')
  fake.fetch.mockClear()
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('系统代理解析包含 DIRECT 兜底时只探第一条代理，不把回退直连串成代理成功', async () => {
  fake.fromPartition.mockReturnValue(fake)
  fake.resolveProxy.mockResolvedValueOnce('SOCKS5 [::1]:1080; DIRECT')

  await probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')

  expect(fake.setProxy).toHaveBeenLastCalledWith({
    mode: 'fixed_servers', proxyRules: 'socks5://[::1]:1080', proxyBypassRules: '<-loopback>'
  })
})

it('来信通道只在当前运行时确认持有时固定走本地桥', async () => {
  await probeDiagnosticUrl('https://chatgpt.com/', 'laixin-tunnel')

  expect(fake.setProxy).toHaveBeenCalledWith({
    mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`, proxyBypassRules: '<-loopback>'
  })
})

it('复用其他代理或未连接时，不把默认端口上的未知进程冒充来信通道', async () => {
  reused = { kind: 'http', host: '127.0.0.1', port: 47891 }
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'laixin-tunnel')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  tunnelStatusOverride = { state: '未配置', pathSource: '', lastVerifiedAt: '', unrestored: '', componentMissing: '' } as ReturnType<TunnelService['status']>
  reused = undefined
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'laixin-tunnel')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('系统代理已是来信桥时标为重复路径，不冒充另一条现有代理', async () => {
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)

  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  tunnelStatusOverride = {
    state: '异常', pathSource: '', lastVerifiedAt: '', unrestored: '待恢复', componentMissing: ''
  } as ReturnType<TunnelService['status']>
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('来信接管系统代理后，现有代理路径使用同代恢复证据中的接管前候选', async () => {
  recoveredExistingProxy = 'http://proxy.fixture.invalid:7890'
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)

  const result = await probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')

  expect(result).toMatchObject({ status: 200, phase: 'http' })
  expect(fake.setProxy).toHaveBeenLastCalledWith({
    mode: 'fixed_servers', proxyRules: recoveredExistingProxy, proxyBypassRules: '<-loopback>'
  })
  expect(JSON.stringify(result)).not.toContain('proxy.fixture.invalid')
})

it('来信接管后无法证明 macOS 活动服务身份时，现有代理路径保持不可用', async () => {
  recoveredExistingProxy = 'http://inactive-proxy.invalid:8443'
  recoveredExistingEvidenceReadable = false
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)

  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'path-unavailable'
  })
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('现有代理的活动服务读取越过总截止时优先报告超时，不接受迟到的不可用结论', async () => {
  let elapsed = 0
  const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  recoveredExistingEvidenceReadable = false
  recoveredExistingEvidenceHook = () => { elapsed = 5_401 }
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)
  try {
    await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
      name: 'DiagnosticProbeError', kind: 'timeout'
    })
  } finally {
    performanceNow.mockRestore()
  }
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('未连接且没有守护实际端口证据时，不把占用默认口的外部代理误判为来信', async () => {
  claimedLaixinEndpoint = undefined
  tunnelStatusOverride = {
    state: '未配置', pathSource: '', lastVerifiedAt: '', unrestored: '', componentMissing: ''
  } as ReturnType<TunnelService['status']>
  fake.resolveProxy.mockResolvedValueOnce(`PROXY 127.0.0.1:${DEFAULT_BRIDGE_PORT}`)

  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).resolves.toMatchObject({ status: 200 })
  expect(fake.setProxy).toHaveBeenLastCalledWith({
    mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`, proxyBypassRules: '<-loopback>'
  })
})

it('当前系统是直连且无来信桥证据时，不用历史恢复候选冒充现有代理', async () => {
  claimedLaixinEndpoint = undefined
  recoveredExistingProxy = 'http://stale.fixture.invalid:7890'
  fake.resolveProxy.mockResolvedValueOnce('DIRECT')

  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    kind: 'path-unavailable'
  })
  expect(fake.fetch).not.toHaveBeenCalled()
})

it('固定目标经私有无凭据会话检查，不使用系统或默认浏览器会话', async () => {
  fake.fromPartition.mockReturnValue(fake)
  await probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')
  expect(fake.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^toolbox-network-diagnostic-tunnel-\d+$/), { cache: false })
  expect(fake.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`, proxyBypassRules: '<-loopback>' })
  expect(fake.fetch).toHaveBeenCalledWith('https://chatgpt.com/', expect.objectContaining({
    method: 'HEAD', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal)
  }))
  expect(fake.closeAllConnections).toHaveBeenCalledTimes(2)
})

it('每次探测使用不复用的会话代次，旧请求晚返回不能改写新一轮', async () => {
  let finish!: (response: Response) => void
  fake.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))

  const first = probeDiagnosticUrl('https://chatgpt.com/', 'direct')
  await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalledTimes(1))
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'direct')).resolves.toMatchObject({ status: 204 })
  const partitions = fake.fromPartition.mock.calls.map(([name]) => name)
  expect(partitions[0]).not.toBe(partitions[1])
  finish(new Response(null, { status: 200 }))
  await expect(first).resolves.toMatchObject({ status: 200 })
})

it('挂起的 Electron 设置操作有整体时限与有界会话池，超时后不再发目标请求', async () => {
  vi.useFakeTimers()
  try {
    const release: Array<() => void> = []
    fake.setProxy.mockImplementation(() => new Promise<void>((resolve) => { release.push(resolve) }))
    const first = probeDiagnosticUrl('https://chatgpt.com/', 'direct')
    const second = probeDiagnosticUrl('https://chatgpt.com/', 'direct')
    const firstResult = expect(first).rejects.toMatchObject<Partial<DiagnosticProbeError>>({ kind: 'timeout' })
    const secondResult = expect(second).rejects.toMatchObject<Partial<DiagnosticProbeError>>({ kind: 'timeout' })
    await expect(probeDiagnosticUrl('https://chatgpt.com/', 'direct')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
      kind: 'path-unavailable'
    })
    await vi.advanceTimersByTimeAsync(5_400)
    await Promise.all([firstResult, secondResult])
    expect(new Set(fake.fromPartition.mock.calls.map(([name]) => name)).size).toBe(2)
    for (const finish of release) finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.fetch).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('临时会话清理失败不覆盖已完成的安全探测结果', async () => {
  fake.closeAllConnections.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private cleanup detail'))
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'direct')).resolves.toMatchObject({ status: 200 })
})

it('路径上下文只返回不可逆指纹，系统代理变化会改变指纹', async () => {
  fake.resolveProxy.mockResolvedValueOnce('PROXY proxy.fixture.invalid:7890')
    .mockResolvedValueOnce('SOCKS5 proxy.fixture.invalid:1080')
  const first = await readDiagnosticPathContext('https://chatgpt.com/')
  const second = await readDiagnosticPathContext('https://chatgpt.com/')
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(second).toMatch(/^[a-f0-9]{64}$/)
  expect(second).not.toBe(first)
  expect(`${first}${second}`).not.toContain('proxy.fixture.invalid')
})

it('macOS 活动服务变化即使接管前代理不可用也会改变路径指纹', async () => {
  const first = await readDiagnosticPathContext('https://chatgpt.com/')
  recoveredExistingContext = 'active-path-b'
  const second = await readDiagnosticPathContext('https://chatgpt.com/')

  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(second).toMatch(/^[a-f0-9]{64}$/)
  expect(second).not.toBe(first)
  expect(`${first}${second}`).not.toContain('active-path')
})

it('macOS 活动服务身份不可证时路径上下文不可读，矩阵必须失效', async () => {
  recoveredExistingEvidenceReadable = false
  await expect(readDiagnosticPathContext('https://chatgpt.com/')).rejects.toThrow('DIAGNOSTIC_PATH_CONTEXT_UNAVAILABLE')

  const now = Date.now()
  const report = await runNetworkDiagnostics('codex', {
    now: () => now,
    status: () => ({
      state: '已连', lastVerifiedAt: new Date(now).toISOString(), configVersion: 'n54-active-service',
      nodeLabel: 'fixture', unrestored: '', componentMissing: ''
    }),
    selection: async () => ({ mode: 'official' }),
    pathContext: readDiagnosticPathContext,
    probe: async (url, route) => {
      if (url.includes('generate_204')) return { status: 204, durationMs: 1 }
      throw new DiagnosticProbeError('unavailable', 2, route === 'existing-proxy' ? 'proxy' : 'connection')
    }
  })

  expect(report.pathMatrix).toMatchObject({ valid: false })
  expect(report.checks.find((check) => check.id === 'service')).toMatchObject({ code: 'AI_DIAG_PATH_CONTEXT_UNKNOWN' })
})

it('活动服务同步读取越过总截止时间时不接受迟到的路径指纹', async () => {
  let elapsed = 0
  const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  recoveredExistingEvidenceHook = () => { elapsed = 5_401 }
  try {
    await expect(readDiagnosticPathContext('https://chatgpt.com/')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
      name: 'DiagnosticProbeError', kind: 'timeout'
    })
  } finally {
    performanceNow.mockRestore()
  }
})

it('Chromium SOCKS 指令按 SOCKSv4 重放，不误改为 SOCKSv5', async () => {
  fake.resolveProxy.mockResolvedValueOnce('SOCKS proxy.fixture.invalid:1080')
  await probeDiagnosticUrl('https://chatgpt.com/', 'existing-proxy')
  expect(fake.setProxy).toHaveBeenLastCalledWith({
    mode: 'fixed_servers', proxyRules: 'socks4://proxy.fixture.invalid:1080', proxyBypassRules: '<-loopback>'
  })
})

it('探测把超时归为固定类别，不把底层错误文字带到诊断层', async () => {
  fake.fromPartition.mockReturnValue(fake)
  fake.fetch.mockRejectedValueOnce(new DOMException('private-detail', 'TimeoutError'))
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'timeout'
  })
})

it.each([
  ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
  ['net::ERR_TUNNEL_CONNECTION_FAILED', 'proxy'],
  ['net::ERR_CONNECTION_REFUSED', 'connection'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls'],
  ['net::ERR_HTTP2_INADEQUATE_TRANSPORT_SECURITY', 'tls'],
  ['net::ERR_HTTP2_PROTOCOL_ERROR', 'http']
] as const)('Chromium 错误 %s 只映射为受控阶段 %s，不外泄原文', async (networkError, phase) => {
  fake.fromPartition.mockReturnValue(fake)
  fake.fetch.mockImplementationOnce(async () => {
    diagnosticErrorListener?.({ url: 'https://chatgpt.com/', error: networkError })
    throw new Error(`private:${networkError}`)
  })

  const failure = await probeDiagnosticUrl('https://chatgpt.com/', 'tunnel').catch((error: DiagnosticProbeError) => error)
  expect(failure).toMatchObject<Partial<DiagnosticProbeError>>({ name: 'DiagnosticProbeError', kind: 'unavailable', phase })
  expect((failure as DiagnosticProbeError).message).not.toContain(networkError)
  expect(fake.onErrorOccurred).toHaveBeenLastCalledWith(null)
})

it('QUIC 通用协议错误可能跨连接与流阶段，证据不足时保持未知', async () => {
  fake.fromPartition.mockReturnValue(fake)
  fake.fetch.mockImplementationOnce(async () => {
    diagnosticErrorListener?.({ url: 'https://chatgpt.com/', error: 'net::ERR_QUIC_PROTOCOL_ERROR' })
    throw new Error('private:net::ERR_QUIC_PROTOCOL_ERROR')
  })

  const failure = await probeDiagnosticUrl('https://chatgpt.com/', 'tunnel').catch((error: DiagnosticProbeError) => error)
  expect(failure).toMatchObject<Partial<DiagnosticProbeError>>({ name: 'DiagnosticProbeError', kind: 'unavailable' })
  expect((failure as DiagnosticProbeError).phase).toBeUndefined()
  expect((failure as DiagnosticProbeError).message).not.toContain('QUIC_PROTOCOL_ERROR')
})

it('任意URL和私有地址在创建会话前拒绝；固定目标允许只读直连对照', async () => {
  for (const url of ['http://127.0.0.1/', 'https://chatgpt.com/?token=private', 'https://evil.invalid/']) {
    await expect(probeDiagnosticUrl(url, 'tunnel')).rejects.toThrow('DIAGNOSTIC_TARGET_INVALID')
  }
  expect(fake.fromPartition).not.toHaveBeenCalled()
  fake.fromPartition.mockReturnValue(fake)
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'direct')).resolves.toMatchObject({ status: 200 })
})

it('桥拒绝额外地址参数，并合并重复点击，不同时切换诊断目标', async () => {
  const registry = new BridgeRegistry()
  let finish!: (value: { status: number, durationMs: number }) => void
  const probe = vi.fn(async () => ({ status: 204, durationMs: 8 }))
    .mockImplementationOnce(() => new Promise<{ status: number, durationMs: number }>((resolve) => { finish = resolve }))
  registerActions(registry, { probe, status: () => ({ state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }) })
  await expect(registry.execute('networkdiagnostics.run', { software: 'codex', url: 'http://localhost/' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  await expect(registry.execute('networkdiagnostics.run', { software: 'unknown' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  const first = registry.execute('networkdiagnostics.run', { software: 'codex' })
  const second = registry.execute('networkdiagnostics.run', { software: 'codex' })
  await expect(registry.execute('networkdiagnostics.run', { software: 'claude' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  finish({ status: 204, durationMs: 8 })
  const results = await Promise.all([first, second])
  expect(results[0]).toEqual(results[1]); expect(probe).toHaveBeenCalledTimes(3)
  const report = parseDiagnosticReport((results[0] as { snapshot: string }).snapshot)
  expect(report.software).toBe('codex')
  expect(() => parseDiagnosticReport(JSON.stringify({ ...report, checks: report.checks.map((check) => ({ ...check, code: 'PRIVATE_VALUE' })) }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
})

it('报障的新探测不复用另一页面尚未结束的同软件检查', async () => {
  const failures: Array<{ action: string; error: unknown }> = []
  const registry = new BridgeRegistry({ diagnostic: (_code, action, error) => failures.push({ action, error }) })
  let finish!: (value: { status: number; durationMs: number }) => void
  let blocked = true
  const probe = vi.fn(() => blocked
    ? new Promise<{ status: number; durationMs: number }>((resolve) => { finish = resolve })
    : Promise.resolve({ status: 204, durationMs: 8 }))
  registerActions(registry, { probe, selection: async () => ({ mode: 'official' }),
    status: () => ({ state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }) })

  const old = registry.execute('networkdiagnostics.run', { software: 'codex' })
  await Promise.resolve()
  await expect(registry.execute('networkdiagnostics.runFresh', { software: 'codex' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  expect(failures).toEqual(expect.arrayContaining([{ action: 'networkdiagnostics.runFresh', error: expect.objectContaining({ message: 'DIAGNOSTIC_BUSY' }) }]))
  expect(probe).toHaveBeenCalledTimes(1)
  blocked = false
  finish({ status: 204, durationMs: 8 })
  await old

  const fresh = await registry.execute('networkdiagnostics.runFresh', { software: 'codex' }) as { snapshot: string }
  expect(parseDiagnosticReport(fresh.snapshot).software).toBe('codex')
  expect(probe).toHaveBeenCalledTimes(6)
})
