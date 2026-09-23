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
    'aiaccess.serviceStatus': () => wrapped({ running: true, baseUrl: 'http://127.0.0.1:47000', requests: [],
      usage: [{ shell: 'hermes', provider: 'deepseek', tested: null, configured: null, observedClientCall, configuration }] }),
    'aiaccess.providerConfiguration': () => wrapped({ endpoint: 'https://api.deepseek.com/' }),
    'aiaccess.providerBalance': () => wrapped({ provider: 'deepseek', supported: false }),
    'desktop.status': () => wrapped({})
  }
  for (const [name, handler] of Object.entries(actions)) registry.handlers.set(name, handler)
  const submitted = vi.fn(async () => ({ receipt: 'LX-ABCD-1234', uploaded: true, message: '已上报' }))
  registerActions(registry as unknown as BridgeRegistry, {
    now: () => checkedAt + 1_000,
    createId: () => 'DG-SAME123',
    recentFaults: async () => faults,
    recipesVersion: () => 7,
    installStatus: () => ({ phase: 'idle' }),
    copyText: clipboardWriteText,
    submitReport: submitted
  })

  const run = JSON.parse(((await registry.execute('diagnostics.run', { software: 'hermes' })) as { snapshot: string }).snapshot) as
    { id: string; software: string; text: string; network: NetworkDiagnosticReport }
  expect(run).toMatchObject({ id: 'DG-SAME123', software: 'hermes', network })
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
  expect(networkRun).toHaveBeenCalledTimes(1)

  configuration = 'modified-externally'
  const staleCopy = JSON.parse(((await registry.execute('diagnostics.copy', { id: run.id })) as { snapshot: string }).snapshot) as { copied: boolean; stale: boolean }
  const staleReport = JSON.parse(((await registry.execute('diagnostics.report', { id: run.id })) as { snapshot: string }).snapshot) as { uploaded: boolean; stale: boolean }
  expect(staleCopy).toMatchObject({ copied: false, stale: true })
  expect(staleReport).toMatchObject({ uploaded: false, stale: true })
  expect(submitted).toHaveBeenCalledTimes(1)
  expect(networkRun).toHaveBeenCalledTimes(1)
})
