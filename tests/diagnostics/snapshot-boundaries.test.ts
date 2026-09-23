import { expect, it, vi } from 'vitest'
import type { NetworkDiagnosticReport } from '../../app/network-diagnostics-types'
import type { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import type { ActionDefinition } from '../../app/main/bridge/action-registry'
import type { FaultRecord } from '../../app/shared/fault-log-types'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/dg02-boundary-user', getVersion: () => '0.5.14' },
  clipboard: { writeText: vi.fn() },
  session: { fromPartition: vi.fn(), defaultSession: { resolveProxy: async () => 'DIRECT' } }
}))

Object.assign(globalThis, { __TOOLBOX_ACCOUNT_ORIGIN__: '' })

const { registerActions } = await import('../../app/main/actions/diagnostics')
const { buildReportBody } = await import('../../app/main/diagnostics/report-bundle')
const { parseDiagnosticRunSnapshot } = await import('../../app/renderer/src/diagnostic-session')

const checkedAt = 1_800_000_000_000
const report: NetworkDiagnosticReport = {
  software: 'codex', checkedAt, validUntil: checkedAt + 600_000,
  target: { label: 'Codex 官方', route: 'tunnel' },
  conclusion: {
    status: 'clear', scope: 'none', ruleId: 'DG01_NO_BLOCKER_FOUND', title: '本次未发现明确阻断', summary: '目标本次有响应。',
    nextStep: '回到 Codex 重试。', evidence: [{ checkId: 'service', code: 'AI_DIAG_SERVICE_REACHABLE', statement: '目标有响应。' }]
  },
  checks: [
    { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
    { id: 'tunnel', label: '通道出口', state: 'passed', code: 'AI_DIAG_TUNNEL_VERIFIED', message: '通道最近已校验。' },
    { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。' },
    { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_MANUAL', message: '账号未验证。' },
    { id: 'application', label: '应用接入', state: 'not-checked', code: 'AI_DIAG_APPLICATION_UNCONFIRMED', message: '应用未验证。' }
  ]
}

const wrapped = (value: unknown) => ({ snapshot: JSON.stringify(value) })

class FakeRegistry {
  readonly handlers = new Map<string, (params?: unknown) => unknown | Promise<unknown>>()
  registerAction(action: ActionDefinition): void { this.handlers.set(action.name, action.handler) }
  async execute(name: string, params?: unknown): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`missing action ${name}`)
    return handler(params)
  }
}

function fixture(options: { readonly faultCount?: number; readonly repair?: boolean; readonly faultsReadable?: boolean;
  readonly defaultReport?: boolean } = {}) {
  let clock = checkedAt
  let renew = false
  let readCount = 0
  const delayedReads = new Set<number>()
  const renewedReads = new Set<number>()
  const faults: FaultRecord[] = Array.from({ length: options.faultCount ?? 0 }, (_, index) => ({
    at: new Date(checkedAt - index * 1_000).toISOString(), version: '0.5.14', shell: 'codex',
    code: 'network_error', action: 'retest', outcome: 'still_failing'
  }))
  const repair = options.repair
    ? { running: false, phase: 'finished', outcome: 'recovered', code: 'NETWORK_RECOVERED',
        startedAt: new Date(checkedAt - 5_000).toISOString(), finishedAt: new Date(checkedAt - 1_000).toISOString(), message: '' }
    : { running: false, phase: 'idle', outcome: 'idle', code: '', message: '' }
  const registry = new FakeRegistry()
  const actions: Record<string, (params?: unknown) => unknown> = {
    'app.info': () => ({ version: '0.5.14', platform: 'darwin', architecture: 'arm64', packaged: true }),
    'account.supportContext': () => ({}),
    'tunnel.status': () => ({ state: '已连', lastVerifiedAt: new Date(renew ? clock : checkedAt - 89_000).toISOString(),
      configVersion: '7', nodeLabel: 'test', unrestored: '', componentMissing: '' }),
    'tunnel.repairStatus': () => repair,
    'networkdiagnostics.run': () => wrapped(report),
    'shells.inventory': () => wrapped([]),
    'aiaccess.status': () => wrapped({ shells: { codex: { selected: 'official' } } }),
    'aiaccess.serviceStatus': () => wrapped({ running: false, usage: [] }),
    'desktop.status': () => wrapped({})
  }
  for (const [name, handler] of Object.entries(actions)) registry.handlers.set(name, handler)
  const copy = vi.fn()
  const submitted = vi.fn(async () => ({ receipt: 'LX-TEST-ONLY', uploaded: true, message: 'test only' }))
  registerActions(registry as unknown as BridgeRegistry, {
    now: () => clock,
    createId: () => 'DG-ABCDEF-123456',
    recentFaults: async () => {
      readCount += 1
      if (delayedReads.has(readCount)) clock += 2_000
      if (renewedReads.has(readCount)) renew = true
      if (options.faultsReadable === false) throw new Error('FAULTS_UNREADABLE')
      return faults
    },
    recordNetworkFault: async () => undefined,
    recipesVersion: () => 7,
    installStatus: () => ({ phase: 'idle' }),
    copyText: copy,
    ...(options.defaultReport ? {} : { submitReport: submitted })
  })
  return {
    registry,
    copy,
    submitted,
    delayRead: (number: number) => delayedReads.add(number),
    delayAndRenewRead: (number: number) => { delayedReads.add(number); renewedReads.add(number) }
  }
}

async function run(f: ReturnType<typeof fixture>) {
  return JSON.parse(((await f.registry.execute('diagnostics.run', { software: 'codex' })) as { snapshot: string }).snapshot) as Record<string, unknown>
}

it('通道记录从 89 秒跨到 91 秒时，复制必须使旧证据失效', async () => {
  const f = fixture()
  const snapshot = await run(f)
  f.delayRead(3)
  const copied = JSON.parse(((await f.registry.execute('diagnostics.copy', { id: snapshot.id })) as { snapshot: string }).snapshot)
  expect(copied).toMatchObject({ copied: false, stale: true })
  expect(f.copy).not.toHaveBeenCalled()
})

it('首次诊断的最终上下文采集跨过通道有效期时不生成可用快照', async () => {
  const f = fixture()
  f.delayRead(2)
  await expect(f.registry.execute('diagnostics.run', { software: 'codex' })).rejects.toThrow('DIAGNOSTIC_CONTEXT_CHANGED')
})

it('上报补充采集后的最终校验跨过通道有效期时不发送旧证据', async () => {
  const f = fixture({ defaultReport: true })
  const snapshot = await run(f)
  f.delayRead(4)
  const result = JSON.parse(((await f.registry.execute('diagnostics.report', { id: snapshot.id })) as { snapshot: string }).snapshot)
  expect(result).toMatchObject({ uploaded: false, stale: true })
  expect(f.submitted).not.toHaveBeenCalled()
})

it('采集结束前写入了新鲜续验记录时，最终读数允许继续使用', async () => {
  const f = fixture()
  const snapshot = await run(f)
  f.delayAndRenewRead(3)
  const copied = JSON.parse(((await f.registry.execute('diagnostics.copy', { id: snapshot.id })) as { snapshot: string }).snapshot)
  expect(copied).toMatchObject({ copied: true, stale: false })
  expect(f.copy).toHaveBeenCalledTimes(1)
})

it('20 条历史加一次最近修复只保留最近 20 条，界面、复制和上报使用同一列表', async () => {
  const f = fixture({ faultCount: 20, repair: true })
  const raw = ((await f.registry.execute('diagnostics.run', { software: 'codex' })) as { snapshot: string }).snapshot
  const snapshot = parseDiagnosticRunSnapshot(raw)
  expect(snapshot.attempts).toHaveLength(20)
  expect(snapshot.attemptsTotal).toBe(21)
  expect(snapshot.attempts.some((attempt) => attempt.action === '检测并修复连接')).toBe(true)
  expect(snapshot.text).toContain('共读取到 21 条')
  expect(snapshot.text).toContain('只保留最近 20 条')

  const body = buildReportBody({ diagnosis: {
    id: snapshot.id, report: snapshot.network, attempts: snapshot.attempts,
    attemptsTotal: snapshot.attemptsTotal, attemptsComplete: snapshot.attemptsComplete
  } })
  const uploaded = (body.diagnosis as { attempts: unknown[]; attemptsTotal: number })
  expect(uploaded.attempts).toEqual(snapshot.attempts)
  expect(uploaded.attemptsTotal).toBe(snapshot.attemptsTotal)
})

it('0 条、20 条和读取不完整的边界都如实记录', async () => {
  const empty = parseDiagnosticRunSnapshot(JSON.stringify(await run(fixture())))
  expect(empty).toMatchObject({ attempts: [], attemptsTotal: 0, attemptsComplete: true })
  expect(empty.text).toContain('没有记录到已执行的处理动作或复验结果')

  const full = parseDiagnosticRunSnapshot(JSON.stringify(await run(fixture({ faultCount: 20 }))))
  expect(full).toMatchObject({ attemptsTotal: 20, attemptsComplete: true })
  expect(full.attempts).toHaveLength(20)
  expect(full.text).not.toContain('只保留最近')

  const incomplete = parseDiagnosticRunSnapshot(JSON.stringify(await run(fixture({ repair: true, faultsReadable: false }))))
  expect(incomplete).toMatchObject({ attemptsTotal: 1, attemptsComplete: false })
  expect(incomplete.attempts).toHaveLength(1)
  expect(incomplete.text).toContain('已试动作或复验记录未能完整读取')
  expect(incomplete.text).not.toContain('没有记录到已执行的处理动作或复验结果')
})
