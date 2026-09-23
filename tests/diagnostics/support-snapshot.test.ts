import { describe, expect, it } from 'vitest'
import type { NetworkDiagnosticReport } from '../../app/network-diagnostics-types'
import {
  buildSupportSummary,
  createSupportDiagnosis,
  supportSessionInvalidReason,
  type SupportSessionContext
} from '../../app/main/diagnostics/support-snapshot'

const checkedAt = 1_800_000_000_000
const report: NetworkDiagnosticReport = {
  software: 'claude',
  checkedAt,
  validUntil: checkedAt + 10 * 60_000,
  target: { label: 'Claude 官方', route: 'tunnel' },
  conclusion: {
    status: 'unknown', scope: 'application', ruleId: 'DG01_APPLICATION_UNCONFIRMED', title: '只能定位到应用验证这一步',
    summary: '目标本次有响应，但没有 Claude Code 当前请求的成功证据。',
    nextStep: '回到 Claude Code 重试一次，再重新检查。',
    evidence: [
      { checkId: 'service', code: 'AI_DIAG_SERVICE_REACHABLE', statement: '已收到目标服务的 HTTPS 响应。' },
      { checkId: 'application', code: 'AI_DIAG_APPLICATION_UNCONFIRMED', statement: '尚无法确认 Claude Code 自己发出的请求。' }
    ]
  },
  checks: [
    { id: 'internet', label: '基础网络', state: 'passed', code: 'AI_DIAG_INTERNET_OK', message: '基础网络可用。' },
    { id: 'tunnel', label: '通道出口', state: 'passed', code: 'AI_DIAG_TUNNEL_VERIFIED', message: '通道出口最近已通过校验。' },
    { id: 'service', label: '目标服务', state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE', message: '已收到目标服务的 HTTPS 响应。' },
    { id: 'account', label: '登录与额度', state: 'not-checked', code: 'AI_DIAG_ACCOUNT_MANUAL', message: '本次没有验证登录与额度。' },
    { id: 'application', label: '应用接入', state: 'not-checked', code: 'AI_DIAG_APPLICATION_UNCONFIRMED', message: '尚无法确认 Claude Code 自己发出的请求。' }
  ]
}

const context = (overrides: Partial<SupportSessionContext> = {}): SupportSessionContext => ({
  selectionFingerprint: '{"mode":"official"}',
  serviceRunning: null,
  tunnelRequired: true,
  tunnelReadable: true,
  tunnelFingerprint: '{"state":"已连","configVersion":"7"}',
  tunnelVerified: true,
  repairFingerprint: '{"outcome":"idle"}',
  attemptsFingerprint: '[]',
  ...overrides
})

describe('DG-02 同一次客服诊断快照', () => {
  it('统一有效期、相关配置、通道、修复或已试动作变化都会使旧材料失效', () => {
    const original = context()
    expect(supportSessionInvalidReason(report, original, original, checkedAt + 1_000)).toBeUndefined()
    expect(supportSessionInvalidReason(report, original, original, report.validUntil)).toBe('expired')
    expect(supportSessionInvalidReason(report, original, context({ selectionFingerprint: '{"mode":"deepseek"}' }), checkedAt + 1_000)).toBe('changed')
    expect(supportSessionInvalidReason(report, original, context({ tunnelFingerprint: '{"state":"未连"}' }), checkedAt + 1_000)).toBe('changed')
    expect(supportSessionInvalidReason(report, original, context({ repairFingerprint: '{"outcome":"recovered"}' }), checkedAt + 1_000)).toBe('changed')
    expect(supportSessionInvalidReason(report, original, context({ attemptsFingerprint: '["retest:recovered"]' }), checkedAt + 1_000)).toBe('changed')
  })

  it('通道证据在快照后跨过 90 秒有效期会失效；保持新鲜或续验后仍可使用', () => {
    const original = context({ tunnelVerified: true })
    expect(supportSessionInvalidReason(report, original, context({ tunnelVerified: false }), checkedAt + 2_000)).toBe('changed')
    // 最近校验时间会刷新，但指纹故意不含时间；只要结束时仍新鲜，就不是配置变化。
    expect(supportSessionInvalidReason(report, original, context({ tunnelVerified: true }), checkedAt + 2_000)).toBeUndefined()
  })

  it('报告已经明确判为检查期间证据变化时，保留该未知结论供客户查看', () => {
    const changedReport: NetworkDiagnosticReport = {
      ...report,
      conclusion: {
        status: 'unknown', scope: 'diagnostic-context', ruleId: 'DG01_EVIDENCE_CHANGED', title: '检查期间证据发生变化',
        summary: '检查期间通道发生变化，本次目标证据已失效。', nextStep: '保持当前状态不变并重新检查。',
        evidence: [{ checkId: 'service', code: 'AI_DIAG_TUNNEL_CHANGED', statement: '检查期间通道发生变化，本次目标证据已失效，请重新检查。' }]
      },
      checks: report.checks.map((check) => check.id === 'service'
        ? { ...check, state: 'unknown', code: 'AI_DIAG_TUNNEL_CHANGED', message: '检查期间通道发生变化，本次目标证据已失效，请重新检查。' }
        : check)
    }
    const expired = context({ tunnelVerified: false })
    expect(supportSessionInvalidReason(changedReport, expired, expired, checkedAt + 2_000)).toBeUndefined()
  })

  it('正常请求只更新调用观察，不会被误判为配置变化；本机服务启停会失效', () => {
    const original = context({ selectionFingerprint: '{"mode":"deepseek","configuration":"ok"}', serviceRunning: true })
    // observedClientCall 不进入会话上下文，因此一次正常请求前后上下文相同。
    expect(supportSessionInvalidReason(report, original, { ...original }, checkedAt + 1_000)).toBeUndefined()
    expect(supportSessionInvalidReason(report, original, { ...original, serviceRunning: false }, checkedAt + 1_000)).toBe('changed')
  })

  it('客服摘要来自结构化报告：包含软件、目标、检查时间、结论、依据、未知项、真实动作与复验', () => {
    const diagnosis = createSupportDiagnosis('DG-ABC123', report, [{
      at: '2027-01-15T08:00:01.000Z', software: 'Claude Code', action: '重新测试', outcome: '仍有问题', detail: '网络错误'
    }])
    const text = buildSupportSummary(diagnosis)
    for (const expected of ['DG-ABC123', 'Claude Code', 'Claude 官方', '只能定位到应用验证这一步',
      '已收到目标服务的 HTTPS 响应。', '登录与额度', '本次没有验证登录与额度。', '重新测试', '仍有问题']) {
      expect(text).toContain(expected)
    }
    expect(text).not.toContain('DG01_APPLICATION_UNCONFIRMED')
  })

  it('没有执行动作时明确写未记录，不能把建议动作冒充成已尝试', () => {
    const text = buildSupportSummary(createSupportDiagnosis('DG-EMPTY123', report, []))
    expect(text).toContain('没有记录到已执行的处理动作或复验结果')
    expect(text).not.toContain('已尝试“回到 Claude Code 重试一次”')
  })

  it('已试动作或复验记录读不完整时保留未知，不能写成确定没有', () => {
    const text = buildSupportSummary(createSupportDiagnosis('DG-UNKNOWN1', report, [], false))
    expect(text).toContain('已试动作或复验记录未能完整读取')
    expect(text).not.toContain('没有记录到已执行的处理动作或复验结果')
  })
})
