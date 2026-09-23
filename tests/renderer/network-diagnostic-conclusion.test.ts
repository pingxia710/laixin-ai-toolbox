import { describe, expect, it } from 'vitest'
import { networkDiagnosticReportTtlMs, type NetworkDiagnosticReport } from '../../app/network-diagnostics-types'
import { diagnosticConclusionView, parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'

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
    { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '目标有响应。' },
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
  })

  it('到统一有效期后旧结论失效，页面只提示重新检查', () => {
    const view = diagnosticConclusionView(report, report.validUntil)
    expect(view).toMatchObject({ stale: true, label: '已过期', title: '这次结果已过期', evidence: [] })
    expect(view.nextStep).toContain('重新检查')
    expect(view.summary).not.toContain('没有运行')
  })
})
