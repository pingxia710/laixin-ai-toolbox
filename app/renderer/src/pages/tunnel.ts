import type { RouteExplanationView, TunnelActionResult, TunnelStatusView } from '../../../preload/api/tunnel'
import { icon, type IconName } from '../icons'
import { button, statusPill } from '../page-ui'
import type { PageModule } from './types'
import { revealSupport } from '../support-widget'
import { requestTabNavigation } from '../navigation'
import { accountSnapshot, onAccountChange } from '../account-state'
import { idleNetworkRepair, type NetworkRepairStatus } from '../../../shared/network-repair'
import type { DiagnosticSoftware } from '../../../network-diagnostics-types'
import { currentDiagnosticSession, forgetDiagnosticSession, parseDiagnosticRunSnapshot, rememberDiagnosticSession } from '../diagnostic-session'

type Tone = 'neutral' | 'positive' | 'warning' | 'danger'
type PrimaryAction = 'guide' | 'sync' | 'import' | 'start' | 'stop' | 'repair' | 'support' | 'none'

interface TunnelPageState {
  status: TunnelStatusView | undefined
  statusReadError: string
  lastActionMessage: string
  lastActionTone: Tone
  routeHost: string
  routeResult: RouteExplanationView | undefined
  routeError: string
  routeBusy: boolean
  repair: NetworkRepairStatus
  repairReadError: boolean
  /** 最近一次上报的回执号；客户要把它念给客服。 */
  reportReceipt: string
  /** 没送出去时诊断包落在本机哪儿；送出去了为空串。 */
  reportFile: string
  reportSoftware: DiagnosticSoftware
}

export interface TunnelPresentation {
  readonly tone: Tone
  readonly headline: string
  readonly description: string
  readonly hint: string
  readonly primaryAction: PrimaryAction
  readonly primaryLabel: string
}

function isHealthyLocalBackendContinuation(status: TunnelStatusView, now: number): boolean {
  const verifiedAt = Date.parse(status.lastVerifiedAt)
  return status.state === '已连' && status.unrestored === '' && status.componentMissing === '' &&
    Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 90_000 &&
    (status.pathSource === 'reused' || status.exitIp !== '' || status.pathSource === 'laixin' && status.pathVerified === true) &&
    status.authorization === '本地配置有效期内，等待重新核验' &&
    status.backend === '后台暂不可达，按本地有效期继续' &&
    status.message === '账号后台暂时问不到，按本地套餐有效期继续提供网络；恢复后自动核验' &&
    Date.parse(status.expiresAt) > now
}

const state: TunnelPageState = {
  status: undefined, statusReadError: '', lastActionMessage: '', lastActionTone: 'neutral',
  routeHost: '', routeResult: undefined, routeError: '', routeBusy: false,
  repair: { ...idleNetworkRepair }, repairReadError: false,
  reportReceipt: '', reportFile: '', reportSoftware: 'codex'
}
/** 分流说明与出口 IP 所在的折叠区：首次挂载就展开，⛔ 让客户多点一下才看得到（验收 P3-4）。 */
const networkExtraClass = 'technical-details network-extra'
let activeElement: HTMLElement | undefined
let advancedElement: HTMLElement | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let mountVersion = 0
let refreshRequest = 0
let lastRefreshedRequest = 0
let lastRender = ''
let busy = false
let reportInProgress = false
let stopAccount = (): void => undefined
const listeners: Array<() => void> = []

export const page: PageModule = {
  moduleId: 'tunnel.main',
  tab: 'tunnel',
  order: 0,
  mount: (element) => {
    const version = ++mountVersion
    activeElement = element
    state.status = undefined
    state.statusReadError = ''
    if (!reportInProgress && !state.reportReceipt) {
      state.lastActionMessage = ''
      state.lastActionTone = 'neutral'
    }
    state.routeHost = ''
    state.routeResult = undefined
    state.routeError = ''
    state.routeBusy = false
    state.repair = { ...idleNetworkRepair }
    state.repairReadError = false
    if (!reportInProgress && !state.reportReceipt) state.reportSoftware = 'codex'
    lastRender = ''
    busy = reportInProgress
    stopAccount = onAccountChange(() => render(element))
    render(element)
    void refresh(version)
    pollTimer = setInterval(() => void refresh(version), 2_000)
  },
  unmount: () => {
    stopAccount()
    mountVersion++
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    for (const remove of listeners.splice(0)) remove()
    activeElement = undefined
  }
}

export function buildTunnelPresentation(status: TunnelStatusView | undefined): TunnelPresentation {
  if (status === undefined) {
    return {
      tone: 'neutral', headline: '正在读取通道状态', description: '工具箱正在读取本机保存的配置和连接状态。',
      hint: '状态未确认前不会显示已连接。', primaryAction: 'none', primaryLabel: '读取中'
    }
  }
  if (status.componentMissing || /记录损坏|记录.*无法读取/.test(status.unrestored)) {
    return { tone: 'danger', headline: '需要协助恢复', description: status.componentMissing
      ? '安装包组件不完整，请重新安装工具箱或联系客服。' : '恢复记录无法核对，原记录已保留，请让客服协助恢复。',
    hint: status.message || status.componentMissing, primaryAction: 'support', primaryLabel: '联系来信客服' }
  }
  if (status.recoveryState === 'running') {
    return { tone: 'warning', headline: '正在恢复原设置', description: '正在交还网络设置，完成前请不要重复连接或导入配置。',
      hint: status.message || '恢复结束后会自动更新状态。', primaryAction: 'none', primaryLabel: '恢复中' }
  }
  if (status.recoveryState === 'required' || status.unrestored) {
    return { tone: 'danger', headline: '原设置尚未恢复', description: '通道已停止。可以重试恢复；其他软件修改的设置会保留。',
      hint: status.message || '恢复完成前无法重新连接或应用新配置。', primaryAction: 'stop', primaryLabel: '重试恢复原设置' }
  }
  if (status.state === '断开中') {
    return { tone: 'warning', headline: status.pauseReason === 'entitlement-denied' ? '权益校验未通过，正在暂停网络' : '正在断开网络',
      description: '正在恢复你的原网络设置。完成前请不要重复连接或断开。',
      hint: status.pauseReason === 'entitlement-denied' ? '恢复完成后可重新确认账号权益。' : '恢复完成后可再次连接。',
      primaryAction: 'none', primaryLabel: '恢复中' }
  }
  if (status.authorization === '等待重新确认账号权益') {
    return { tone: 'warning', headline: '通道已暂时暂停', description: '账号服务暂时无法确认权益。确认有效后将接续先前连接。',
      hint: '点击断开可取消自动恢复；也可手动同步账号状态。', primaryAction: 'stop', primaryLabel: '断开并取消自动恢复' }
  }
  if (status.authorization === '保留先前连接，等待重新核验') {
    return { tone: 'warning', headline: '原连接暂时保留', description: status.message,
      hint: '正在自动重试账号校验；你也可以随时断开。', primaryAction: 'stop', primaryLabel: '断开通道' }
  }
  const availability = status.availabilityStatus ?? ''
  // 接管失败后恢复原设置时，守护仍须保留“异常”的连接结果；不能用“已恢复设置”盖掉它。
  if (availability && !(availability === 'recovered' && status.state === '异常')) {
    const labels: Record<string, { readonly tone: TunnelPresentation['tone']; readonly headline: string; readonly description: string; readonly primaryLabel: string }> = {
      examining: { tone: 'warning', headline: '正在取证', description: '正在确认当前网络路径、设置归属和恢复条件。', primaryLabel: '取消连接' },
      reusing: { tone: 'warning', headline: '正在复用', description: '正在实测电脑现有网络是否可以到达目标服务；不会改动系统设置。', primaryLabel: '取消连接' },
      'taking-over': { tone: 'warning', headline: '正在接管', description: '正在保存原设置、建立写入租约，并在写后读回和实测目标服务。', primaryLabel: '取消连接' },
      reclaiming: { tone: 'warning', headline: '正在夺回', description: '检测到设置被改写，正在按当前证据进行有界夺回和复验。', primaryLabel: '取消连接' },
      recovering: { tone: 'warning', headline: '正在恢复', description: '正在只恢复仍由本次租约拥有且未被外部再次修改的设置。', primaryLabel: '恢复中' },
      recovered: { tone: 'positive', headline: '已恢复', description: '原网络设置已读回确认；外部后来修改的值已保留。', primaryLabel: '连接通道' },
      limited: { tone: 'danger', headline: '无法安全自动处理', description: status.availabilityReason || '当前网络设置缺少可验证的处理条件。', primaryLabel: '联系来信客服' }
    }
    const presentation = labels[availability]
    if (presentation !== undefined) return { ...presentation, hint: status.availabilityReason || '状态会随新的连接意图或路径证据自动更新。',
      primaryAction: availability === 'limited' ? 'support' : availability === 'recovered' ? 'start' : 'stop' }
  }
  switch (status.state) {
    case '通道待确认':
      return { tone: 'warning', headline: '正在重新确认通道', description: status.message,
        hint: '保留原通道继续检查，尚未确认恢复；可以随时断开。', primaryAction: 'stop', primaryLabel: '断开通道' }
    case '已连':
      // 复用态:我们一个字节都没改客户的系统设置,走的是他电脑上本来就有的那条外网。
      // ⛔ 说「本机代理设置和通道出口已完成校验」——那是来信自己通道才有的事(GPT-6 网络加强研究 §六)。
      return status.pathSource === 'reused'
        ? {
          tone: 'positive', headline: '网络可用', description: '正在使用你电脑上原有的外网，工具箱没有改动系统设置，会持续检查它是否还通。请打开目标 AI 软件，确认登录并尝试一次对话。',
          hint: status.lastVerifiedAt === '' ? '等待最近一次检查信息。' : `最近检查：${formatTime(status.lastVerifiedAt)}`,
          primaryAction: 'stop', primaryLabel: '停止使用网络'
        }
        : {
          tone: 'positive', headline: '已连接', description: status.exitIp === '' && status.pathVerified === true
            ? '本机代理设置和通道可达性已完成校验，出口地址暂未取得。请打开目标 AI 软件，确认登录并尝试一次对话。'
            : '本机代理设置和通道出口已完成校验。请打开目标 AI 软件，确认登录并尝试一次对话。',
          hint: status.lastVerifiedAt === '' ? '等待最近一次校验信息。' : `最近复验：${formatTime(status.lastVerifiedAt)}`,
          primaryAction: 'stop', primaryLabel: '断开通道'
        }
    case '连接中':
      return {
        tone: 'warning', headline: '正在连接', description: '正在等待通道建立和校验完成，请不要重复点击连接。',
        hint: '连接结果会自动更新，也可以随时取消。', primaryAction: 'stop', primaryLabel: '取消连接'
      }
    case '正在接续':
      // 甲-1 返工:常驻接续等待期(重开工具箱、校准未落定/正在叫醒守护)。标题如实说「正在接续」,
      // ⛔ 曾在此窗口显示「已停止」并给「连接通道」,照点立即 spawn 非常驻守护 → 落定后双守护。
      // 主按钮保留「连接通道」:此刻点击不再另起一份,而是并进同一轮,校准落定后走同一套判断接续。
      return {
        tone: 'warning', headline: '正在接续', description: '正在接续你上次的连接，稍候自动连上。',
        hint: '等待期间也可以点击连接，会并进同一轮接续；不会重复启动通道。', primaryAction: 'start', primaryLabel: '连接通道'
      }
    case '未配置':
      return {
        tone: 'neutral', headline: '国外AI需要配置网络', description: '登录账号后，按引导领取可用流量并连接。工具箱会为你准备网络设置。',
        hint: '已有来信配置包，可展开“手动配置”导入。', primaryAction: 'guide', primaryLabel: '开始设置网络'
      }
    case '异常':
      return {
        tone: 'danger', headline: '通道需要处理', description: '请查看下方状态说明；原设置未恢复前，不能应用新的配置。',
        hint: status.availabilityStatus === 'recovered' && status.availabilityReason
          ? status.availabilityReason : status.message === '' ? '连接状态异常。' : status.message,
        primaryAction: status.currentConfig === '' ? 'import' : 'repair', primaryLabel: status.currentConfig === '' ? '导入配置包' : '检测并修复连接'
      }
    case '用户主动断开':
      // N-26 轻暂停:用户断开就是暂停(共用同一意图),状态卡明说「已暂停」与开机不接续,
      // ⛔ 让客户靠理解状态机猜按钮行为。动作不变:恢复仍走连接链路。
      if (status.pauseReason === 'entitlement-denied') return {
        tone: 'warning', headline: '权益校验未通过，网络已暂停', description: status.message,
        hint: '本次恢复完成状态尚未确认；可点「恢复使用」重新校验。如账号显示权益仍有效，请联系来信客服。',
        primaryAction: status.currentConfig === '' ? 'import' : 'start', primaryLabel: status.currentConfig === '' ? '导入配置包' : '恢复使用'
      }
      return {
        tone: 'neutral', headline: '已暂停使用', description: '通道已暂停，正在恢复你的原网络设置；开机不会自动连接。',
        hint: '需要时点「恢复使用」即可继续。', primaryAction: status.currentConfig === '' ? 'import' : 'start', primaryLabel: status.currentConfig === '' ? '导入配置包' : '恢复使用'
      }
    case '已停止并恢复原设置':
      if (status.pauseReason === 'entitlement-denied') return {
        tone: 'warning', headline: '权益校验未通过，网络已暂停', description: status.message,
        hint: '可点「恢复使用」重新校验；如账号显示权益仍有效，请联系来信客服。开机不会自动连接。',
        primaryAction: status.currentConfig === '' ? 'import' : 'start', primaryLabel: status.currentConfig === '' ? '导入配置包' : '恢复使用'
      }
      return {
        tone: 'neutral', headline: '已暂停使用', description: '网络已暂停，原网络设置已恢复；开机不会自动连接。',
        hint: '点「恢复使用」可随时继续；退出工具箱时也会按此规则恢复原设置。',
        primaryAction: status.currentConfig === '' ? 'import' : 'start', primaryLabel: status.currentConfig === '' ? '导入配置包' : '恢复使用'
      }
    default:
      return {
        tone: 'warning', headline: status.state, description: status.message === '' ? '当前状态尚未提供更多说明。' : status.message,
        hint: '状态会自动更新。', primaryAction: 'none', primaryLabel: '暂不可操作'
      }
  }
}

async function refresh(version: number): Promise<void> {
  const request = ++refreshRequest
  try {
    const [status, repair] = await Promise.all([window.toolbox.tunnel.status(),
      Promise.resolve().then(() => window.toolbox.tunnel.repairStatus()).catch(() => undefined)])
    if (version !== mountVersion || request < lastRefreshedRequest) return
    state.status = status
    state.statusReadError = ''
    state.repairReadError = repair === undefined
    if (repair) state.repair = repair
  } catch {
    if (version !== mountVersion || request < lastRefreshedRequest) return
    state.status = undefined
    state.statusReadError = '状态读取失败，请稍后重试。'
  }
  lastRefreshedRequest = request
  if (activeElement !== undefined && version === mountVersion) render(activeElement)
}

async function runAction(action: () => Promise<TunnelActionResult>): Promise<void> {
  if (busy || activeElement === undefined) return
  const version = mountVersion
  busy = true
  render(activeElement)
  try {
    const result = await action()
    if (version !== mountVersion) return
    state.lastActionMessage = result.message
    state.lastActionTone = result.outcome === 'rejected' ? 'danger' : result.outcome === 'cancelled' ? 'warning' : 'neutral'
  } catch {
    if (version !== mountVersion) return
    state.lastActionMessage = '操作未完成，请重试或重新导入来信配置包。'
    state.lastActionTone = 'danger'
  }
  busy = false
  await refresh(version)
}

async function runReportDiagnosis(software: DiagnosticSoftware): Promise<ReturnType<typeof parseDiagnosticRunSnapshot>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      window.toolbox.diagnostics.runForReport({ software }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('DIAGNOSTIC_TIMEOUT')), 30_000) })
    ])
    const session = parseDiagnosticRunSnapshot(response.snapshot)
    if (session.software !== software) throw new Error('DIAGNOSTIC_SOFTWARE_MISMATCH')
    return session
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function render(element: HTMLElement): void {
  const now = Date.now()
  const key = JSON.stringify([state, busy, accountSnapshot().state,
    state.status !== undefined && isHealthyLocalBackendContinuation(state.status, now)])
  if (key === lastRender) return
  const firstRender = lastRender === ''
  lastRender = key
  const focusedAction = element.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.networkAction : undefined
  const routeCaret = routeCaretOf(element)
  // 首次挂载给默认展开的那一份；之后按客户自己开合的现状保留。
  const opened = firstRender
    ? new Set([networkExtraClass])
    : new Set(Array.from(element.querySelectorAll<HTMLDetailsElement>('details[open]')).map((details) => details.className))
  for (const remove of listeners.splice(0)) remove()
  element.className = 'tunnel-page'
  element.replaceChildren()
  const status = state.status
  const presentation = status === undefined && state.statusReadError
    ? { ...buildTunnelPresentation(status), headline: '暂时无法确认连接状态', description: '状态读取失败，正在等待重新读取。', hint: '请稍后重试，或联系来信客服。' }
    : buildTunnelPresentation(status)
  element.append(connectionCard(presentation))
  appendFeedback(element, status, now)
  element.append(repairCard(), detailsCard(status), networkShortcuts(status))
  const extra = document.createElement('details'); extra.className = networkExtraClass
  extra.open = opened.has(networkExtraClass)
  const summary = document.createElement('summary'); summary.textContent = '更多连接信息与分流说明'
  summary.dataset.networkAction = 'extra'
  extra.append(summary, extraDetails(status), routeExplanationCard(status)); element.append(extra)
  element.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => { details.open = opened.has(details.className) })
  renderAdvanced()
  if (focusedAction) element.querySelectorAll<HTMLElement>('[data-network-action]').forEach((action) => { if (action.dataset.networkAction === focusedAction) action.focus({ preventScroll: true }) })
  restoreRouteCaret(element, routeCaret)
}

/** 轮询会整页重建；输入中的分流查询框按原位置恢复焦点与光标。 */
function routeCaretOf(element: HTMLElement): [number, number] | undefined {
  const active = document.activeElement as HTMLElement | null
  if (!active || active.dataset.networkRouteInput !== 'true' || !element.contains(active)) return undefined
  const input = active as HTMLInputElement
  return [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length]
}

function restoreRouteCaret(element: HTMLElement, caret: [number, number] | undefined): void {
  if (!caret) return
  const input = element.querySelector<HTMLInputElement>('[data-network-route-input]')
  if (!input) return
  input.focus({ preventScroll: true })
  try { input.setSelectionRange(caret[0], caret[1]) } catch { /* 非文本输入不支持选区时保持默认 */ }
}

export function mountTunnelDetails(element: HTMLElement): () => void {
  advancedElement = element
  element.className = 'network-advanced'
  renderAdvanced()
  return () => { advancedElement = undefined }
}

function renderAdvanced(): void {
  const element = advancedElement
  if (!element) return
  const opened = new Set(Array.from(element.querySelectorAll<HTMLDetailsElement>('details[open]')).map((details) => details.className))
  const focusedAction = element.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.networkAction : undefined
  element.replaceChildren(actionSection(state.status))
  element.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => { details.open = opened.has(details.className) })
  if (focusedAction) element.querySelectorAll<HTMLElement>('[data-network-action]').forEach((action) => { if (action.dataset.networkAction === focusedAction) action.focus({ preventScroll: true }) })
}

function connectionCard(presentation: TunnelPresentation): HTMLElement {
  if (state.repair.running && state.status?.state !== '断开中') presentation = { tone: 'warning', headline: '正在检测并修复连接',
    description: state.repair.message, hint: '修复期间会短暂断开来信通道；可以随时取消。',
    primaryAction: 'stop', primaryLabel: '取消修复并断开' }
  const card = document.createElement('section')
  card.className = 'panel connection-card'
  card.dataset.tone = presentation.tone
  const kicker = document.createElement('div')
  kicker.className = 'card-kicker'
  const label = document.createElement('span')
  label.append(icon('network'), document.createTextNode('AI网络配置'))
  kicker.append(label)
  const body = document.createElement('div')
  body.className = 'connection-main'
  const copy = document.createElement('div')
  const unconfigured = presentation.primaryAction === 'guide'
  const signedIn = accountSnapshot().state === 'signed-in'
  copy.append(Object.assign(document.createElement('h2'), { textContent: unconfigured ? '尚未配置' : presentation.headline }))
  copy.append(Object.assign(document.createElement('p'), { textContent: unconfigured
    ? signedIn ? '账号已登录。按引导领取可用流量并准备网络配置，也可以导入已有的来信配置包。' : '登录来信账号后，领取可用流量并准备网络配置；已有来信配置包也可手动导入。'
    : presentation.description }))
  const hint = document.createElement('div')
  hint.className = 'connection-hint'
  hint.append(icon(presentation.tone === 'danger' ? 'warning' : presentation.tone === 'positive' ? 'check' : 'clock'), document.createTextNode(presentation.hint))
  copy.append(hint)
  const power = document.createElement('div')
  power.className = 'connection-actions'
  const action = primaryAction(presentation.primaryAction)
  const guide = presentation.primaryAction === 'guide'
  const support = presentation.primaryAction === 'support'
  const trigger = button('', {
    className: 'power-button', iconName: presentation.primaryAction === 'repair' ? 'refresh' : 'power',
    disabled: busy || (presentation.primaryAction === 'repair' && state.repairReadError) || (!guide && !support && action === undefined),
    onClick: support ? () => revealSupport() : guide ? () => requestTabNavigation('dashboard') : action === undefined ? undefined : () => void runAction(action)
  })
  trigger.dataset.networkAction = 'primary'
  trigger.setAttribute('aria-label', presentation.primaryLabel)
  power.append(trigger, Object.assign(document.createElement('small'), { textContent: presentation.primaryLabel }))
  body.append(copy, power)
  const footer = document.createElement('div')
  footer.className = 'connection-footer'
  for (const [name, value] of [['出口节点', state.status?.nodeLabel || '尚未配置'], ['配置版本', state.status?.configVersion || '尚未应用'], ['最近复验', state.status?.lastVerifiedAt ? formatTime(state.status.lastVerifiedAt) : '尚未复验']]) {
    const fact = document.createElement('span'); fact.append(document.createTextNode(name), Object.assign(document.createElement('strong'), { textContent: value })); footer.append(fact)
  }
  card.append(kicker, body, footer)
  return card
}

function repairCard(): HTMLElement {
  const card = document.createElement('section'); card.className = 'panel network-repair'
  const repair = state.repair
  card.append(Object.assign(document.createElement('h3'), { textContent: '连接有问题？' }))
  card.append(Object.assign(document.createElement('p'), { textContent: '恢复来信管理的设置、同步配置，再重新连接验证。不会接管其他代理，也不会更改 AI 的模型或 API Key。' }))
  const actions = document.createElement('div'); actions.className = 'network-repair-actions'
  const trigger = button(repair.running ? '正在修复' : '检测并修复连接', {
    iconName: 'refresh', disabled: busy || repair.running || !state.status || state.status.state === '断开中' || state.repairReadError,
    onClick: () => void runAction(() => { forgetDiagnosticSession(); return window.toolbox.tunnel.repair() })
  })
  trigger.dataset.networkAction = 'repair'
  const copy = button('复制诊断给客服', { disabled: busy || repair.running,
    onClick: () => void runAction(async () => {
      const session = currentDiagnosticSession()
      const result = JSON.parse((await window.toolbox.diagnostics.copy({ id: session?.id ?? '' })).snapshot) as { copied?: boolean; stale?: boolean; message?: string }
      if (!result.copied && session) forgetDiagnosticSession(session.id)
      return result.copied ? { outcome: 'copied', code: '', message: session ? '本次诊断已复制，可粘贴给来信客服。' : '当前网络信息已复制，可粘贴给来信客服。' }
        : { outcome: 'rejected', code: '', message: result.message ?? '结果已失效，请重新检查。' }
    }) })
  copy.dataset.networkAction = 'repair-copy'
  // 一键上报：客户不会复制诊断、也不一定发得出来（创始人 09-13：「复制诊断我不发哈」）。
  // 点一下，剩下的不用他管；发不出去也给同一个回执号和一份本机文件。
  const softwareLabel = document.createElement('label'); softwareLabel.className = 'setting-row network-report-software'
  softwareLabel.append(document.createTextNode('本次报障检查的软件'))
  const softwareSelect = document.createElement('select'); softwareSelect.className = 'theme-select'
  softwareSelect.dataset.networkAction = 'repair-report-software'
  for (const [value, title] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['hermes', 'Hermes（DeepSeek）']] as const) {
    softwareSelect.append(Object.assign(document.createElement('option'), { value, textContent: title }))
  }
  softwareSelect.value = state.reportSoftware
  softwareSelect.disabled = busy || repair.running
  softwareSelect.addEventListener('change', () => {
    if (softwareSelect.value === 'codex' || softwareSelect.value === 'claude' || softwareSelect.value === 'hermes') {
      state.reportSoftware = softwareSelect.value
    }
  })
  softwareLabel.append(softwareSelect)
  const send = button('把情况报给来信', { disabled: busy || repair.running,
    onClick: () => {
      if (reportInProgress || busy) return
      const submitReport = async (id: string) => JSON.parse((await window.toolbox.diagnostics.report({ id })).snapshot) as
        { receipt?: string; uploaded: boolean; stale?: boolean; filePath?: string; message: string }
      const submitIncomplete = async (software: DiagnosticSoftware) => JSON.parse((await window.toolbox.diagnostics.reportIncomplete({ software })).snapshot) as
        { receipt?: string; uploaded: boolean; stale?: boolean; filePath?: string; message: string }
      const software = state.reportSoftware
      reportInProgress = true
      busy = true
      state.reportReceipt = ''
      state.reportFile = ''
      state.lastActionMessage = '正在检查本次网络情况并准备报告，请稍候。'
      state.lastActionTone = 'neutral'
      if (activeElement) render(activeElement)
      void (async () => {
        try {
          forgetDiagnosticSession()
          let id = ''
          let incomplete = false
          try {
            const diagnosis = await runReportDiagnosis(software)
            id = diagnosis.id
            rememberDiagnosticSession({ id, software, checkedAt: diagnosis.network.checkedAt })
          } catch {
            incomplete = true
          }
          let result = id ? await submitReport(id) : await submitIncomplete(software)
          if (result.stale && id) {
            forgetDiagnosticSession(id)
            incomplete = true
            result = await submitIncomplete(software)
          }
          if (result.stale) {
            state.lastActionMessage = result.message
            state.lastActionTone = 'danger'
            return
          }
          state.reportReceipt = result.receipt ?? ''
          state.reportFile = result.uploaded ? '' : result.filePath ?? ''
          state.lastActionMessage = incomplete ? `本次诊断未完成；${result.message}` : result.message
          state.lastActionTone = result.uploaded ? 'neutral' : 'danger'
        } catch {
          state.lastActionMessage = '上报未完成，请重试；若本次检查失败，诊断结果也未生成。'
          state.lastActionTone = 'danger'
        } finally {
          reportInProgress = false
          busy = false
          if (activeElement) render(activeElement)
        }
      })()
    } })
  send.dataset.networkAction = 'repair-report'
  actions.append(trigger, send, copy); card.append(softwareLabel, actions)
  // 客户按之前就该知道发的是什么。这句是事实陈述，⛔ 写成免责声明。
  card.append(Object.assign(document.createElement('small'), { className: 'network-report-scope',
    textContent: '只有点击上报才会发送脱敏诊断包，可能包含账号/设备编号、出口 IP、代理与设置恢复状态、近期故障和网络运行日志。日志中的地址文本会做脱敏处理，但仍可能保留部分地址；不主动采集对话内容。' }))
  if (state.reportReceipt) {
    const receipt = document.createElement('p'); receipt.className = 'network-report-receipt'
    receipt.dataset.receipt = state.reportReceipt
    receipt.append(document.createTextNode('回执号 '), Object.assign(document.createElement('strong'), { textContent: state.reportReceipt }))
    if (state.reportFile) receipt.append(Object.assign(document.createElement('small'), { textContent: `没能送出去，诊断包在：${state.reportFile}` }))
    card.append(receipt)
  }
  if (!repair.running && repair.finishedAt) card.append(Object.assign(document.createElement('small'), {
    textContent: `上次修复：${formatTime(repair.finishedAt)}；当前连接以本页顶部状态为准。`
  }))
  const feedback = document.createElement('p'); feedback.className = 'network-repair-result'
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite')
  feedback.dataset.outcome = repair.outcome
  feedback.textContent = state.repairReadError ? '修复状态暂时读不到，请稍后刷新；不要把它当作已经修好。'
    : repair.message || '只在本机代理和通道出口复验通过后显示已修复；AI 登录和对话需在目标软件确认。'
  card.append(feedback)
  return card
}

function detailsCard(status: TunnelStatusView | undefined): HTMLElement {
  const card = document.createElement('section')
  card.className = 'technical-details network-details'
  const header = document.createElement('div'); header.className = 'network-details-header'
  const copy = document.createElement('div')
  copy.append(Object.assign(document.createElement('h3'), { textContent: '连接详情' }), Object.assign(document.createElement('p'), { textContent: status?.pendingAvailable ? '有新配置待应用，可在手动配置中查看。' : '本机当前已应用的网络配置。' }))
  header.append(copy); card.append(header)
  const details = document.createElement('dl')
  details.className = 'detail-list'
  appendDetail(details, '当前配置', status?.currentConfig, '尚未应用配置')
  appendDetail(details, '当前节点', status?.nodeLabel, '尚未配置节点')
  appendDetail(details, '配置版本', status?.configVersion, '尚未应用')
  appendDetail(details, '最近复验', status?.lastVerifiedAt ? formatTime(status.lastVerifiedAt) : '', '尚未复验')
  appendDetail(details, '出口 IP', status?.exitIp, status?.pathSource === 'reused' ? '复用本机原有外网，无来信出口'
    : status?.pathVerified === true ? '出口地址暂未取得' : '连接后校验')
  card.append(details)
  return card
}

function extraDetails(status: TunnelStatusView | undefined): HTMLElement {
  const details = document.createElement('dl'); details.className = 'detail-list'
  appendDetail(details, '本机代理', status?.state === '已连' ? '设置已读回核验' : status?.unrestored ? '恢复未完成' : '', '连接后核验')
  appendDetail(details, '通道出口', status?.state === '已连' ? '出口探测已通过' : '', '尚未通过当前连接校验')
  appendDetail(details, '目标 AI 软件', '请在软件内确认登录并尝试对话', '')
  appendDetail(details, '待用配置', status?.pendingConfig, '没有待应用配置')
  appendDetail(details, '配置来源', status?.source, '尚未取得')
  appendDetail(details, '授权状态', status?.authorization, '尚未取得')
  appendDetail(details, '有效期', status?.expiresAt, '尚未取得')
  appendDetail(details, '后台状态', status?.backend, '尚未取得')
  appendDetail(details, '出口 IP', status?.exitIp, status?.pathSource === 'reused' ? '复用本机原有外网，无来信出口'
    : status?.pathVerified === true ? '出口地址暂未取得' : '连接后校验')
  appendDetail(details, '代理入口流量', status?.traffic, '连接后显示')
  return details
}

function networkShortcuts(status: TunnelStatusView | undefined): HTMLElement {
  const section = document.createElement('div'); section.className = 'network-shortcuts'
  const open = (selector: string): void => {
    const details = activeElement?.closest('#tab-panel')?.querySelector<HTMLDetailsElement>(selector)
    if (!details) return
    details.open = true; details.scrollIntoView({ block: 'nearest' }); details.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
  }
  for (const [title, description, iconName, action, disabled] of [
    ['刷新状态', '读取当前连接状态与最近一次复验结果。', 'refresh', () => { void refresh(mountVersion) }, busy],
    ['同步配置', '登录后读取账号下的网络配置，沿用现有应用流程。', 'download', () => { void runAction(() => window.toolbox.tunnel.syncAccountConfig()) }, busy || state.repair.running || status === undefined || status.state === '断开中' || accountSnapshot().state !== 'signed-in'],
    ['网络诊断', '检查基础网络、当前通道和目标 AI 服务。', 'network', () => open('.network-diagnostics'), false],
    ['手动配置', '导入已有的来信配置包，或应用待用配置。', 'settings', () => open('.network-manual'), false]
  ] as const) {
    const trigger = button('', { disabled, onClick: action }); trigger.className = 'network-shortcut'
    trigger.dataset.networkAction = title; trigger.setAttribute('aria-label', title)
    trigger.append(icon(iconName), Object.assign(document.createElement('strong'), { textContent: title }), Object.assign(document.createElement('span'), { textContent: description }))
    section.append(trigger)
  }
  return section
}

/** 一眼看懂的结论：走哪条路、是不是局域网、还是得交给内核判。 */
export function routeVerdict(explanation: RouteExplanationView): string {
  if (explanation.outcome === 'kernel-check') return '交内核判定'
  if (explanation.outcome === 'tunnel') return '走通道'
  if (explanation.outcome === 'dedicated') return '走专用通道'
  if (explanation.outcome !== 'direct') return ''
  return explanation.reasonCode === 'LOCAL_NETWORK_DIRECT' || explanation.reasonCode === 'PRIVATE_IP_DIRECT' ? '直连（局域网）' : '直连'
}

function routeExplanationCard(status: TunnelStatusView | undefined): HTMLElement {
  const card = document.createElement('section')
  card.className = 'technical-details route-explanation'
  card.append(Object.assign(document.createElement('h3'), { textContent: '分流说明' }))
  const description = document.createElement('p')
  description.textContent = '输入域名，查看当前已应用配置中的明确规则。仅说明本机规则，国内域名库和 IP 数据仍由 Xray 内核判断。'
  card.append(description)
  const controls = document.createElement('div')
  controls.className = 'route-explanation-controls'
  const input = document.createElement('input')
  input.type = 'text'; input.value = state.routeHost; input.maxLength = 253
  input.placeholder = '例如 api.openai.com'; input.autocomplete = 'off'
  input.dataset.networkRouteInput = 'true'
  input.setAttribute('aria-label', '要查询的域名')
  input.disabled = !status?.currentConfig || state.routeBusy
  const trigger = button(state.routeBusy ? '正在查询' : '查看分流', {
    disabled: !status?.currentConfig || state.routeBusy || state.routeHost.trim() === '',
    onClick: () => void explainRoute()
  })
  trigger.dataset.networkAction = 'route-explain'
  // 每敲一个字不整页重建（会丢焦点），只就地更新按钮可用态并清掉旧结果。
  input.addEventListener('input', () => {
    state.routeHost = input.value
    state.routeResult = undefined
    state.routeError = ''
    trigger.disabled = !status?.currentConfig || state.routeBusy || state.routeHost.trim() === ''
    card.querySelectorAll('.route-explanation-error, .route-explanation-result').forEach((node) => node.remove())
  })
  controls.append(input, trigger)
  card.append(controls)
  if (state.routeError) card.append(Object.assign(document.createElement('p'), { className: 'route-explanation-error', textContent: state.routeError }))
  if (state.routeResult) {
    const explanation = state.routeResult
    const result = document.createElement('div')
    result.className = 'route-explanation-result'
    result.dataset.outcome = explanation.outcome
    const heading = document.createElement('div')
    heading.className = 'route-explanation-heading'
    heading.append(Object.assign(document.createElement('strong'), { textContent: explanation.title }))
    const verdict = routeVerdict(explanation)
    // 「知不知道答案」才是这里的轴：命中了明确规则给正向，交内核判定是中性的未知。
    if (verdict) heading.append(statusPill(verdict, explanation.outcome === 'kernel-check' ? 'neutral' : 'positive'))
    result.append(heading, Object.assign(document.createElement('span'), { textContent: explanation.detail }))
    if (explanation.outcome !== 'invalid' && explanation.outcome !== 'unconfigured') {
      const rule = document.createElement('p')
      rule.className = 'route-explanation-rule'
      rule.append(Object.assign(document.createElement('span'), { textContent: '命中规则' }))
      rule.append(Object.assign(document.createElement('code'), {
        textContent: explanation.matchedRule === '' ? '无明确规则，交内核判定' : explanation.matchedRule
      }))
      result.append(rule)
    }
    card.append(result)
  }
  return card
}

async function explainRoute(): Promise<void> {
  if (state.routeBusy || state.routeHost.trim() === '') return
  // 与 refresh/runAction 同一套：查询期间切走再切回，页面已重挂载，旧结论 ⛔ 挂到空输入框下面。
  const version = mountVersion
  state.routeBusy = true
  state.routeError = ''
  if (activeElement !== undefined) render(activeElement)
  try {
    const explanation = await window.toolbox.tunnel.explainRoute(state.routeHost.trim())
    if (version !== mountVersion) return
    state.routeResult = explanation
  } catch {
    if (version !== mountVersion) return
    state.routeResult = undefined
    state.routeError = '分流说明暂时无法读取，请稍后重试。'
  } finally {
    if (version === mountVersion) {
      state.routeBusy = false
      if (activeElement !== undefined) render(activeElement)
    }
  }
}

function appendDetail(list: HTMLDListElement, label: string, value: string | undefined, fallback: string): void {
  const row = document.createElement('div')
  row.className = 'detail-row'
  row.append(Object.assign(document.createElement('dt'), { textContent: label }))
  const content = document.createElement('dd')
  content.textContent = value === undefined || value === '' ? fallback : value
  if (value === undefined || value === '') content.className = 'is-empty'
  row.append(content)
  list.append(row)
}

function actionSection(status: TunnelStatusView | undefined): HTMLElement {
  const section = document.createElement('details'); section.className = 'technical-details network-manual'
  const heading = document.createElement('summary'); heading.textContent = '手动配置'
  heading.dataset.networkAction = 'manual'
  const actions = document.createElement('div')
  actions.className = 'action-grid'
  // N-26:启动与暂停拆两颗卡,两卡并存、各自禁用态正确——⛔ 一张卡按状态换脸让客户不敢点。
  // 暂停 = 通道活动或待确认时可用,语义走既有 tunnel.stop() 链路(复用 user-disconnected 意图)。
  const disconnecting = status?.state === '断开中'
  const channelActive = status !== undefined && !disconnecting && (['已连', '连接中', '通道待确认'].includes(status.state) ||
    ['等待重新确认账号权益', '保留先前连接，等待重新核验'].includes(status.authorization))
  // 旧用户主动断开与已停止状态沿用暂停文案；断开中仍在恢复原设置，不开放连接。
  const paused = status !== undefined && ['用户主动断开', '已停止并恢复原设置'].includes(status.state)
  actions.append(
    actionCard('同步账号配置', '登录来信账号后，领取已开通的网络配置。', 'refresh', '同步配置', () => window.toolbox.tunnel.syncAccountConfig(), status === undefined || disconnecting),
    actionCard('导入配置包', '从本机选择来信签发的配置包；不会读取第三方订阅。', 'upload', '导入配置包', () => window.toolbox.tunnel.importConfig(), status === undefined),
    actionCard('应用待用配置', '仅在通道断开且原设置已恢复时可应用。', 'check', '应用新配置', () => window.toolbox.tunnel.applyPending(), status?.canApplyPending !== true),
    // 启动/恢复一颗:暂停态换文案;通道活动中原设置未恢复时都不可发起(恢复入口在上方「重试恢复原设置」)。
    actionCard(paused ? '恢复使用' : '连接通道', paused ? '回到暂停前的用法：重新连接并核验，随时可再暂停。' : '使用当前配置重新连接并核验。',
      paused ? 'play' : 'power', paused ? '恢复' : '连接', () => window.toolbox.tunnel.start(),
      status === undefined || disconnecting || channelActive || Boolean(status.unrestored) || status.currentConfig === ''),
    actionCard('暂停使用', '断开通道并恢复你的原网络设置；开机不会自动连接。', 'pause', '暂停',
      () => window.toolbox.tunnel.stop(), status === undefined || !channelActive)
  )
  section.append(heading, actions)
  return section
}

function actionCard(title: string, description: string, iconName: IconName, label: string, action: () => Promise<TunnelActionResult>, disabled: boolean): HTMLElement {
  const card = document.createElement('section')
  card.className = 'action-card'
  card.append(icon(iconName), Object.assign(document.createElement('h3'), { textContent: title }), Object.assign(document.createElement('p'), { textContent: description }))
  const trigger = button(label, { disabled: busy || state.repair.running || disabled, onClick: () => void runAction(action) })
  trigger.dataset.networkAction = title
  card.append(trigger)
  return card
}

function primaryAction(action: PrimaryAction): (() => Promise<TunnelActionResult>) | undefined {
  switch (action) {
    case 'sync': return () => window.toolbox.tunnel.syncAccountConfig()
    case 'import': return () => window.toolbox.tunnel.importConfig()
    case 'start': return () => window.toolbox.tunnel.start()
    case 'stop': return () => window.toolbox.tunnel.stop()
    case 'repair': return () => { forgetDiagnosticSession(); return window.toolbox.tunnel.repair() }
    case 'guide':
    case 'support':
    case 'none': return undefined
  }
}

function appendFeedback(element: HTMLElement, status: TunnelStatusView | undefined, now: number): void {
  const messages: Array<{ text: string; tone: Tone; iconName: IconName }> = []
  if (state.statusReadError !== '') messages.push({ text: state.statusReadError, tone: 'danger', iconName: 'warning' })
  if (state.lastActionMessage !== '') messages.push({ text: state.lastActionMessage, tone: state.lastActionTone, iconName: state.lastActionTone === 'danger' ? 'warning' : 'check' })
  if (status?.message !== undefined && status.message !== '' && !isHealthyLocalBackendContinuation(status, now)) {
    messages.push({ text: status.message, tone: status.state === '异常' ? 'danger' : 'warning', iconName: 'warning' })
  }
  if (status?.unrestored !== undefined && status.unrestored !== '') messages.push({ text: `未恢复项：${status.unrestored}`, tone: 'danger', iconName: 'warning' })
  if (status?.componentMissing !== undefined && status.componentMissing !== '') messages.push({ text: status.componentMissing, tone: 'danger', iconName: 'warning' })
  for (const message of messages) {
    const feedback = document.createElement('div')
    feedback.className = 'network-feedback'
    feedback.dataset.tone = message.tone
    feedback.append(icon(message.iconName), document.createTextNode(message.text))
    element.append(feedback)
  }
}

function formatTime(value: string): string {
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '时间无法读取'
}
