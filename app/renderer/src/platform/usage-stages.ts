import { configurationMessages, type ApiShell, type ApiUsageStage, type CodexDesktopRouteReason, type CodexDesktopRouteVerification, type ConfigurationState, type ModelProviderId } from '../../../shared/api-service-types'
import { modelProviderIds } from '../../../shared/model-providers'
import { icon } from '../icons'

const shells = ['codex', 'claude', 'hermes']
const configurations: readonly ConfigurationState[] = ['not-managed', 'ok', 'modified-externally', 'missing', 'unknown']
const desktopReasons: readonly CodexDesktopRouteReason[] = [
  'verified_socket_bound_desktop', 'awaiting_desktop_request', 'incomplete_answer', 'platform_unsupported',
  'socket_metadata_unavailable', 'socket_owner_not_found', 'socket_owner_ambiguous',
  'socket_owner_not_codex_desktop', 'desktop_signature_unverified', 'socket_binding_unavailable'
]

/** 快照里的三态；字段不合清单就整条丢掉，⛔ 让没校验的内容上屏。 */
export function readUsageStages(value: unknown): readonly ApiUsageStage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const stage = item as Record<string, unknown>
    const time = (name: string): boolean => stage[name] === null || (typeof stage[name] === 'string' && Number.isFinite(Date.parse(stage[name] as string)))
    const desktop = readDesktopRoute(stage.codexDesktopRoute)
    if (!shells.includes(String(stage.shell)) ||
      (stage.provider !== null && !modelProviderIds.includes(stage.provider as ModelProviderId)) ||
      !configurations.includes(stage.configuration as ConfigurationState) ||
      !time('tested') || !time('configured') || !time('observedClientCall') || desktop === null) return []
    return [{
      shell: stage.shell as ApiShell,
      provider: stage.provider as ModelProviderId | null,
      tested: stage.tested as string | null,
      configured: stage.configured as string | null,
      observedClientCall: stage.observedClientCall as string | null,
      ...(desktop === undefined ? {} : { codexDesktopRoute: desktop }),
      configuration: stage.configuration as ConfigurationState
    }]
  })
}

/** Project the bridge value rather than returning it by reference: nothing beyond status/time/reason reaches the renderer. */
function readDesktopRoute(value: unknown): CodexDesktopRouteVerification | undefined | null {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const route = value as Record<string, unknown>
  const at = route.at === null || typeof route.at === 'string' && Number.isFinite(Date.parse(route.at))
  if (!((route.status === 'verified' || route.status === 'unverified') && at &&
    desktopReasons.includes(route.reason as CodexDesktopRouteReason) &&
    (route.status !== 'verified' || typeof route.at === 'string') &&
    (route.status !== 'unverified' || route.at === null))) return null
  return {
    status: route.status as CodexDesktopRouteVerification['status'],
    at: route.at as CodexDesktopRouteVerification['at'],
    reason: route.reason as CodexDesktopRouteReason
  }
}

/**
 * 账号总览的卡片该显示哪一条三态：这个壳的那条，且它记的正是当前在看的那家。
 * 在看别家时不给——三态记的是「真正配置的那家」，**⛔ 把别家的勾挂到这家名下**；
 * 官方套餐（`provider === null`）本来就没有这三步。
 */
export function usageStageFor(stages: readonly ApiUsageStage[], shell: ApiShell, provider: ModelProviderId): ApiUsageStage | undefined {
  const stage = stages.find(item => item.shell === shell)
  return stage?.provider === provider ? stage : undefined
}

const moment = (at: string): string => {
  const value = new Date(at)
  const today = new Date()
  const sameDay = value.toDateString() === today.toDateString()
  return sameDay ? value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : value.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface UsageStageView {
  readonly label: string
  readonly state: 'done' | 'waiting'
  /** 完成的显示时间，未完成的显示该怎么触发。 */
  readonly detail: string
}

/** 三步各自到哪了；第三步没发生时给的是「怎么让它发生」，⛔ 只说一句「等待」。 */
export function usageStageViews(stage: ApiUsageStage): readonly UsageStageView[] {
  const observedLabel = stage.shell === 'codex' ? '已观察到 Codex 调用（CLI/桌面版）' : '已观察到软件调用'
  const observedHint = stage.shell === 'codex'
    ? 'CLI 调用和桌面版调用都会记在这里；桌面版需看下一项。'
    : '等待首次使用：重新打开该 AI 并发一条消息。'
  const views: UsageStageView[] = ([
    ['接口测试过', stage.tested, '还没测过这条接入。'],
    ['配置已写', stage.configured, '这次运行还没写过配置。'],
    [observedLabel, stage.observedClientCall, observedHint]
  ] as const).map(([label, at, hint]) => ({ label, state: at === null ? 'waiting' as const : 'done' as const, detail: at === null ? hint : moment(at) }))
  if (stage.shell === 'codex') {
    // A legacy snapshot may omit the optional field entirely; treat it as no Desktop request yet.
    // A current gateway that cannot bind the socket explicitly sends `socket_binding_unavailable`.
    const desktop = stage.codexDesktopRoute ?? { status: 'unverified' as const, at: null, reason: 'awaiting_desktop_request' as const }
    views.push({
      label: 'Codex 桌面版已验证',
      state: desktop.status === 'verified' ? 'done' : 'waiting',
      detail: desktop.status === 'verified' && desktop.at !== null ? moment(desktop.at) : codexDesktopHint(desktop)
    })
  }
  return views
}

function codexDesktopHint(route: CodexDesktopRouteVerification): string {
  switch (route.reason) {
    case 'awaiting_desktop_request':
      return '请完全退出并重新打开 Codex 桌面版，发送一条消息并等到它显示完整回答。'
    case 'incomplete_answer':
      return '这次没有收到完整回答，桌面版未验证；请处理失败后再发送一条消息。'
    case 'platform_unsupported':
      return '当前系统无法可靠核对桌面进程与本机网关连接，桌面版不会显示为已验证。'
    case 'socket_metadata_unavailable':
    case 'socket_binding_unavailable':
      return '本机无法完成桌面进程与当前网关连接的核对，桌面版未验证。'
    case 'socket_owner_not_found':
    case 'socket_owner_ambiguous':
    case 'socket_owner_not_codex_desktop':
      return '这次调用未能核对为 Codex 桌面版进程；CLI 调用不能代替桌面版验证。'
    case 'desktop_signature_unverified':
      return '检测到本机连接，但无法确认官方 Codex 桌面版签名，桌面版未验证。'
    case 'verified_socket_bound_desktop':
      return '已核对到 Codex 桌面版。'
  }
}

/** 配置被外部改过 / 托管段不见了才提示；其余状态不打扰客户。 */
export function configurationAlert(stage: ApiUsageStage): string | null {
  return stage.configuration === 'modified-externally' || stage.configuration === 'missing' ? configurationMessages[stage.configuration] : null
}

/**
 * 「接口测试过 / 配置已写 / 已观察到软件调用」三步分开显示。
 * 前两步绿了第三步空着，说明客户还没重开 AI——所以第三步直接告诉他怎么触发，
 * ⛔ 用「配置已写」冒充「真的在用」。渲染只消费 usageStageViews，⛔ 另写一份判断。
 */
export function usageStages(stage: ApiUsageStage | undefined, onReapply?: () => HTMLElement | null): HTMLElement | null {
  if (!stage || stage.provider === null) return null
  const list = document.createElement('ol')
  list.className = 'usage-stages'
  for (const step of usageStageViews(stage)) {
    const item = document.createElement('li')
    item.className = 'usage-stage'
    item.dataset.state = step.state
    const mark = document.createElement('span')
    mark.className = 'usage-stage-mark'
    mark.setAttribute('aria-hidden', 'true')
    if (step.state === 'done') mark.append(icon('check'))
    const text = document.createElement('span')
    text.className = 'usage-stage-text'
    text.append(Object.assign(document.createElement('strong'), { textContent: step.label }))
    text.append(Object.assign(document.createElement('span'), { className: 'usage-stage-detail', textContent: step.detail }))
    item.append(mark, text)
    item.setAttribute('aria-label', `${step.label}：${step.detail}`)
    list.append(item)
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'usage-stages-block'
  wrapper.append(list)
  // 配置被别的工具改过是客户最容易困惑的一种「看着已接入其实没在走」，单独说，并给一个能点的动作。
  const alertText = configurationAlert(stage)
  if (alertText !== null) {
    const alert = document.createElement('div')
    alert.className = 'usage-stage-alert'
    alert.dataset.configuration = stage.configuration
    const message = document.createElement('p')
    message.className = 'platform-notice'
    message.textContent = alertText
    alert.append(message)
    const control = onReapply?.()
    if (control) alert.append(control)
    wrapper.append(alert)
  }
  return wrapper
}
