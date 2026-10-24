// 「切换前先看看机器上还留着什么」这块的界面。
// 说人话：在哪、是什么、影响哪款 AI、点一下停用、随时可以撤销。
// **⛔ 把完整的 Key 显示出来**——后台传上来的就已经是脱敏过的，这里也不做任何还原。
import type { HiddenStateCleanReceipt, HiddenStateRestoreOutcome } from '../../../main/actions/hidden-state'
import type { HiddenStateFinding, HiddenStateReport, HiddenStateSeverity, HiddenStateSoftware } from '../../../main/ai-access/hidden-state'

const softwareLabels: Readonly<Record<HiddenStateSoftware, string>> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }
const severityLabels: Readonly<Record<HiddenStateSeverity, string>> = {
  blocking: '很可能就是连不上的原因', warning: '会干扰接入', info: '仅供参考'
}
const kinds = ['shell_export', 'registry_env', 'system_proxy', 'claude_onboarding']
const severities = ['blocking', 'warning', 'info']

/** 桥回来的东西一律先校验再上屏：结构不对就当没有，⛔ 把任意文本塞进界面。 */
export function readHiddenStateReport(raw: string): HiddenStateReport {
  const value = JSON.parse(raw) as HiddenStateReport
  const validFinding = (item: HiddenStateFinding): boolean =>
    typeof item?.id === 'string' && kinds.includes(item.kind) && severities.includes(item.severity) &&
    typeof item.source === 'string' && typeof item.name === 'string' && typeof item.valueMasked === 'string' &&
    typeof item.impact === 'string' && typeof item.suggestion === 'string' &&
    typeof item.cleanable === 'boolean' && Array.isArray(item.affects) &&
    item.affects.every((software) => Object.hasOwn(softwareLabels, software))
  if (!value || typeof value.scannedAt !== 'string' || !Array.isArray(value.findings) || !Array.isArray(value.unreadable) ||
    !value.findings.every(validFinding)) throw new Error('HIDDEN_STATE_REPORT_INVALID')
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function cleanupFailures(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => record(item) &&
    typeof item.source === 'string' && typeof item.name === 'string' && typeof item.reason === 'string')
}

/** A cleanup receipt must never carry the original shell line or a full API Key into the renderer. */
export function readHiddenStateCleanReceipt(raw: string): HiddenStateCleanReceipt {
  const value = JSON.parse(raw) as unknown
  if (!record(value) || value.version !== 1 || typeof value.receiptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.receiptId) ||
    typeof value.at !== 'string' || typeof value.cleaned !== 'number' || !Number.isSafeInteger(value.cleaned) || value.cleaned < 0 ||
    !cleanupFailures(value.failures) || !strings(value.notes) || !record(value.shell) || !record(value.registry) || !Array.isArray(value.claude) ||
    !Array.isArray(value.shell.entries) || !cleanupFailures(value.shell.failures) || !strings(value.shell.notes) ||
    !value.shell.entries.every((entry) => record(entry) && typeof entry.source === 'string' && typeof entry.backupPath === 'string' &&
      typeof entry.name === 'string' && typeof entry.line === 'number' && Number.isSafeInteger(entry.line) && entry.line > 0 &&
      !Object.hasOwn(entry, 'originalLine') && !Object.hasOwn(entry, 'commentedLine')) ||
    !Array.isArray(value.registry.entries) || !cleanupFailures(value.registry.failures) || !strings(value.registry.notes) ||
    !value.registry.entries.every((entry) => record(entry) && typeof entry.key === 'string' && typeof entry.name === 'string' && typeof entry.backupPath === 'string') ||
    !value.claude.every((entry) => record(entry) && typeof entry.path === 'string' &&
      (typeof entry.backupPath === 'string' || entry.backupPath === null) && typeof entry.changed === 'boolean')) {
    throw new Error('HIDDEN_STATE_CLEAN_RECEIPT_INVALID')
  }
  return value as unknown as HiddenStateCleanReceipt
}

export function readHiddenStateRestoreOutcome(raw: string): HiddenStateRestoreOutcome {
  const value = JSON.parse(raw) as unknown
  if (!record(value) || !Array.isArray(value.results) || !strings(value.notes) || !value.results.every((item) => record(item) &&
    typeof item.source === 'string' && typeof item.name === 'string' && ['restored', 'already-restored', 'failed'].includes(String(item.outcome)) &&
    (item.reason === undefined || typeof item.reason === 'string') && (item.backupPath === undefined || typeof item.backupPath === 'string'))) {
    throw new Error('HIDDEN_STATE_RESTORE_OUTCOME_INVALID')
  }
  return value as unknown as HiddenStateRestoreOutcome
}

/** 标题写「这是什么事」，⛔ 写变量名了事——客户不认识 ANTHROPIC_AUTH_TOKEN。 */
export function findingTitle(finding: HiddenStateFinding): string {
  switch (finding.kind) {
    case 'shell_export':
      return `终端启动文件里留着一条 ${finding.name}`
    case 'registry_env':
      return `系统环境变量里留着一条 ${finding.name}`
    case 'system_proxy':
      return '这台电脑开着上网代理'
    case 'claude_onboarding':
      return finding.name === 'hasCompletedOnboarding' ? 'Claude Code 还停在第一次使用的引导页' : 'Claude Code 记着你以前拒绝过的 Key'
  }
}

export function findingWhere(finding: HiddenStateFinding): string {
  // 软链要把真正的文件说出来，否则客户照着 ~/.bashrc 去找会发现里面什么都没有。
  const via = finding.resolvedSource === undefined ? '' : `（链接到 ${finding.resolvedSource}）`
  const place = finding.line === undefined ? `${finding.source}${via}` : `${finding.source}${via} 第 ${finding.line} 行`
  return finding.kind === 'claude_onboarding' ? `在 ${finding.source}${via}` : `在 ${place} · 当前是 ${finding.valueMasked}`
}

export function findingAffects(finding: HiddenStateFinding): string {
  return `影响 ${finding.affects.map((software) => softwareLabels[software]).join('、')}`
}

/** 一句话的抬头。没有会干扰的，就明说没有，**⛔ 报「未知」吓客户**。 */
export function noticeHeadline(report: HiddenStateReport): string | null {
  const disturbing = report.findings.filter((finding) => finding.severity !== 'info')
  if (disturbing.length > 0) return `发现 ${disturbing.length} 处会干扰接入的旧设置`
  if (report.findings.length > 0) return `没有会干扰接入的旧设置，另有 ${report.findings.length} 处情况供你参考`
  if (report.unreadable.length > 0) return `这次有 ${report.unreadable.length} 处没能检查`
  return null
}

export interface HiddenStateNoticeOptions {
  readonly onClean: (ids: readonly string[]) => Promise<HiddenStateCleanReceipt>
  readonly onRestore: (receipt: HiddenStateCleanReceipt) => Promise<HiddenStateRestoreOutcome>
  /** 接上就多一个「重新检查」按钮：出错时客户能自己走回闭环，⛔ 只能干等。 */
  readonly onRescan?: () => Promise<void>
  /** 残留代理归网络模块处理，这里只给一个直达按钮，⛔ 让客户自己找去哪儿。 */
  readonly onOpenNetwork?: () => void
}

/** 停用前的原样存在哪儿——失败时要把这个说出来，客户才有得手工恢复。 */
export function backupPaths(receipt: HiddenStateCleanReceipt): readonly string[] {
  return [...new Set([
    ...receipt.shell.entries.map((entry) => entry.backupPath),
    ...receipt.registry.entries.map((entry) => entry.backupPath),
    ...receipt.claude.map((entry) => entry.backupPath).filter((path): path is string => path !== null)
  ])]
}

function line(className: string, text: string): HTMLElement {
  const element = document.createElement('p')
  element.className = className
  element.textContent = text
  return element
}

/**
 * 画出整块提示。没什么可说的时候返回 null（也不往容器里塞空壳），
 * 由调用方决定这块要不要出现在页面上。
 */
export function renderHiddenStateNotice(
  container: HTMLElement,
  report: HiddenStateReport,
  options: HiddenStateNoticeOptions
): HTMLElement | null {
  const headline = noticeHeadline(report)
  if (headline === null) { container.replaceChildren(); return null }

  const section = document.createElement('section')
  section.className = 'hidden-state-notice'
  section.dataset.severity = report.findings.some((finding) => finding.severity === 'blocking') ? 'blocking'
    : report.findings.some((finding) => finding.severity === 'warning') ? 'warning' : 'info'
  const parts: HTMLElement[] = [line('hidden-state-headline', headline)]
  if (report.findings.length > 0) {
    parts.push(line('hidden-state-lead', '这些是以前装别的工具、或手工配过留下的。工具箱会先备份再停用，随时可以撤回。'))
  }

  const status = document.createElement('p')
  status.className = 'hidden-state-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.hidden = true

  const undo = document.createElement('button')
  undo.type = 'button'
  undo.className = 'secondary-action hidden-state-undo'
  undo.textContent = '撤销刚才的停用'
  undo.hidden = true

  const cleanable = report.findings.filter((finding) => finding.cleanable)
  const buttons: HTMLButtonElement[] = []
  const list = document.createElement('ul')
  list.className = 'hidden-state-list'
  const items = report.findings.map((finding) => {
    const item = document.createElement('li')
    item.className = 'hidden-state-item'
    item.dataset.kind = finding.kind
    item.dataset.severity = finding.severity
    item.dataset.findingId = finding.id
    const rows: HTMLElement[] = [
      line('hidden-state-item-title', findingTitle(finding)),
      line('hidden-state-item-tag', severityLabels[finding.severity]),
      line('hidden-state-item-where', findingWhere(finding)),
      line('hidden-state-item-impact', `${findingAffects(finding)}：${finding.impact}`),
      line('hidden-state-item-suggestion', finding.suggestion)
    ]
    if (finding.kind === 'system_proxy' && options.onOpenNetwork !== undefined) {
      const toNetwork = document.createElement('button')
      toNetwork.type = 'button'
      toNetwork.className = 'secondary-action hidden-state-open-network'
      toNetwork.textContent = '去「网络」处理'
      toNetwork.addEventListener('click', () => options.onOpenNetwork?.())
      rows.push(toNetwork)
    }
    if (finding.cleanable) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'secondary-action hidden-state-clean'
      button.textContent = '停用这一条'
      button.dataset.findingId = finding.id
      // 把 Promise 交回去：真实 DOM 会忽略返回值，用例却能确定地等它跑完。
      button.addEventListener('click', () => run(button, [finding.id]))
      buttons.push(button)
      rows.push(button)
    }
    item.replaceChildren(...rows)
    return item
  })
  list.replaceChildren(...items)
  parts.push(list)

  const actions = document.createElement('div')
  actions.className = 'hidden-state-actions'
  const actionRow: HTMLElement[] = []
  if (cleanable.length > 1) {
    const all = document.createElement('button')
    all.type = 'button'
    all.className = 'primary-action hidden-state-clean-all'
    all.textContent = `一次停用这 ${cleanable.length} 处`
    all.addEventListener('click', () => run(all, cleanable.map((finding) => finding.id)))
    buttons.push(all)
    actionRow.push(all)
  }
  if (options.onRescan !== undefined) {
    const rescan = document.createElement('button')
    rescan.type = 'button'
    rescan.className = 'secondary-action hidden-state-rescan'
    rescan.textContent = '重新检查'
    rescan.addEventListener('click', () => options.onRescan?.())
    actionRow.push(rescan)
  }
  actionRow.push(undo)
  actions.replaceChildren(...actionRow)
  parts.push(actions, status)

  if (report.unreadable.length > 0) {
    parts.push(line('hidden-state-unreadable',
      `另有 ${report.unreadable.length} 处这次没能检查：${report.unreadable.map((item) => item.source).join('、')}。不影响其余检查结果。`))
  }

  let receipt: HiddenStateCleanReceipt | null = null
  const settle = (text: string, tone: 'positive' | 'danger' | 'neutral'): void => {
    status.hidden = false
    status.dataset.tone = tone
    status.textContent = text
    for (const button of buttons) { button.removeAttribute('aria-busy'); button.disabled = false }
  }

  async function run(button: HTMLButtonElement, ids: readonly string[]): Promise<void> {
    if (button.disabled) return
    for (const other of buttons) other.disabled = true
    button.setAttribute('aria-busy', 'true')
    try {
      const result = await options.onClean(ids)
      receipt = result
      undo.hidden = result.cleaned === 0
      // 说「处理了几条」，⛔ 把「按钮点过了」说成「已经清理好」。
      const failed = result.failures.length === 0 ? '' : `；有 ${result.failures.length} 处没能处理：${result.failures.map((item) => `${item.name}（${item.reason}）`).join('、')}`
      const note = result.notes.length === 0 ? '' : `（${result.notes.join('；')}）`
      settle(result.cleaned === 0 ? `这次一处也没改动${failed}` : `已停用 ${result.cleaned} 处，随时可以撤销${failed}${note}`,
        result.cleaned === 0 ? 'danger' : 'positive')
    } catch {
      settle('这次没能处理，你的文件一点没动。可以照上面写的位置，自己在那一行前面加个 # 把它停用；或者点「重新检查」再来一次。', 'danger')
    }
  }

  async function undoClean(): Promise<void> {
    if (receipt === null || undo.disabled) return
    const restoring = receipt
    for (const other of buttons) other.disabled = true
    undo.disabled = true
    undo.setAttribute('aria-busy', 'true')
    try {
      const outcome = await options.onRestore(restoring)
      const failed = outcome.results.filter((item) => item.outcome === 'failed')
      undo.hidden = failed.length === 0
      settle(failed.length === 0 ? '已经全部还原成原来的样子。'
        : `还原了一部分，有 ${failed.length} 处要手工处理：${failed.map((item) => `${item.source}（${item.reason ?? '原因不明'}${item.backupPath === undefined ? '' : `，备份在 ${item.backupPath}`}）`).join('、')}`,
      failed.length === 0 ? 'positive' : 'danger')
    } catch {
      // ⛔ 只说「稍后再试」：备份在哪必须说出来，客户才有得自己还原。
      settle(`这次没能自动还原。停用前的原样存在备份里：${backupPaths(restoring).join('、') || '备份目录'}，把它复制回原处就能恢复。`, 'danger')
    }
    undo.disabled = false
    undo.removeAttribute('aria-busy')
  }
  undo.addEventListener('click', () => undoClean())

  section.replaceChildren(...parts)
  container.replaceChildren(section)
  return section
}
