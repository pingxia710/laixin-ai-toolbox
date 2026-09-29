import { afterEach, describe, expect, it, vi } from 'vitest'
import { networkDiagnosticReportTtlMs, type NetworkDiagnosticReport } from '../../app/network-diagnostics-types'
import { unknownLocalEgressEvidence } from '../../app/shared/local-egress-evidence'
import { diagnosticConclusionView, page, parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'

const checkedAt = 1_800_000_000_000
const report: NetworkDiagnosticReport = {
  software: 'codex',
  checkedAt,
  validUntil: checkedAt + networkDiagnosticReportTtlMs,
  target: { label: 'DeepSeek API', route: 'direct' },
  conclusion: {
    status: 'blocked', scope: 'local-service', ruleId: 'DG01_LOCAL_SERVICE_DOWN', title: '卡在本机 API 服务',
    summary: 'Codex 已指向工具箱的本机 API 服务，但该服务当前没有运行。',
    nextStep: '到“模型 API”页重启本机 API 服务，再重新检查。',
    evidence: [{ checkId: 'application', code: 'AI_DIAG_LOCAL_SERVICE_DOWN', statement: '本机 API 服务没有运行。' }]
  },
  checks: [
    { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
    { id: 'tunnel', label: '通道出口', state: 'not-checked', code: 'AI_DIAG_DIRECT_SERVICE', message: '国内模型不需要接通 AI 网络。' },
    { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。', phase: 'http' },
    { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_PROVIDER', message: '本次没有验证账号。' },
    { id: 'application', label: '应用接入', state: 'attention', code: 'AI_DIAG_LOCAL_SERVICE_DOWN', message: '本机 API 服务没有运行。' }
  ]
}

describe('DG-01 诊断结论上屏合同', () => {
  it('解析同次报告，并把结论、依据、目标、检查时间和一个下一步交给页面', () => {
    const parsed = parseDiagnosticReport(JSON.stringify(report))
    const view = diagnosticConclusionView(parsed, checkedAt + 1_000)

    expect(view).toMatchObject({ stale: false, label: '已定位', tone: 'warning', title: '卡在本机 API 服务', target: 'DeepSeek API' })
    expect(view.evidence).toEqual(['本机 API 服务没有运行。'])
    expect(view.nextStep).toBe('到“模型 API”页重启本机 API 服务，再重新检查。')
    expect(view.checkedAt).toBe(checkedAt)
  })

  it('依据必须逐项对应五项检查，规则状态与范围也不能伪造', () => {
    expect(() => parseDiagnosticReport(JSON.stringify({ ...report, conclusion: {
      ...report.conclusion,
      evidence: [{ ...report.conclusion.evidence[0], statement: '伪造的成功依据。' }]
    } }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
    expect(() => parseDiagnosticReport(JSON.stringify({ ...report, conclusion: {
      ...report.conclusion, status: 'clear'
    } }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
    expect(() => parseDiagnosticReport(JSON.stringify({ ...report,
      checks: report.checks.map(check => check.id === 'service' ? { ...check, phase: 'private-stage' } : check)
    }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
  })

  it('路径矩阵只接受同一检查时间和固定三路径顺序', () => {
    const pathMatrix = {
      checkedAt, valid: true,
      entries: [
        { path: 'direct', state: 'reachable', phase: 'http', elapsedMs: 11, message: '已到达目标的 HTTP 响应（耗时 11 ms）。' },
        { path: 'existing-proxy', state: 'failed', phase: 'tls', elapsedMs: 17, message: '在 TLS 安全连接阶段失败（耗时 17 ms）。' },
        { path: 'laixin-tunnel', state: 'failed', phase: 'connection', elapsedMs: 23, message: '在网络连接阶段失败（耗时 23 ms）。' }
      ]
    } as const
    const failedReport: NetworkDiagnosticReport = {
      ...report,
      checks: report.checks.map((check) => check.id === 'service'
        ? { ...check, state: 'unknown', code: 'AI_DIAG_SERVICE_CONNECTION_FAILED', message: '当前路径在建立网络连接阶段失败。', phase: 'connection' }
        : check)
    }
    expect(parseDiagnosticReport(JSON.stringify({ ...failedReport, pathMatrix })).pathMatrix).toEqual(pathMatrix)
    expect(() => parseDiagnosticReport(JSON.stringify({ ...report, pathMatrix }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
    expect(() => parseDiagnosticReport(JSON.stringify({ ...failedReport, pathMatrix: { ...pathMatrix, checkedAt: checkedAt + 1 } })))
      .toThrow('DIAGNOSTIC_REPORT_INVALID')
    expect(() => parseDiagnosticReport(JSON.stringify({ ...failedReport, pathMatrix: {
      ...pathMatrix, entries: [...pathMatrix.entries].reverse()
    } }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
  })

  it('到统一有效期后旧结论失效，页面只提示重新检查', () => {
    const view = diagnosticConclusionView(report, report.validUntil)
    expect(view).toMatchObject({ stale: true, label: '已过期', title: '这次结果已过期', evidence: [] })
    expect(view.nextStep).toContain('重新检查')
    expect(view.summary).not.toContain('没有运行')
  })
})

class TestElement {
  textContent = ''; className = ''; id = ''; htmlFor = ''; value = ''; disabled = false; hidden = false
  readonly dataset: Record<string, string> = {}
  readonly children: TestElement[] = []
  private handlers = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  append(...children: TestElement[]) { this.children.push(...children) }
  replaceChildren(...children: TestElement[]) { this.children.splice(0, this.children.length, ...children) }
  setAttribute() {}
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  removeEventListener(event: string) { this.handlers.delete(event) }
  click() { if (!this.disabled) this.handlers.get('click')?.() }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
  label(): string { return this.children.map((child) => child.textContent).join('') }
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
afterEach(() => { page.unmount?.(); vi.unstubAllGlobals() })

async function mountDiagnostic(reportResult: Record<string, unknown>, network: NetworkDiagnosticReport = report) {
  const freshAt = Date.now()
  const current = { ...network, checkedAt: freshAt, validUntil: freshAt + networkDiagnosticReportTtlMs,
    ...(network.pathMatrix === undefined ? {} : { pathMatrix: { ...network.pathMatrix, checkedAt: freshAt } }) }
  const reportAction = vi.fn(async () => ({ snapshot: JSON.stringify(reportResult) }))
  vi.stubGlobal('document', {
    createElement: (tag: string) => new TestElement(tag),
    createTextNode: (text: string) => Object.assign(new TestElement('#text'), { textContent: text })
  })
  vi.stubGlobal('window', { toolbox: { diagnostics: {
    run: async () => ({ snapshot: JSON.stringify({ id: 'DG-ABCDEF-123456', software: 'codex', text: '本次诊断',
      collectedAt: '', errors: [], faults: [], network: current,
      localEgress: unknownLocalEgressEvidence(process.platform, freshAt),
      attempts: [], attemptsTotal: 0, attemptsComplete: true }) }),
    report: reportAction
  } } })
  const root = new TestElement('div')
  page.mount(root as unknown as HTMLElement, { tab: 'tunnel' } as never)
  root.all().find((node) => node.id === 'network-diagnostic-software')!.value = 'codex'
  const find = (label: string) => root.all().find((node) => node.tag === 'button' && node.label() === label)!
  return { root, find, reportAction, text: () => root.all().map((node) => node.textContent).join(' ') }
}

it('失败后的三路径结果在页面同次结论里可见', async () => {
  const matrixReport: NetworkDiagnosticReport = {
    ...report,
    checks: report.checks.map((check) => check.id === 'service'
      ? { ...check, state: 'unknown', code: 'AI_DIAG_SERVICE_CONNECTION_FAILED', message: '当前路径在建立网络连接阶段失败。', phase: 'connection' }
      : check),
    pathMatrix: {
      checkedAt, valid: true,
      entries: [
        { path: 'direct', state: 'reachable', phase: 'http', elapsedMs: 11, message: '已到达目标的 HTTP 响应（耗时 11 ms）。' },
        { path: 'existing-proxy', state: 'failed', phase: 'tls', elapsedMs: 17, message: '在 TLS 安全连接阶段失败（耗时 17 ms）。' },
        { path: 'laixin-tunnel', state: 'failed', phase: 'connection', elapsedMs: 23, message: '在网络连接阶段失败（耗时 23 ms）。' }
      ]
    }
  }
  const x = await mountDiagnostic({}, matrixReport)

  x.find('开始检查').click(); await flush()

  for (const expected of ['失败后路径对照', '直连：', '系统现有代理：', '来信通道：', 'TLS 安全连接']) expect(x.text()).toContain(expected)
})

it('AI 检查卡告知主动上报内容，离线保存后显示真实文件路径', async () => {
  const filePath = '/tmp/reports/LX-2D4F-8HTV.json'
  const x = await mountDiagnostic({ uploaded: false, receipt: 'LX-2D4F-8HTV', filePath, message: '诊断包已存在本机。' })
  for (const field of ['账号', '设备编号', '出口 IP', '代理', '设置恢复', '网络运行日志']) expect(x.text()).toContain(field)
  expect(x.text()).toContain('点击')
  expect(x.reportAction).not.toHaveBeenCalled()

  x.find('开始检查').click(); await flush()
  x.find('把本次情况报给来信').click(); await flush()
  expect(x.reportAction).toHaveBeenCalledWith({ id: 'DG-ABCDEF-123456' })
  expect(x.text()).toContain(filePath)
  expect(x.text()).not.toContain('已上报，回执号 LX-2D4F-8HTV')
})

it('AI 检查卡未上传且没有文件路径时，不假称报告已保存', async () => {
  const x = await mountDiagnostic({ uploaded: false, receipt: 'LX-2D4F-8HTV', message: '诊断包已存在本机。' })
  x.find('开始检查').click(); await flush()
  x.find('把本次情况报给来信').click(); await flush()
  expect(x.text()).toContain('未能送达')
  expect(x.text()).not.toContain('已存在本机')
})
