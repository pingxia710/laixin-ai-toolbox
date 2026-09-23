import { supportDiagnosticAttemptLimit, type DiagnosticSoftware, type NetworkDiagnosticReport } from '../../network-diagnostics-types'

export interface SupportAttempt {
  readonly at: string
  readonly software: string
  readonly action: string
  readonly outcome: string
  readonly detail?: string
}

export interface SupportDiagnosis {
  readonly id: string
  readonly report: NetworkDiagnosticReport
  readonly attempts: readonly SupportAttempt[]
  readonly attemptsTotal: number
  readonly attemptsComplete: boolean
}

export interface SupportAttemptSelection {
  readonly attempts: readonly SupportAttempt[]
  readonly total: number
}

/** 只保存会影响诊断结论的运行态；正常请求产生的 observedClientCall 不在这里。 */
export interface SupportSessionContext {
  readonly selectionFingerprint: string
  readonly serviceRunning: boolean | null
  readonly tunnelRequired: boolean
  readonly tunnelReadable: boolean
  /** 不含 lastVerifiedAt；续验时间变化本身不是配置变化。 */
  readonly tunnelFingerprint: string
  /** 但校验记录跨过有效期必须使旧证据失效。 */
  readonly tunnelVerified: boolean
  readonly repairFingerprint: string
  readonly attemptsFingerprint: string
}

export type SupportSessionInvalidReason = 'expired' | 'changed'

export function supportSessionInvalidReason(report: NetworkDiagnosticReport, original: SupportSessionContext,
  current: SupportSessionContext, now = Date.now()): SupportSessionInvalidReason | undefined {
  if (!Number.isFinite(now) || now < report.checkedAt || now >= report.validUntil) return 'expired'
  const tunnelCheck = report.checks.find((check) => check.id === 'tunnel')
  if (report.conclusion.ruleId !== 'DG01_EVIDENCE_CHANGED' && current.tunnelRequired && tunnelCheck?.code === 'AI_DIAG_TUNNEL_VERIFIED' &&
      (!current.tunnelReadable || !current.tunnelVerified)) return 'changed'
  if (original.selectionFingerprint !== current.selectionFingerprint ||
      original.serviceRunning !== current.serviceRunning ||
      original.tunnelRequired !== current.tunnelRequired ||
      original.repairFingerprint !== current.repairFingerprint ||
      original.attemptsFingerprint !== current.attemptsFingerprint) return 'changed'
  if (original.tunnelRequired && (original.tunnelReadable !== current.tunnelReadable ||
      original.tunnelFingerprint !== current.tunnelFingerprint || original.tunnelVerified !== current.tunnelVerified)) return 'changed'
  return undefined
}

/** 最近的在前；历史动作与本次修复先合并，再统一截断，避免界面与上报各裁一份。 */
export function selectSupportAttempts(attempts: readonly SupportAttempt[]): SupportAttemptSelection {
  const sorted = attempts.map((attempt, index) => ({ attempt, index })).sort((left, right) => {
    const difference = Date.parse(right.attempt.at) - Date.parse(left.attempt.at)
    return Number.isFinite(difference) && difference !== 0 ? difference : left.index - right.index
  }).map(({ attempt }) => attempt)
  return { attempts: sorted.slice(0, supportDiagnosticAttemptLimit), total: sorted.length }
}

export function createSupportDiagnosis(id: string, report: NetworkDiagnosticReport,
  attempts: readonly SupportAttempt[], attemptsComplete = true, attemptsTotal = attempts.length): SupportDiagnosis {
  const selected = selectSupportAttempts(attempts)
  const total = Number.isSafeInteger(attemptsTotal) && attemptsTotal >= selected.total ? attemptsTotal : selected.total
  return { id, report, attempts: selected.attempts, attemptsTotal: total, attemptsComplete }
}

const softwareNames: Readonly<Record<DiagnosticSoftware, string>> = {
  codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes'
}

/** 客户复制的摘要与上报结构共用同一个 SupportDiagnosis。规则码只在结构化材料中供客服追溯。 */
export function buildSupportSummary(diagnosis: SupportDiagnosis): string {
  const { report } = diagnosis
  const lines = [
    '【本次客服诊断】',
    `诊断编号：${diagnosis.id}`,
    `问题软件：${softwareNames[report.software]}`,
    `检查目标：${report.target.label}（${report.target.route === 'direct' ? '直连' : '经 AI 网络'}）`,
    `检查时间：${new Date(report.checkedAt).toLocaleString('zh-CN')}`,
    `本次结论：${report.conclusion.title}`,
    report.conclusion.summary,
    '',
    '判断依据：',
    ...report.conclusion.evidence.map((item) => `- ${item.statement}`),
    '',
    '未确认项：'
  ]
  const unconfirmed = report.checks.filter((check) => check.state === 'unknown' || check.state === 'not-checked')
  if (unconfirmed.length === 0) lines.push('- 本次五项检查没有保留未知或未检查项。')
  else for (const check of unconfirmed) lines.push(`- ${check.label}：${check.message}`)
  lines.push('', '实际已试动作与复验：')
  if (diagnosis.attempts.length === 0 && diagnosis.attemptsComplete) lines.push('- 本次诊断快照中没有记录到已执行的处理动作或复验结果。')
  else for (const attempt of diagnosis.attempts) {
    lines.push(`- ${new Date(attempt.at).toLocaleString('zh-CN')} · ${attempt.software} · ${attempt.action} → ${attempt.outcome}${attempt.detail ? ` · ${attempt.detail}` : ''}`)
  }
  if (diagnosis.attemptsTotal > diagnosis.attempts.length) {
    lines.push(`- 共读取到 ${diagnosis.attemptsTotal} 条已试动作与复验记录；本次材料只保留最近 ${diagnosis.attempts.length} 条。`)
  }
  if (!diagnosis.attemptsComplete) lines.push('- 已试动作或复验记录未能完整读取，未读到的部分保持未知。')
  lines.push('', `下一步：${report.conclusion.nextStep}`)
  return lines.join('\n')
}
