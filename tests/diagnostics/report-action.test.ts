// 主进程这一侧的整条路：客户按下按钮 → 读本机文件 → 打包 → 发 → 发不出去落本机文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'
import { appendSettingEntry, markEntry } from '../../sidecar/mac/ledger.mjs'
import { credentialFindings } from '../../app/main/diagnostics/report-redact'
import { nodeReportFiles } from '../../app/main/diagnostics/report-collect'
import { REPORT_RECEIPT_PATTERN } from '../../app/report-types'
import type { ReportTransport } from '../../app/main/diagnostics/report-upload'
import type { SupportDiagnosis } from '../../app/main/diagnostics/support-snapshot'
import type { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import type { ActionDefinition } from '../../app/main/bridge/action-registry'

const roots: string[] = []
Object.assign(globalThis, { __TOOLBOX_ACCOUNT_ORIGIN__: '' })
vi.mock('electron', () => ({
  app: { getPath: () => join(roots[0] ?? '/tmp', 'userData'), getVersion: () => '0.5.0' },
  clipboard: { writeText: vi.fn() },
  session: { fromPartition: vi.fn(), defaultSession: { resolveProxy: async () => 'PROXY 127.0.0.1:18081' } }
}))
const { registerActions, runOneClickReport } = await import('../../app/main/actions/diagnostics')

afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })

function machine() {
  const root = makeTempDir('report-action-')
  roots.push(root)
  const userDataPath = join(root, 'userData')
  const tunnelDataDir = join(userDataPath, 'tunnel')
  mkdirSync(tunnelDataDir, { recursive: true })
  const sessionToken = `sess-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  const intentToken = randomBytes(32).toString('base64url')
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({
    state: 'error', code: 'TUNNEL_VERIFY_FAILED', message: '复验未通过', sessionToken,
    intentToken, bridgePort: 18_081, updatedAt: Date.now()
  }))
  return { root, userDataPath, tunnelDataDir, sessionToken, intentToken }
}

const execute = async (name: string): Promise<unknown> => {
  if (name === 'app.info') return { version: '0.5.0', platform: 'darwin', architecture: 'arm64', packaged: true }
  if (name === 'tunnel.status') return { state: '未连', message: '通道已断开', exitIp: '' }
  if (name === 'tunnel.repairStatus') return { running: false, outcome: 'unresolved', code: 'NETWORK_REPAIR_UNRESOLVED', phase: 'finished', message: '未确认恢复' }
  if (name === 'account.supportContext') return { customerId: `acct_${randomBytes(16).toString('hex')}`, deviceId: `device_${randomBytes(16).toString('hex')}` }
  throw new Error(`unexpected ${name}`)
}

it('没有软件诊断编号时，网络卡仍能直接复制当前信息并生成离线回执', async () => {
  const { userDataPath, sessionToken } = machine()
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const registry = {
    registerAction: (action: ActionDefinition) => handlers.set(action.name, action.handler),
    execute: (name: string, params?: unknown) => handlers.get(name)?.(params) ?? execute(name)
  } as unknown as BridgeRegistry
  const copyText = vi.fn()
  registerActions(registry, { recentFaults: async () => [], copyText, recipesVersion: () => 7, installStatus: () => ({ phase: 'idle' }) })

  const copied = JSON.parse(((await registry.execute('diagnostics.copy', { id: '' })) as { snapshot: string }).snapshot) as { copied: boolean }
  expect(copied.copied).toBe(true)
  expect(copyText).toHaveBeenCalledOnce()
  expect(copyText.mock.calls[0][0]).toContain('【AI网络】')
  expect(copyText.mock.calls[0][0]).toContain('未选择具体软件')

  const reported = JSON.parse(((await registry.execute('diagnostics.report', { id: '' })) as { snapshot: string }).snapshot) as
    { receipt: string; uploaded: boolean; filePath: string }
  expect(reported.uploaded).toBe(false)
  expect(REPORT_RECEIPT_PATTERN.test(reported.receipt)).toBe(true)
  expect(reported.filePath).toBe(join(userDataPath, 'reports', `${reported.receipt}.json`))
  expect(existsSync(reported.filePath)).toBe(true)
  const saved = readFileSync(reported.filePath, 'utf8')
  expect(saved).not.toContain(sessionToken)
  const body = (JSON.parse(saved) as { body: { diagnosis: Record<string, unknown>; notes: string[] } }).body
  expect(body.diagnosis).toMatchObject({ available: false, status: '未完成' })
  expect(body.notes).toContain('本次诊断未完成；仅采集当前连接状态与日志。')
})

it('诊断未完成时仍保存当次状态与日志，包内注明客户所选软件', async () => {
  machine()
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const registry = {
    registerAction: (action: ActionDefinition) => handlers.set(action.name, action.handler),
    execute: (name: string, params?: unknown) => handlers.get(name)?.(params) ?? execute(name)
  } as unknown as BridgeRegistry
  registerActions(registry, { recentFaults: async () => [], recipesVersion: () => 7, installStatus: () => ({ phase: 'idle' }) })

  const reported = JSON.parse(((await registry.execute('diagnostics.reportIncomplete', { software: 'claude' })) as { snapshot: string }).snapshot) as
    { receipt: string; uploaded: boolean; filePath: string }
  expect(reported.uploaded).toBe(false)
  const body = (JSON.parse(readFileSync(reported.filePath, 'utf8')) as { body: {
    diagnosis: Record<string, unknown>; network: { status: Record<string, unknown> }; notes: string[]
  } }).body
  expect(body.diagnosis).toEqual({ available: false, status: '未完成', software: 'claude' })
  expect(body.network.status).toMatchObject({ state: '未连', message: '通道已断开' })
  expect(body.notes).toContain('本次诊断未完成；仅采集当前连接状态与日志。')
  expect(JSON.stringify(body)).toContain('TUNNEL_VERIFY_FAILED')
})

function transport(result: { status: number; body: string } | Error): { client: ReportTransport; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    client: {
      resolveProxy: async () => 'DIRECT',
      post: async (_url, _route, payload) => { sent.push(payload); if (result instanceof Error) throw result; return result }
    }
  }
}

const diagnosis: SupportDiagnosis = {
  id: 'DG-OFFLINE-1',
  report: {
    software: 'codex', checkedAt: 1_800_000_000_000, validUntil: 1_800_000_600_000,
    target: { label: 'Codex 官方', route: 'tunnel' },
    conclusion: { status: 'unknown', scope: 'application', ruleId: 'DG01_APPLICATION_UNCONFIRMED', title: '只能定位到应用验证这一步',
      summary: '目标有响应，但应用结果未知。', nextStep: '回到 Codex 重试一次，再重新检查。',
      evidence: [{ checkId: 'application', code: 'AI_DIAG_APPLICATION_UNCONFIRMED', statement: '尚未观察到 Codex 请求。' }] },
    checks: [
      { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
      { id: 'tunnel', label: '通道出口', state: 'passed', code: 'AI_DIAG_TUNNEL_VERIFIED', message: '通道已验证。' },
      { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。' },
      { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_MANUAL', message: '未验证账号。' },
      { id: 'application', label: '应用接入', state: 'not-checked', code: 'AI_DIAG_APPLICATION_UNCONFIRMED', message: '尚未观察到 Codex 请求。' }
    ]
  },
  attempts: [],
  attemptsTotal: 0,
  attemptsComplete: true
}

it('点一下就打包送出去：回执号可念，包里没有 state.json 里的令牌', async () => {
  const { userDataPath, tunnelDataDir, sessionToken } = machine()
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })
  const result = await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir, bridgePort: 18_081 })
  expect(result.uploaded).toBe(true)
  expect(REPORT_RECEIPT_PATTERN.test(result.receipt)).toBe(true)
  expect(result.message).toContain(result.receipt)
  expect(sent).toHaveLength(1)
  expect(sent[0]).not.toContain(sessionToken)
  expect(credentialFindings(sent[0])).toHaveLength(0)
  // 客服要判断的东西在：当时的状态与错误码
  expect(sent[0]).toContain('NETWORK_REPAIR_UNRESOLVED')
  expect(sent[0]).toContain('TUNNEL_VERIFY_FAILED')
})

it('停止未确认时支持包含本轮故障码，并标明 state.json 旧码只是原始读数', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })
  const faults = [{ at: '2027-01-15T08:00:01.000Z', version: '0.5.20', network: 'AI_DIAG_STOP_UNCONFIRMED' }]
  const result = await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, bridgePort: 18_081, faults })
  expect(result.uploaded).toBe(true)
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[]; daemonState: { code: string } } }).body
  expect(body.errorCodes).toContain('AI_DIAG_STOP_UNCONFIRMED')
  expect(body.errorCodes).not.toContain('TUNNEL_VERIFY_FAILED')
  expect(body.daemonState.code).toBe('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).toContain('原始读数')
  expect(body.notes.join('')).toContain('不能单独作为本次根因')
})

it('state 与当前 intent 属同一轮时，state 错误码才列入本轮错误', async () => {
  const { userDataPath, tunnelDataDir, intentToken, sessionToken } = machine()
  const seatAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, runId: 'current-run', at: seatAt }))
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'current-run', intentToken, updatedAt: seatAt + 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected', sessionToken: intentToken }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, bridgePort: 18_081,
    faults: [{ at: '2027-01-15T08:00:01.000Z', version: '0.5.20', network: 'AI_DIAG_STOP_UNCONFIRMED' }] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[]; daemonState: { code: string } } }).body
  expect(body.errorCodes).toContain('TUNNEL_VERIFY_FAILED')
  expect(body.errorCodes).toContain('AI_DIAG_STOP_UNCONFIRMED')
  expect(body.daemonState.code).toBe('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).not.toContain('未经本轮核对')
  expect(sent[0]).not.toContain(intentToken)
  expect(sent[0]).not.toContain(sessionToken)
  expect(credentialFindings(sent[0])).toHaveLength(0)
})

it('非常驻守护无席位锁时，用主进程本轮 spawn runId 确认真错误码', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const intentAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'current-spawn', intentToken, updatedAt: intentAt + 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: intentToken, updatedAt: intentAt }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    runtimeProvenance: () => ({ spawnRunId: 'current-spawn', restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).toContain('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).not.toContain('未经本轮核对')
  expect(sent[0]).not.toContain('runtimeProvenance')
  expect(sent[0]).not.toContain(intentToken)
})

it('非常驻守护换 runId 但沿用旧意图时，旧错误码不得冒充本轮', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const intentAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'old-spawn', intentToken, updatedAt: intentAt + 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: intentToken, updatedAt: intentAt }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    runtimeProvenance: () => ({ spawnRunId: 'new-spawn', restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).toContain('未经本轮核对')
  expect(sent[0]).not.toContain('new-spawn')
})

it('本进程曾 spawn 后常驻席位接管，常驻写出的真实错误仍可归本轮', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const seatAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'resident-run', intentToken, updatedAt: seatAt + 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected',
    sessionToken: intentToken, updatedAt: seatAt - 1 }))
  writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, runId: 'resident-run', at: seatAt }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    runtimeProvenance: () => ({ spawnRunId: 'previous-spawn', lastSpawnAt: seatAt - 2,
      residentOnlyRunning: true, restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[];
    daemonState: { runId: string } } }).body
  expect(body.errorCodes).toContain('TUNNEL_VERIFY_FAILED')
  expect(body.daemonState.runId).toBe('resident-run')
  expect(body.notes.join('')).not.toContain('未经本轮核对')
  expect(sent[0]).not.toContain('previous-spawn')
})

it('本进程旧 spawn 错误尚在盘上，新常驻已接管席位时不能认旧码', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const seatAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'previous-spawn', intentToken, updatedAt: seatAt - 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected',
    sessionToken: intentToken, updatedAt: seatAt - 2 }))
  writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, runId: 'resident-run', at: seatAt }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    runtimeProvenance: () => ({ spawnRunId: 'previous-spawn', lastSpawnAt: seatAt - 2,
      residentOnlyRunning: true, restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[];
    daemonState: { runId: string } } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_VERIFY_FAILED')
  expect(body.daemonState.runId).toBe('previous-spawn')
  expect(body.notes.join('')).toContain('未经本轮核对')
})

it('本轮普通守护仍在运行时，旧常驻锁不能压掉当前 spawn 真错误', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const spawnedAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'current-spawn', intentToken, updatedAt: spawnedAt + 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected',
    sessionToken: intentToken, updatedAt: spawnedAt - 1 }))
  writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, runId: 'older-resident', at: spawnedAt - 2 }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    runtimeProvenance: () => ({ spawnRunId: 'current-spawn', lastSpawnAt: spawnedAt,
      residentOnlyRunning: false, restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).toContain('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).not.toContain('未经本轮核对')
})

it.each([
  { name: '新席位已接管', seat: 'new-run' },
  { name: '同名席位比旧状态晚取得', seat: 'old-run' },
  { name: '旧席位锁缺失', seat: '' },
  { name: '旧席位锁已失效', seat: 'dead-run' }
])('$name 且意图令牌未变时，旧 run 的错误不能归成本轮', async ({ seat }) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const seatAt = Date.now() - 1_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED',
    runId: 'old-run', intentToken, updatedAt: seat === 'new-run' ? seatAt + 1 : seatAt - 1 }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: intentToken,
    updatedAt: seatAt - 2 }))
  if (seat) writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({
    pid: seat === 'dead-run' ? 2 ** 22 + 17 : process.pid, runId: seat, at: seatAt
  }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[];
    daemonState: { code: string } } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_VERIFY_FAILED')
  expect(body.daemonState.code).toBe('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).toContain('未经本轮核对')
  expect(sent[0]).not.toContain(intentToken)
})

it.each([
  'TUNNEL_RESTORE_INCOMPLETE', 'TUNNEL_WRITE_RIGHT_HELD', 'TUNNEL_RESTORE_TIMEOUT', 'TUNNEL_RESTORE_SPAWN_FAILED'
])('无令牌的一次性恢复失败 %s 若仍有未恢复设置，应列出当前恢复错误', async (code) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now()
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error',
    code, updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, updatedAt: failedAt - 1 }))
  appendSettingEntry(tunnelDataDir, { service: 'Wi-Fi', item: 'ProxyServer', originalValue: null,
    writtenValue: { enabled: true }, sessionToken: intentToken, time: failedAt - 2 })
  const withUnrestored = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state: '异常', unrestored: 'Wi-Fi/ProxyServer:未恢复:失败' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute: withUnrestored, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, runtimeProvenance: () => ({ spawnRunId: 'previous-spawn',
      lastSpawnAt: failedAt - 2, restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).toContain(code)
  expect(body.notes.join('')).not.toContain('未经本轮核对')
  expect(sent[0]).not.toContain(intentToken)
  expect(sent[0]).not.toContain('previous-spawn')
})

it.each([
  { code: 'TUNNEL_PROXY_INSPECTION_FAILED', settled: false },
  { code: 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN', settled: true },
  { code: 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN', settled: false, missingLedger: true }
])('N-44 代理检查失败 $code 可在空/已结账账本留下最近一次恢复码', async ({ code, settled, missingLedger }) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now()
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code, updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, updatedAt: failedAt - 1 }))
  if (settled) {
    const entry = appendSettingEntry(tunnelDataDir, { service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { enabled: true }, sessionToken: intentToken, time: failedAt - 2 })
    markEntry(tunnelDataDir, entry.id, { status: 'restored' })
  } else if (!missingLedger) writeFileSync(join(tunnelDataDir, 'ledger.json'), '[]')
  const withStatus = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state: '异常', unrestored: '' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute: withStatus, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, runtimeProvenance: () => ({ spawnRunId: 'previous-spawn',
      lastSpawnAt: failedAt - 2, restoring: false }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).toContain(code)
  expect(body.notes.join('')).toContain('最近一次代理检查失败')
  expect(body.notes.join('')).toContain('当前代理归属仍需复验')
  expect(body.notes.join('')).not.toContain('当前未恢复设置相符')
  expect(sent[0]).not.toContain(intentToken)
  expect(sent[0]).not.toContain('previous-spawn')
})

it.each([
  { name: '新意图晚于旧代理检查', newerIntent: true },
  { name: '同意图恢复正在重试', restoring: true },
  { name: '现任守护已有席位', liveSeat: true },
  { name: '常驻守护接管但席位暂读不到', residentOwner: true },
  { name: '新普通守护已启动但尚未回写', spawnAfter: 1 },
  { name: '新守护与旧状态同毫秒无法排序', spawnAfter: 0 },
  { name: '账本损坏不可确认', corruptLedger: true }
])('N-44 $name 时，旧代理检查码只保留原始读数', async ({ newerIntent, restoring, liveSeat,
  corruptLedger, spawnAfter, residentOwner }) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now() - 10_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error',
    code: 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN', updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, updatedAt: failedAt + (newerIntent ? 1 : -1) }))
  writeFileSync(join(tunnelDataDir, 'ledger.json'), corruptLedger ? '{损坏' : '[]')
  if (liveSeat) writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({
    pid: process.pid, runId: 'new-run', at: failedAt + 1
  }))
  const withStatus = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state: '异常', unrestored: '' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute: withStatus, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, runtimeProvenance: () => ({ restoring: restoring === true,
      residentOnlyRunning: residentOwner === true,
      ...(spawnAfter === undefined ? {} : { spawnRunId: 'new-spawn', lastSpawnAt: failedAt + spawnAfter }) }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[];
    daemonState: { code: string } } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_PROXY_OWNERSHIP_UNKNOWN')
  expect(body.daemonState.code).toBe('TUNNEL_PROXY_OWNERSHIP_UNKNOWN')
  expect(body.notes.join('')).toContain('未经本轮核对')
})

it('N-44 账本读取失败不冒充明确缺失，代理检查码保留为未核对原始读数', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now()
  const ledgerPath = join(tunnelDataDir, 'ledger.json')
  writeFileSync(ledgerPath, '[]')
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error',
    code: 'TUNNEL_PROXY_OWNERSHIP_UNKNOWN', updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, updatedAt: failedAt - 1 }))
  const originalRead = nodeReportFiles.readText.bind(nodeReportFiles)
  const reader = vi.spyOn(nodeReportFiles, 'readText').mockImplementation((path, root) =>
    path === ledgerPath ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : originalRead(path, root))
  const withStatus = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state: '异常', unrestored: '' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  try {
    await runOneClickReport({ execute: withStatus, transport: client, origin: 'https://laixin.example/',
      userDataPath, tunnelDataDir, runtimeProvenance: () => ({ restoring: false }), faults: [] })
  } finally { reader.mockRestore() }
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_PROXY_OWNERSHIP_UNKNOWN')
  expect(body.notes.join('')).toContain('设置账本 ledger.json 读取失败：EACCES')
  expect(body.notes.join('')).toContain('未经本轮核对')
  expect(readFileSync(ledgerPath, 'utf8')).toBe('[]')
})

it.each([
  { name: '未恢复设置只是旧状态快照', withEntry: false, nextIntent: false, liveSeat: false, state: '异常' },
  { name: '设置账本已恢复，仅状态读数陈旧', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', settledLedger: true },
  { name: '仅可选终端设置未恢复', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', optionalOnly: true },
  { name: '状态报告的是账本故障而非未恢复明细', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', unrestoredText: '账本损坏' },
  { name: '本轮意图晚于旧恢复失败', withEntry: true, nextIntent: true, liveSeat: false, state: '异常' },
  { name: '当前意图缺时间戳', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', missingTime: true },
  { name: '同意图恢复重试正在运行', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', restoring: true },
  { name: '常驻守护接管但席位暂读不到', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', residentOwner: true },
  { name: '新普通守护已启动', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', spawnAfter: 1 },
  { name: '新守护与旧恢复同毫秒', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', spawnAfter: 0 },
  { name: '错误码并非一次性恢复来源', withEntry: true, nextIntent: false, liveSeat: false, state: '异常', code: 'TUNNEL_VERIFY_FAILED' },
  { name: '现任守护已接管', withEntry: true, nextIntent: false, liveSeat: true, state: '异常' },
  { name: '恢复正在进行', withEntry: true, nextIntent: false, liveSeat: false, state: '断开中' }
])('$name：无令牌的旧恢复错误不当作本轮错误', async ({ withEntry, nextIntent, liveSeat, state,
  missingTime, code, settledLedger, optionalOnly, unrestoredText, restoring, spawnAfter, residentOwner }) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now() - 10_000
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error',
    code: code ?? 'TUNNEL_RESTORE_INCOMPLETE', updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, ...(missingTime ? {} : { updatedAt: failedAt + (nextIntent ? 1 : -1) }) }))
  if (withEntry) {
    const entry = appendSettingEntry(tunnelDataDir, { service: optionalOnly ? 'TerminalEnvironment' : 'Wi-Fi',
      item: 'ProxyServer', originalValue: null, writtenValue: { enabled: true }, sessionToken: intentToken, time: failedAt - 2 })
    if (settledLedger) markEntry(tunnelDataDir, entry.id, { status: 'restored' })
  }
  if (liveSeat) writeFileSync(join(tunnelDataDir, 'daemon.lock'), JSON.stringify({
    pid: process.pid, runId: 'new-run', at: failedAt + 1
  }))
  const withStatus = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state, unrestored: unrestoredText ?? 'Wi-Fi/ProxyServer:未恢复:失败' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute: withStatus, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, runtimeProvenance: () => ({ restoring: restoring === true,
      residentOnlyRunning: residentOwner === true,
      ...(spawnAfter === undefined ? {} : { spawnRunId: 'new-spawn', lastSpawnAt: failedAt + spawnAfter }) }), faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).not.toContain(code ?? 'TUNNEL_RESTORE_INCOMPLETE')
  expect(body.notes.join('')).toContain('未经本轮核对')
})

it('报告归因新增判据遇损坏账本只读，不触发账本隔离', async () => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const failedAt = Date.now()
  const ledgerPath = join(tunnelDataDir, 'ledger.json')
  writeFileSync(ledgerPath, '{损坏的账本')
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error',
    code: 'TUNNEL_RESTORE_INCOMPLETE', updatedAt: failedAt }))
  writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected',
    sessionToken: intentToken, updatedAt: failedAt - 1 }))
  const withStatus = async (name: string): Promise<unknown> => name === 'tunnel.status'
    ? { state: '异常', unrestored: '旧状态快照：未恢复' }
    : execute(name)
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute: withStatus, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, faults: [] })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[] } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_RESTORE_INCOMPLETE')
  expect(body.notes.join('')).toContain('设置账本 ledger.json')
  expect(readFileSync(ledgerPath, 'utf8')).toBe('{损坏的账本')
  expect(readdirSync(tunnelDataDir).filter((name) => name.startsWith('ledger.json.bad-'))).toHaveLength(0)
})

it.each([
  { name: '不同轮且无近期故障记录', currentIntent: true, stateIntentToken: true, faults: [] },
  { name: '不同轮且最近 20 条故障已无本次记录', currentIntent: true, stateIntentToken: true,
    faults: Array.from({ length: 20 }, (_, index) => ({ at: '2027-01-15T08:00:01.000Z', version: '0.5.20', network: `OTHER_${index}` })) },
  { name: '缺当前意图', currentIntent: false, stateIntentToken: true, faults: [] },
  { name: '缺 state 意图令牌', currentIntent: true, stateIntentToken: false, faults: [] }
])('$name：旧 state 错误码保留为原始读数，但不当作本轮根因', async ({ currentIntent, stateIntentToken, faults }) => {
  const { userDataPath, tunnelDataDir, intentToken } = machine()
  const nextToken = randomBytes(32).toString('base64url')
  if (currentIntent) writeFileSync(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected', sessionToken: nextToken }))
  if (!stateIntentToken) writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({ state: 'error', code: 'TUNNEL_VERIFY_FAILED' }))
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })

  await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/',
    userDataPath, tunnelDataDir, bridgePort: 18_081, faults })
  const body = (JSON.parse(sent[0]) as { body: { errorCodes: string[]; notes: string[]; daemonState: { code: string } } }).body
  expect(body.errorCodes).not.toContain('TUNNEL_VERIFY_FAILED')
  expect(body.daemonState.code).toBe('TUNNEL_VERIFY_FAILED')
  expect(body.notes.join('')).toContain('未经本轮核对')
  expect(sent[0]).not.toContain(intentToken)
  expect(sent[0]).not.toContain(nextToken)
  expect(credentialFindings(sent[0])).toHaveLength(0)
})

it('发不出去：落本机文件、回执号照给，⛔ 报成功', async () => {
  const { userDataPath, tunnelDataDir, sessionToken } = machine()
  const { client, sent } = transport(new Error('ECONNREFUSED'))
  const result = await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    bridgePort: 18_081, diagnosis, faults: [], now: () => new Date('2027-01-15T08:00:05.000Z') })
  expect(result.uploaded).toBe(false)
  expect(result.filePath).toBe(join(userDataPath, 'reports', `${result.receipt}.json`))
  const saved = readFileSync(result.filePath!, 'utf8')
  expect(saved).toBe(sent[0])
  expect((JSON.parse(saved) as { receipt: string }).receipt).toBe(result.receipt)
  expect(saved).toContain('DG-OFFLINE-1')
  expect(saved).toContain('2027-01-15T08:00:05.000Z')
  expect(saved).not.toContain(sessionToken)
  expect(result.message).toContain('已存在本机')
})

it('补充读数采集后旧诊断已失效：发送和离线保存都不能继续', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const { client, sent } = transport({ status: 200, body: '{"receipt":"ok","filtered":0}' })
  const options = {
    execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir,
    bridgePort: 18_081, diagnosis, faults: [], validateDiagnosis: async () => false
  }

  await expect(runOneClickReport(options)).rejects.toThrow('DIAGNOSTIC_CONTEXT_CHANGED')
  expect(sent).toHaveLength(0)
  expect(existsSync(join(userDataPath, 'reports'))).toBe(false)
})

it('后台地址还没配时不假装上报，直接给本机文件', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const { client, sent } = transport({ status: 200, body: '{}' })
  const result = await runOneClickReport({ execute, transport: client, origin: '', userDataPath, tunnelDataDir })
  expect(result.uploaded).toBe(false)
  expect(sent).toHaveLength(0)
  expect(result.filePath).toContain(result.receipt)
})

it('某项读数取不到也照样出包，并在包里写明是哪一项', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const { client, sent } = transport({ status: 200, body: '{}' })
  const partial = async (name: string): Promise<unknown> => {
    if (name === 'tunnel.status') throw new Error('TUNNEL_RUNTIME_UNINITIALIZED')
    return execute(name)
  }
  const result = await runOneClickReport({ execute: partial, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir })
  expect(result.uploaded).toBe(true)
  expect(sent[0]).toContain('tunnel.status 读不到')
})

it('回执号撞上了就换一个再发，⛔ 让客户白点一次', async () => {
  const { userDataPath, tunnelDataDir } = machine()
  const sent: string[] = []
  let first = true
  const client: ReportTransport = {
    resolveProxy: async () => 'DIRECT',
    post: async (_url, _route, payload) => {
      sent.push(payload)
      if (first) { first = false; return { status: 409, body: '{"code":"REPORT_RECEIPT_TAKEN"}' } }
      return { status: 200, body: '{"filtered":0}' }
    }
  }
  const result = await runOneClickReport({ execute, transport: client, origin: 'https://laixin.example/', userDataPath, tunnelDataDir })
  expect(result.uploaded).toBe(true)
  expect(sent).toHaveLength(2)
  const receipts = sent.map((payload) => (JSON.parse(payload) as { receipt: string }).receipt)
  expect(receipts[0]).not.toBe(receipts[1])
  // 客户看到的、和第二次真发出去的，必须是同一个号
  expect(result.receipt).toBe(receipts[1])
})
