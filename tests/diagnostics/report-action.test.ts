// 主进程这一侧的整条路：客户按下按钮 → 读本机文件 → 打包 → 发 → 发不出去落本机文件。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTempDir, removeTempDir } from '../tunnel/helpers'
import { credentialFindings } from '../../app/main/diagnostics/report-redact'
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
  writeFileSync(join(tunnelDataDir, 'state.json'), JSON.stringify({
    state: 'error', code: 'TUNNEL_VERIFY_FAILED', message: '复验未通过', sessionToken,
    intentToken: randomBytes(32).toString('base64url'), bridgePort: 18_081, updatedAt: Date.now()
  }))
  return { root, userDataPath, tunnelDataDir, sessionToken }
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
  expect(readFileSync(reported.filePath, 'utf8')).not.toContain(sessionToken)
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
