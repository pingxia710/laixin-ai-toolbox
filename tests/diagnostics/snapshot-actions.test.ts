import { expect, it, vi } from 'vitest'
import type { NetworkDiagnosticReport } from '../../app/network-diagnostics-types'
import type { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import type { ActionDefinition } from '../../app/main/bridge/action-registry'
import type { FaultRecord } from '../../app/shared/fault-log-types'

const clipboardWriteText = vi.fn()
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/dg02-unused', getVersion: () => '0.5.14' },
  clipboard: { writeText: clipboardWriteText },
  session: { fromPartition: vi.fn(), defaultSession: { resolveProxy: async () => 'DIRECT' } }
}))

const { registerActions } = await import('../../app/main/actions/diagnostics')

const checkedAt = 1_800_000_000_000
const network: NetworkDiagnosticReport = {
  software: 'hermes', checkedAt, validUntil: checkedAt + 10 * 60_000,
  target: { label: 'DeepSeek API', route: 'direct' },
  conclusion: {
    status: 'clear', scope: 'none', ruleId: 'DG01_NO_BLOCKER_FOUND', title: '本次未发现明确阻断', summary: '目标本次有响应。',
    nextStep: '回到 Hermes 重试原操作。', evidence: [{ checkId: 'service', code: 'AI_DIAG_SERVICE_REACHABLE', statement: '目标有响应。' }]
  },
  checks: [
    { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
    { id: 'tunnel', label: '通道出口', state: 'not-checked', code: 'AI_DIAG_DIRECT_SERVICE', message: '不需要通道。' },
    { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。' },
    { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_PROVIDER', message: '未验证账号。' },
    { id: 'application', label: '应用接入', state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED', message: '观察到调用。' }
  ]
}

const wrapped = (value: unknown) => ({ snapshot: JSON.stringify(value) })
class FakeRegistry {
  readonly handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  registerAction(action: ActionDefinition): void { this.handlers.set(action.name, action.handler) }
  async execute(name: string, params?: unknown): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`missing action ${name}`)
    return handler(params)
  }
}

it('运行、复制、上报都绑定同一软件和同一快照；复制或上报不会重新诊断', async () => {
  const registry = new FakeRegistry()
  const networkRun = vi.fn((params: unknown) => { void params; return wrapped(network) })
  let observedClientCall: string | null = null
  let configuration = 'ok'
  const faults: FaultRecord[] = [{ at: '2027-01-15T08:00:01.000Z', version: '0.5.14', shell: 'hermes', provider: 'deepseek',
    code: 'network_error', action: 'retest', outcome: 'still_failing' }]
  const actions: Record<string, (params: unknown) => unknown> = {
    'app.info': () => ({ version: '0.5.14', platform: 'darwin', architecture: 'arm64', packaged: true }),
    'tunnel.status': () => ({ state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }),
    'tunnel.repairStatus': () => ({ running: false, phase: 'idle', outcome: 'idle', code: '', message: '' }),
    'networkdiagnostics.run': (params) => networkRun(params),
    'shells.inventory': () => wrapped([]),
    'aiaccess.status': () => wrapped({ shells: { hermes: { selected: 'deepseek', providerKeys: { deepseek: true } } } }),
    'aiaccess.verifyConfiguration': () => wrapped({ hermes: configuration }),
    'aiaccess.serviceStatus': () => wrapped({ running: true, baseUrl: 'http://127.0.0.1:47000', requests: [],
      usage: [{ shell: 'hermes', provider: 'deepseek', tested: null, configured: null, observedClientCall, configuration }] }),
    'aiaccess.providerConfiguration': () => wrapped({ endpoint: 'https://api.deepseek.com/' }),
    'aiaccess.providerBalance': () => wrapped({ provider: 'deepseek', supported: false }),
    'desktop.status': () => wrapped({})
  }
  for (const [name, handler] of Object.entries(actions)) registry.handlers.set(name, handler)
  const submitted = vi.fn(async () => ({ receipt: 'LX-ABCD-1234', uploaded: true, message: '已上报' }))
  const localEgress = { platform: 'windows' as const, sampledAt: checkedAt + 900,
    interface: 'none' as const, ipv4DefaultRoute: 'absent' as const, ipv6DefaultRoute: 'absent' as const }
  const collectLocalEgress = vi.fn(async () => localEgress)
  registerActions(registry as unknown as BridgeRegistry, {
    now: () => checkedAt + 1_000,
    createId: () => 'DG-SAME123',
    recentFaults: async () => faults,
    recipesVersion: () => 7,
    installStatus: () => ({ phase: 'idle' }),
    copyText: clipboardWriteText,
    collectLocalEgress,
    submitReport: submitted
  })

  const run = JSON.parse(((await registry.execute('diagnostics.run', { software: 'hermes' })) as { snapshot: string }).snapshot) as
    { id: string; software: string; text: string; network: NetworkDiagnosticReport; localEgress: typeof localEgress }
  expect(run).toMatchObject({ id: 'DG-SAME123', software: 'hermes', network })
  expect(run.localEgress).toEqual(localEgress)
  expect(run.text).toContain('本机出站路径')
  expect(run.text).not.toContain('本机未发现可用出站路径') // 固定 204 已通过，不能和它矛盾地下断网结论。
  expect(run.text).toContain('问题软件：Hermes')
  expect(networkRun).toHaveBeenCalledTimes(1)
  expect(networkRun).toHaveBeenCalledWith({ software: 'hermes' })

  // 正常请求只会更新观察时间，不改变配置，不应误伤旧快照。
  observedClientCall = new Date(checkedAt + 500).toISOString()
  const copied = JSON.parse(((await registry.execute('diagnostics.copy', { id: run.id })) as { snapshot: string }).snapshot) as { copied: boolean }
  expect(copied.copied).toBe(true)
  expect(clipboardWriteText).toHaveBeenCalledWith(run.text)
  const reported = JSON.parse(((await registry.execute('diagnostics.report', { id: run.id })) as { snapshot: string }).snapshot) as { uploaded: boolean }
  expect(reported.uploaded).toBe(true)
  expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, report: network }), faults)
  expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ localEgress }), faults)
  expect(collectLocalEgress).toHaveBeenCalledTimes(1)
  expect(networkRun).toHaveBeenCalledTimes(1)

  configuration = 'modified-externally'
  const staleCopy = JSON.parse(((await registry.execute('diagnostics.copy', { id: run.id })) as { snapshot: string }).snapshot) as { copied: boolean; stale: boolean }
  const staleReport = JSON.parse(((await registry.execute('diagnostics.report', { id: run.id })) as { snapshot: string }).snapshot) as { uploaded: boolean; stale: boolean }
  expect(staleCopy).toMatchObject({ copied: false, stale: true })
  expect(staleReport).toMatchObject({ uploaded: false, stale: true })
  expect(submitted).toHaveBeenCalledTimes(1)
  expect(networkRun).toHaveBeenCalledTimes(1)
})

it('路径上下文持续读不到时，已明确标为无法核对的矩阵仍能上屏和复制', async () => {
  const unknown: NetworkDiagnosticReport = {
    ...network,
    conclusion: {
      status: 'unknown', scope: 'diagnostic-context', ruleId: 'DG01_CONTEXT_UNREADABLE', title: '本次路径对照无法核对',
      summary: '这次没有完整读到系统代理或来信通道入口。', nextStep: '保持当前网络状态不变，重新检查。',
      evidence: [{ checkId: 'service', code: 'AI_DIAG_PATH_CONTEXT_UNKNOWN', statement: '路径对照前后未能完整读到入口。' }]
    },
    checks: network.checks.map((check) => check.id === 'service'
      ? { ...check, state: 'unknown', code: 'AI_DIAG_PATH_CONTEXT_UNKNOWN', message: '路径对照前后未能完整读到入口。' }
      : check),
    pathMatrix: {
      checkedAt, valid: false,
      entries: [
        { path: 'direct', state: 'failed', message: '本路径未完成。' },
        { path: 'existing-proxy', state: 'unavailable', message: '本路径未执行。' },
        { path: 'laixin-tunnel', state: 'unavailable', message: '本路径未执行。' }
      ]
    }
  }
  const registry = new FakeRegistry()
  const actions: Record<string, (params: unknown) => unknown> = {
    'app.info': () => ({ version: '0.5.20', platform: 'darwin', architecture: 'arm64', packaged: true }),
    'tunnel.status': () => ({ state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }),
    'tunnel.repairStatus': () => ({ running: false, phase: 'idle', outcome: 'idle', code: '', message: '' }),
    'networkdiagnostics.run': () => wrapped(unknown),
    'shells.inventory': () => wrapped([]),
    'aiaccess.status': () => wrapped({ shells: { hermes: { selected: 'deepseek', providerKeys: { deepseek: true } } } }),
    'aiaccess.verifyConfiguration': () => wrapped({ hermes: 'ok' }),
    'aiaccess.serviceStatus': () => wrapped({ running: true, requests: [], usage: [] }),
    'aiaccess.providerConfiguration': () => wrapped({ endpoint: 'https://api.deepseek.com/' }),
    'aiaccess.providerBalance': () => wrapped({ provider: 'deepseek', supported: false }),
    'desktop.status': () => wrapped({})
  }
  for (const [name, handler] of Object.entries(actions)) registry.handlers.set(name, handler)
  registerActions(registry as unknown as BridgeRegistry, {
    now: () => checkedAt + 1_000,
    createId: () => 'DG-UNKNOWN-PATH',
    recentFaults: async () => [],
    recordNetworkFault: async () => undefined,
    recipesVersion: () => 7,
    installStatus: () => ({ phase: 'idle' }),
    copyText: clipboardWriteText,
    collectLocalEgress: async () => ({ platform: 'other', sampledAt: checkedAt + 900,
      interface: 'unknown', ipv4DefaultRoute: 'unknown', ipv6DefaultRoute: 'unknown' }),
    pathContext: async () => { throw new Error('private unreadable detail') }
  })

  const snapshot = JSON.parse(((await registry.execute('diagnostics.run', { software: 'hermes' })) as { snapshot: string }).snapshot) as
    { id: string; text: string; network: NetworkDiagnosticReport }
  expect(snapshot.network.conclusion.ruleId).toBe('DG01_CONTEXT_UNREADABLE')
  expect(snapshot.text).toContain('本次路径对照无法核对')
  expect(snapshot.text).not.toContain('private unreadable detail')
  const copied = JSON.parse(((await registry.execute('diagnostics.copy', { id: snapshot.id })) as { snapshot: string }).snapshot)
  expect(copied).toMatchObject({ copied: true, stale: false })
})

it('支持包中段读数并行拉取：总耗时≈最慢一项，且仍夹在两次 captureContext 之间', async () => {
  vi.useFakeTimers()
  try {
    const calls: string[] = []
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const registry = new FakeRegistry()
    const actions: Record<string, (params?: unknown) => unknown> = {
      'app.info': async () => { calls.push('app.info'); await delay(30); return { version: '0.5.14', platform: 'darwin', architecture: 'arm64', packaged: true } },
      'tunnel.status': () => { calls.push('tunnel.status'); return { state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' } },
      'tunnel.repairStatus': () => { calls.push('tunnel.repairStatus'); return { running: false, phase: 'idle', outcome: 'idle', code: '', message: '' } },
      'networkdiagnostics.run': () => { calls.push('networkdiagnostics.run'); return wrapped(network) },
      'shells.inventory': async () => { calls.push('shells.inventory'); await delay(30); return wrapped([]) },
      'aiaccess.status': () => { calls.push('aiaccess.status'); return wrapped({ shells: { hermes: { selected: 'deepseek' }, codex: { selected: 'kimi' } } }) },
      'aiaccess.verifyConfiguration': () => { calls.push('aiaccess.verifyConfiguration'); return wrapped({ hermes: 'ok' }) },
      'aiaccess.serviceStatus': () => { calls.push('aiaccess.serviceStatus'); return wrapped({ running: true, requests: [], usage: [] }) },
      'aiaccess.providerConfiguration': () => { calls.push('aiaccess.providerConfiguration'); return wrapped({ endpoint: 'https://api.deepseek.com/' }) },
      'aiaccess.providerBalance': async (params) => {
        const provider = (params as { provider: string }).provider
        calls.push(`balance:${provider}`); await delay(40); return wrapped({ provider, supported: false })
      },
      'desktop.status': async () => { calls.push('desktop.status'); await delay(30); return wrapped({}) }
    }
    for (const [name, handler] of Object.entries(actions)) registry.handlers.set(name, handler)
    registerActions(registry as unknown as BridgeRegistry, {
      now: () => checkedAt + 1_000,
      createId: () => 'DG-PARALL1',
      recentFaults: async () => [],
      recipesVersion: () => 7,
      installStatus: () => ({ phase: 'idle' }),
      copyText: clipboardWriteText,
      collectLocalEgress: async () => ({ platform: 'windows' as const, sampledAt: checkedAt + 900,
        interface: 'none' as const, ipv4DefaultRoute: 'absent' as const, ipv6DefaultRoute: 'absent' as const })
    })
    const pending = registry.execute('diagnostics.run', { software: 'hermes' })
    let done = false
    const settled = pending.then(() => { done = true }, () => { done = true })
    let elapsed = 0
    while (!done && elapsed < 400) { await vi.advanceTimersByTimeAsync(10); elapsed += 10 }
    await settled
    // 串行中段 = 30+30+30+40+40 = 170；并行后只等最慢的余额 40。
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThanOrEqual(40)
    // 夹逼窗口不变：前次 capture 的读数全部在中段之前，后次 capture 全部在中段之后。
    expect(calls.indexOf('tunnel.status')).toBeLessThan(calls.indexOf('app.info'))
    expect(calls.indexOf('aiaccess.verifyConfiguration')).toBeLessThan(calls.indexOf('app.info'))
    expect(calls.lastIndexOf('aiaccess.verifyConfiguration')).toBeGreaterThan(calls.indexOf('desktop.status'))
    expect(calls.lastIndexOf('tunnel.status')).toBeGreaterThan(calls.indexOf('desktop.status'))
    // 读数一项不少、一项不多：中段 5 项 + 两个不同服务商余额各一次。
    expect(calls.filter((name) => name === 'app.info')).toHaveLength(1)
    expect(calls.filter((name) => name === 'shells.inventory')).toHaveLength(1)
    expect(calls.filter((name) => name === 'desktop.status')).toHaveLength(1)
    expect(calls.filter((name) => name.startsWith('balance:')).sort()).toEqual(['balance:deepseek', 'balance:kimi'])
  } finally {
    vi.useRealTimers()
  }
})
