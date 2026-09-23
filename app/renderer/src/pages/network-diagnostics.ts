import { diagnosticCheckCodes, diagnosticConclusionContracts, diagnosticConclusionRuleIds, networkDiagnosticReportTtlMs,
  type DiagnosticSoftware, type NetworkDiagnosticReport } from '../../../network-diagnostics-types'
import { button, statusPill } from '../page-ui'
import { refreshSupportContext, registerSupportContext, revealSupport } from '../support-widget'
import { forgetDiagnosticSession, parseDiagnosticRunSnapshot, rememberDiagnosticSession } from '../diagnostic-session'
import type { DiagnosticAttempt } from '../diagnostic-session'
import type { PageModule } from './types'

const names: Record<DiagnosticSoftware, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes（DeepSeek）' }
const states = { passed: '已确认', attention: '需要处理', unknown: '未能确认', 'not-checked': '未检查' } as const
const codes = new Set<string>(diagnosticCheckCodes)
const rules = new Set<string>(diagnosticConclusionRuleIds)
const checkIds = ['internet', 'tunnel', 'service', 'account', 'application'] as const

export interface DiagnosticConclusionView {
  readonly stale: boolean
  readonly label: string
  readonly tone: 'neutral' | 'positive' | 'warning'
  readonly title: string
  readonly summary: string
  readonly nextStep: string
  readonly evidence: readonly string[]
  readonly checkedAt: number
  readonly target: string
}

export function parseDiagnosticReport(snapshot: string): NetworkDiagnosticReport {
  const report = JSON.parse(snapshot) as NetworkDiagnosticReport
  if (!report || !Object.hasOwn(names, report.software) || !Number.isSafeInteger(report.checkedAt) ||
      !Number.isSafeInteger(report.validUntil) || report.validUntil !== report.checkedAt + networkDiagnosticReportTtlMs ||
      !report.target || typeof report.target.label !== 'string' || report.target.label.length < 1 || report.target.label.length > 80 ||
      !['direct', 'tunnel'].includes(report.target.route) ||
      !Array.isArray(report.checks) || report.checks.length !== 5 ||
      report.checks.some((check, index) => !check || check.id !== checkIds[index] ||
        !Object.hasOwn(states, check.state) || !codes.has(check.code) || typeof check.label !== 'string' || check.label.length > 30 ||
        typeof check.message !== 'string' || check.message.length > 300 ||
        (check.elapsedMs !== undefined && (!Number.isSafeInteger(check.elapsedMs) || check.elapsedMs < 0 || check.elapsedMs > 60_000)))) throw new Error('DIAGNOSTIC_REPORT_INVALID')
  const conclusion = report.conclusion
  const contract = conclusion && rules.has(conclusion.ruleId) ? diagnosticConclusionContracts[conclusion.ruleId] : undefined
  if (!conclusion || !contract || conclusion.status !== contract.status || conclusion.scope !== contract.scope ||
      typeof conclusion.title !== 'string' || conclusion.title.length < 1 || conclusion.title.length > 80 ||
      typeof conclusion.summary !== 'string' || conclusion.summary.length < 1 || conclusion.summary.length > 300 ||
      typeof conclusion.nextStep !== 'string' || conclusion.nextStep.length < 1 || conclusion.nextStep.length > 240 ||
      !Array.isArray(conclusion.evidence) || conclusion.evidence.length < 1 || conclusion.evidence.length > 3 ||
      conclusion.evidence.some((item) => {
        if (!item || !checkIds.includes(item.checkId) || !codes.has(item.code) || typeof item.statement !== 'string') return true
        const source = report.checks.find(check => check.id === item.checkId)
        return source === undefined || source.code !== item.code || source.message !== item.statement
      })) throw new Error('DIAGNOSTIC_REPORT_INVALID')
  return report
}

export function diagnosticConclusionView(report: NetworkDiagnosticReport, now = Date.now()): DiagnosticConclusionView {
  if (!Number.isFinite(now) || now < report.checkedAt || now >= report.validUntil) {
    return {
      stale: true, label: '已过期', tone: 'neutral', title: '这次结果已过期',
      summary: '连接、配置或服务状态可能已经变化，旧结果不再作为当前判断依据。',
      nextStep: '保持当前配置不变，再点一次“开始检查”重新检查。', evidence: [], checkedAt: report.checkedAt, target: report.target.label
    }
  }
  const labels = { blocked: '已定位', limited: '范围已定位', unknown: '仍有未知', clear: '未发现阻断' } as const
  const tones = { blocked: 'warning', limited: 'neutral', unknown: 'neutral', clear: 'positive' } as const
  return {
    stale: false,
    label: labels[report.conclusion.status],
    tone: tones[report.conclusion.status],
    title: report.conclusion.title,
    summary: report.conclusion.summary,
    nextStep: report.conclusion.nextStep,
    evidence: report.conclusion.evidence.map(item => item.statement),
    checkedAt: report.checkedAt,
    target: report.target.label
  }
}

function renderDiagnosticConclusion(container: HTMLElement, report: NetworkDiagnosticReport, id: string,
  attempts: readonly DiagnosticAttempt[], attemptsTotal: number, attemptsComplete: boolean, now = Date.now()): void {
  const view = diagnosticConclusionView(report, now)
  container.replaceChildren()
  container.hidden = false
  container.dataset.status = view.stale ? 'stale' : report.conclusion.status
  container.dataset.ruleId = report.conclusion.ruleId
  const heading = document.createElement('div'); heading.className = 'diagnostic-conclusion-heading'
  heading.append(Object.assign(document.createElement('h3'), { textContent: '本次结论' }), statusPill(view.label, view.tone))
  const title = document.createElement('strong'); title.className = 'diagnostic-conclusion-title'; title.textContent = view.title
  const summary = document.createElement('p'); summary.className = 'diagnostic-conclusion-summary'; summary.textContent = view.summary
  const facts = document.createElement('dl'); facts.className = 'diagnostic-conclusion-facts'
  if (view.evidence.length > 0) {
    const evidence = document.createElement('div')
    evidence.append(Object.assign(document.createElement('dt'), { textContent: '判断依据' }))
    const list = document.createElement('ul')
    for (const statement of view.evidence) list.append(Object.assign(document.createElement('li'), { textContent: statement }))
    const detail = document.createElement('dd'); detail.append(list); evidence.append(detail)
    facts.append(evidence)
  }
  const next = document.createElement('div')
  next.append(Object.assign(document.createElement('dt'), { textContent: '下一步' }), Object.assign(document.createElement('dd'), { textContent: view.nextStep }))
  facts.append(next)
  const tried = document.createElement('div')
  tried.append(Object.assign(document.createElement('dt'), { textContent: '已试与复验' }))
  const triedDetail = document.createElement('dd')
  if (attempts.length === 0 && attemptsComplete) triedDetail.textContent = '本次诊断快照中没有记录到已执行的处理动作或复验结果。'
  else if (attempts.length > 0) {
    const triedList = document.createElement('ul')
    for (const attempt of attempts) triedList.append(Object.assign(document.createElement('li'), {
      textContent: `${new Date(attempt.at).toLocaleString('zh-CN')} · ${attempt.software} · ${attempt.action} → ${attempt.outcome}${attempt.detail ? ` · ${attempt.detail}` : ''}`
    }))
    triedDetail.append(triedList)
  }
  if (attemptsTotal > attempts.length) triedDetail.append(Object.assign(document.createElement('p'), {
    textContent: `共读取到 ${attemptsTotal} 条已试动作与复验记录；本次材料只保留最近 ${attempts.length} 条。`
  }))
  if (!attemptsComplete) triedDetail.append(Object.assign(document.createElement('p'), { textContent: '已试动作或复验记录未能完整读取，未读到的部分保持未知。' }))
  tried.append(triedDetail); facts.append(tried)
  const meta = document.createElement('p'); meta.className = 'diagnostic-conclusion-meta'
  meta.textContent = `检查时间 ${new Date(view.checkedAt).toLocaleString('zh-CN')} · 目标 ${view.target} · 诊断编号 ${id}`
  container.append(heading, title, summary, facts, meta)
}

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'network.diagnostics', tab: 'tunnel', order: 5,
  mount: (element, context) => {
    cleanup()
    let active = true
    let report: NetworkDiagnosticReport | undefined
    let sessionId = ''
    let sessionAttempts: readonly DiagnosticAttempt[] = []
    let sessionAttemptsTotal = 0
    let sessionAttemptsComplete = false
    let generation = 0
    let expiry: ReturnType<typeof setTimeout> | undefined
    const details = document.createElement('details'); details.className = 'technical-details network-diagnostics'
    const summary = document.createElement('summary'); summary.textContent = 'AI 打不开？检查原因'
    const body = document.createElement('div')
    const note = document.createElement('p'); note.className = 'account-note'; note.textContent = '检查基础网络、当前通道和目标服务；登录与额度请在软件内确认。'
    const row = document.createElement('div'); row.className = 'setting-row'
    const label = document.createElement('label'); label.htmlFor = 'network-diagnostic-software'; label.textContent = '遇到问题的软件'
    const select = document.createElement('select'); select.id = label.htmlFor; select.className = 'theme-select'
    for (const [value, textContent] of Object.entries(names)) select.append(Object.assign(document.createElement('option'), { value, textContent }))
    const feedback = document.createElement('p'); feedback.className = 'account-note'; feedback.setAttribute('role', 'status')
    const conclusion = document.createElement('section'); conclusion.className = 'diagnostic-conclusion'; conclusion.hidden = true; conclusion.setAttribute('aria-live', 'polite')
    const list = document.createElement('ol'); list.className = 'diagnostic-checks'; list.hidden = true
    const help = button('查看客服信息', { onClick: revealSupport }); help.hidden = true
    const copy = button('复制本次诊断', { onClick: () => { void copyResult() } }); copy.disabled = true
    const send = button('把本次情况报给来信', { onClick: () => { void reportResult() } }); send.disabled = true
    const unregister = registerSupportContext(list, () => {
      const current = report && Date.now() >= report.checkedAt && Date.now() - report.checkedAt < 10 * 60_000 ? report : undefined
      return { software: current ? names[current.software] : 'AI网络', cardId: 'network-diagnostics', stageCode: 'NETWORK_DIAG',
        reasonCodes: current ? [...new Set(current.checks.map((check) => check.code))] : ['NETWORK_DIAGNOSTIC_STALE'],
        summary: current ? `最近检查：${names[current.software]} · ${new Date(current.checkedAt).toLocaleString('zh-CN')} · 诊断编号 ${sessionId || '未生成'}。登录和对话未验证。` : '检查结果已过期，请重新检查。' }
    })
    const run = button('开始检查', { onClick: () => { void inspect() } })
    const reset = () => {
      generation += 1
      clearTimeout(expiry)
      forgetDiagnosticSession(sessionId || undefined)
      sessionId = ''
      sessionAttempts = []
      sessionAttemptsTotal = 0
      sessionAttemptsComplete = false
      report = undefined; conclusion.replaceChildren(); conclusion.hidden = true; delete conclusion.dataset.ruleId; delete conclusion.dataset.status
      list.replaceChildren(); list.hidden = true; help.hidden = true; copy.disabled = send.disabled = true; feedback.textContent = ''
      refreshSupportContext()
    }
    select.addEventListener('change', reset)
    const inspect = async () => {
      if (run.disabled) return
      reset(); const request = generation; select.disabled = run.disabled = true; feedback.textContent = '正在检查，请稍候…'
      try {
        const result = parseDiagnosticRunSnapshot((await window.toolbox.diagnostics.run({ software: select.value as DiagnosticSoftware })).snapshot)
        if (!active || request !== generation) return
        report = parseDiagnosticReport(JSON.stringify(result.network))
        if (report.software !== select.value) throw new Error('DIAGNOSTIC_REPORT_INVALID')
        sessionId = result.id
        sessionAttempts = result.attempts
        sessionAttemptsTotal = result.attemptsTotal
        sessionAttemptsComplete = result.attemptsComplete
        rememberDiagnosticSession({ id: result.id, software: result.software, checkedAt: report.checkedAt })
        renderDiagnosticConclusion(conclusion, report, sessionId, sessionAttempts, sessionAttemptsTotal, sessionAttemptsComplete)
        for (const check of report.checks) {
          const item = document.createElement('li')
          const title = document.createElement('div'); title.className = 'diagnostic-check-title'
          title.append(Object.assign(document.createElement('strong'), { textContent: check.label }),
            statusPill(check.id === 'application' && check.state === 'not-checked' ? '尚无法确认' : states[check.state], check.state === 'passed' ? 'positive' : check.state === 'attention' ? 'warning' : 'neutral'))
          item.append(title, Object.assign(document.createElement('p'), { textContent: check.message }))
          list.append(item)
        }
        list.hidden = help.hidden = false; copy.disabled = send.disabled = false
        refreshSupportContext()
        expiry = setTimeout(() => {
          if (report !== undefined) renderDiagnosticConclusion(conclusion, report, sessionId, sessionAttempts, sessionAttemptsTotal, sessionAttemptsComplete)
          if (sessionId) forgetDiagnosticSession(sessionId)
          sessionId = ''; copy.disabled = send.disabled = true
          feedback.textContent = '这次结果已过期，请重新检查后再复制或上报。'
          refreshSupportContext()
        }, Math.max(0, report.validUntil - Date.now()))
        feedback.textContent = `检查完成 · ${new Date(report.checkedAt).toLocaleTimeString('zh-CN')}。复制与上报使用的都是本次结果。`
      } catch {
        if (active && request === generation) { report = undefined; sessionId = ''; copy.disabled = send.disabled = true; feedback.textContent = '本次检查未完成，请重试或联系客服。' }
      } finally { if (active && request === generation) select.disabled = run.disabled = false }
    }
    const copyResult = async () => {
      if (!sessionId) { feedback.textContent = '请先选择软件并完成一次检查。'; return }
      const id = sessionId; const request = generation
      try {
        const value = JSON.parse((await window.toolbox.diagnostics.copy({ id })).snapshot) as { copied?: boolean; stale?: boolean; message?: string }
        if (!active || request !== generation || sessionId !== id) return
        if (value.copied) feedback.textContent = '已复制本次诊断，粘贴给来信客服即可。'
        else { forgetDiagnosticSession(sessionId); sessionId = ''; copy.disabled = send.disabled = true; feedback.textContent = value.message ?? '结果已失效，请重新检查。' }
      } catch { if (active && request === generation && sessionId === id) feedback.textContent = '复制失败，请重新检查后再试。' }
    }
    const reportResult = async () => {
      if (!sessionId) { feedback.textContent = '请先选择软件并完成一次检查。'; return }
      const id = sessionId; const request = generation
      send.disabled = true
      try {
        const value = JSON.parse((await window.toolbox.diagnostics.report({ id })).snapshot) as
          { receipt?: string; uploaded?: boolean; stale?: boolean; filePath?: string; message?: string }
        if (!active || request !== generation || sessionId !== id) return
        if (value.stale) { forgetDiagnosticSession(sessionId); sessionId = ''; copy.disabled = true; feedback.textContent = value.message ?? '结果已失效，请重新检查。' }
        else feedback.textContent = value.message ?? (value.uploaded ? `已上报，回执号 ${value.receipt ?? '—'}。` : `没能送达，材料已保存到 ${value.filePath ?? '本机'}。`)
      } catch { if (active && request === generation && sessionId === id) feedback.textContent = '上报未完成，请重试；本次诊断不会被替换。' }
      finally { if (active && request === generation && sessionId === id) send.disabled = false }
    }
    const actions = document.createElement('div'); actions.className = 'action-row'; actions.append(copy, send, help)
    row.append(label, select, run); body.append(note, row, feedback, conclusion, list, actions); details.append(summary, body); element.append(details)
    // 从出错的软件跳进来：预选那个软件、展开这一节并滚到眼前，客户不用自己找。
    if (context.diagnosticSoftware !== undefined && Object.hasOwn(names, context.diagnosticSoftware)) {
      select.value = context.diagnosticSoftware
      details.open = true
      feedback.textContent = `已选中${names[context.diagnosticSoftware]}，点「开始检查」看是哪一层不通。`
      requestAnimationFrame(() => { if (active) { details.scrollIntoView({ block: 'nearest' }); run.focus() } })
    }
    cleanup = () => { active = false; generation += 1; clearTimeout(expiry); unregister(); select.removeEventListener('change', reset) }
  },
  unmount: () => cleanup()
}
