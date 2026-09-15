import type { TunnelStatusView } from '../../../preload/api/tunnel'
import { requestTabNavigation, requestModelApiNavigation, requestPlatformDownloadNavigation } from '../navigation'
import type { TabId } from '../tabs'
import type { PageModule } from './types'
import { accountAction, accountSnapshot, onAccountChange, refreshAccount, requireAccount } from '../account-state'
import { mountTrafficSummary } from '../ui/account-overview'
import { icon, type IconName } from '../icons'
import { platformIcon } from '../platform-icons'
import { buildNetworkOnboarding, renderNetworkOnboarding, type NetworkOnboardingView, type OnboardingAction } from '../ui/network-onboarding'
import { revealSupport } from '../support-widget'
import { buildTunnelPresentation, mountTunnelDetails, page as networkPage } from './tunnel'
import { observeNetworkActivity, refreshNetworkActivity, renderTrafficMeter, type NetworkActivity } from '../ui/network-activity'
import { page as networkDiagnosticsPage } from './network-diagnostics'

export type DashboardLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly status: TunnelStatusView }

export interface DashboardView {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly actionLabel: string
  readonly actionTab: TabId
  readonly configVersion: string
  readonly lastVerifiedAt: string
}

export const apiKeyGuideEntries = [
  { id: 'codex', label: 'Codex', description: '用自己的 API KEY 接入 Codex。' },
  { id: 'claude-code', label: 'Claude Code', description: '用自己的 API KEY 接入 Claude Code。' },
  { id: 'hermes', label: 'Hermes', description: '用自己的 API KEY 接入 Hermes。' }
] as const

export function buildDashboardView(state: DashboardLoadState): DashboardView {
  if (state.kind === 'loading') {
    return {
      eyebrow: '网络状态',
      title: '正在读取当前状态',
      description: '工具箱正在检查网络服务，完成前不会把状态显示为成功。',
      actionLabel: '查看网络',
      actionTab: 'tunnel',
      configVersion: '尚未取得',
      lastVerifiedAt: '尚未取得'
    }
  }
  if (state.kind === 'unavailable') {
    return {
      eyebrow: '网络状态',
      title: '暂时无法确认网络状态',
      description: '请到网络页重新读取状态；未取得结果时不会显示剩余流量或连接成功。',
      actionLabel: '重新查看网络',
      actionTab: 'tunnel',
      configVersion: '尚未取得',
      lastVerifiedAt: '尚未取得'
    }
  }

  const { status } = state
  if (status.state === '已连') {
    return {
      eyebrow: '网络状态',
      title: '网络已连接',
      description: status.message || '网络服务已通过工具箱复验，可以继续使用 AI 或查看 Codex 下载与版本。',
      actionLabel: '查看 Codex 下载/版本',
      actionTab: 'usage',
      configVersion: status.configVersion || '尚未取得',
      lastVerifiedAt: status.lastVerifiedAt || '尚未复验'
    }
  }
  if (status.state === '未配置') {
    return {
      eyebrow: '网络状态',
      title: '还没有配置网络',
      description: '登录来信账号，主动领取体验流量或领取已开通的套餐配置；也可以导入已有的来信配置包。',
      actionLabel: '前往配置网络',
      actionTab: 'tunnel',
      configVersion: status.configVersion || '尚未应用',
      lastVerifiedAt: status.lastVerifiedAt || '尚未复验'
    }
  }
  return {
    eyebrow: '网络状态',
    title: status.state || '暂时无法确认网络状态',
    description: status.message || '请先查看网络页中的实际状态和可用操作。',
    actionLabel: '查看网络状态',
    actionTab: 'tunnel',
    configVersion: status.configVersion || '尚未取得',
    lastVerifiedAt: status.lastVerifiedAt || '尚未复验'
  }
}

function mountOverview(element: HTMLElement, showNetwork: () => void): () => void {
    let mounted = true
    let state: NetworkActivity = { kind: 'loading', samples: [] }
    let lastRender = ''
    let busy = false
    let networkMessage = ''
    let onboardingMessage = ''
    let selectedStep: NetworkOnboardingView['step'] | undefined

    const render = (): void => {
      if (!mounted) {
        return
      }
      const key = JSON.stringify([state.kind === 'ready' ? { ...state.status, traffic: undefined } : state.kind, accountSnapshot(), busy, networkMessage, onboardingMessage, selectedStep])
      if (key === lastRender) return
      lastRender = key
      const focused = document.activeElement instanceof HTMLElement && element.contains(document.activeElement)
        ? document.activeElement : undefined
      const focusedStep = focused?.dataset.onboardingStep
      const focusedAction = focused?.dataset.onboardingAction
      const focusedLabel = focused?.getAttribute('aria-label')
      const guide = document.createElement('section')
      const guideView = buildNetworkOnboarding(accountSnapshot(), state.kind === 'ready' ? state.status : state.kind === 'loading' ? undefined : null)
      renderNetworkOnboarding(guide, guideView, busy, onboardingMessage, (action) => { void runOnboarding(action) }, (step) => {
        selectedStep = step === guideView.step ? undefined : step; render()
      }, selectedStep)
      guide.classList.add('dashboard-guide')
      const view = buildDashboardView(state)
      const presentation = buildTunnelPresentation(state.kind === 'ready' ? state.status : undefined)
      const eyebrow = document.createElement('p')
      eyebrow.className = 'section-eyebrow'
      eyebrow.textContent = view.eyebrow
      const title = document.createElement('h2')
      title.textContent = state.kind === 'ready' ? presentation.primaryAction === 'guide' ? '尚未配置' : presentation.headline : state.kind === 'loading' ? '正在读取' : '状态待确认'
      const description = document.createElement('p')
      description.className = 'dashboard-description'
      description.textContent = state.kind === 'ready' ? presentation.hint : view.description
      const action = document.createElement('button'); action.type = 'button'; action.className = 'dashboard-power'
      action.append(icon('power'))
      const actionLabel = state.kind === 'unavailable' ? '重新读取状态' : presentation.primaryLabel
      action.setAttribute('aria-label', actionLabel); action.title = actionLabel
      action.disabled = busy || state.kind === 'loading' || (state.kind === 'ready' && presentation.primaryAction === 'none')
      action.addEventListener('click', () => { void runNetworkAction() })
      const power = document.createElement('div'); power.className = 'dashboard-power-wrap'
      power.append(action, Object.assign(document.createElement('span'), { textContent: busy ? '正在处理' : presentation.primaryAction === 'guide' ? '配置网络' : actionLabel }))
      const copy = document.createElement('div'); copy.className = 'dashboard-connection-copy'
      copy.append(eyebrow, title, description)
      const primary = document.createElement('section')
      primary.className = 'dashboard-primary'
      primary.dataset.tone = state.kind === 'ready' ? presentation.tone : 'neutral'
      primary.setAttribute('aria-live', 'polite')
      primary.append(power, copy)
      if (networkMessage) primary.append(Object.assign(document.createElement('p'), { className: 'dashboard-action-feedback', textContent: networkMessage }))

      const node = document.createElement('section'); node.className = 'dashboard-node'
      const nodeLabel = Object.assign(document.createElement('p'), { className: 'activity-label', textContent: '当前节点' })
      const nodeName = Object.assign(document.createElement('h3'), { textContent: state.kind === 'ready' ? state.status.nodeLabel || '尚未配置节点' : '尚未取得' })
      const details = document.createElement('dl'); details.className = 'dashboard-facts'
      details.append(fact('配置版本', view.configVersion), fact('最近复验', view.lastVerifiedAt))
      const networkDetails = document.createElement('button'); networkDetails.type = 'button'; networkDetails.className = 'text-action'
      networkDetails.textContent = '查看网络详情'; networkDetails.setAttribute('aria-label', '查看网络详情')
      networkDetails.addEventListener('click', showNetwork)
      node.append(nodeLabel, nodeName, details, networkDetails)
      const rates = document.createElement('section'); rates.className = 'dashboard-rates'
      renderTrafficMeter(rates, state)
      const summary = document.createElement('div'); summary.className = 'dashboard-summary'
      summary.append(primary, node, rates)

      const installation = secondaryCard(
        'Codex 下载与版本',
        '查看本机版本，或打开 Codex 官方下载页。',
        '查看 Codex 下载/版本',
        'download',
        () => requestPlatformDownloadNavigation('codex')
      )
      const account = secondaryCard(
        'AI 账号用量',
        '查看本机 Codex 账号的剩余额度、周期和重置时间。',
        '查看 AI 用量',
        'usage',
        () => requestTabNavigation('usage')
      )
      const support = secondaryCard(
        '客服帮助',
        '需要帮助时，可打开企业微信客服或用手机扫码。',
        '查看客服入口',
        'help',
        () => revealSupport()
      )
      const secondary = document.createElement('div')
      secondary.className = 'dashboard-secondary'
      secondary.append(installation, account, support)
      const traffic = document.createElement('section')
      traffic.className = 'dashboard-traffic'
      mountTrafficSummary(traffic, accountSnapshot())
      const layout = document.createElement('div'); layout.className = 'dashboard-middle'
      layout.append(traffic, guide)
      const apiKeyGuide = renderApiKeyGuide()
      element.classList.add('dashboard-console')
      element.replaceChildren(summary, layout, apiKeyGuide, secondary)
      if (focusedStep) guide.querySelector<HTMLButtonElement>(`button[data-onboarding-step="${focusedStep}"]`)?.focus()
      else if (focusedAction) guide.querySelector<HTMLButtonElement>('button[data-onboarding-action]:not(:disabled)')?.focus()
      else if (focusedLabel) Array.from(element.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find((button) => button.getAttribute('aria-label') === focusedLabel)?.focus({ preventScroll: true })
    }

    const runNetworkAction = async (): Promise<void> => {
      if (busy) return
      if (state.kind !== 'ready') { await refreshNetworkActivity(); return }
      const action = buildTunnelPresentation(state.status).primaryAction
      if (action === 'none') return
      if (action === 'guide') {
        const next = element.querySelector<HTMLButtonElement>('[data-onboarding-action]:not(:disabled)')
        next?.focus()
        next?.scrollIntoView({ block: 'center' })
        return
      }
      if (action === 'support') { revealSupport(); return }
      busy = true; networkMessage = ''; render()
      try {
        const result = await (action === 'sync' ? window.toolbox.tunnel.syncAccountConfig() : action === 'import' ? window.toolbox.tunnel.importConfig() : action === 'stop' ? window.toolbox.tunnel.stop() : window.toolbox.tunnel.start())
        if (mounted) networkMessage = result.message
      } catch { if (mounted) networkMessage = '操作没有完成，请重试或查看网络详情。' }
      finally { if (mounted) { busy = false; await refreshNetworkActivity(); render() } }
    }

    const runOnboarding = async (action: OnboardingAction): Promise<void> => {
      if (action === 'support') { revealSupport(); return }
      if (busy || action === 'none') return
      if (action === 'register') { requireAccount('dashboard', undefined, action); return }
      if (action === 'account') { requireAccount('dashboard'); return }
      if (action === 'tunnel') { showNetwork(); return }
      if (action === 'download') { requestPlatformDownloadNavigation('codex'); return }
      busy = true; onboardingMessage = ''; render()
      try {
        if (action === 'claim') {
          const result = await accountAction(() => window.toolbox.account.claimTrial())
          if (mounted) onboardingMessage = result.message
        } else if (action === 'refresh') await refreshAccount()
        else {
          const result = await (action === 'sync' ? window.toolbox.tunnel.syncAccountConfig() : window.toolbox.tunnel.start())
          if (mounted && (result.outcome === 'rejected' || result.outcome === 'cancelled')) onboardingMessage = result.message
        }
      } catch {
        if (mounted) onboardingMessage = '这一步没有完成，请重试；仍有问题可以联系来信客服。'
      } finally {
        if (mounted) { busy = false; await refreshNetworkActivity(); render() }
      }
    }

    render()
    const stopAccount = onAccountChange(() => render())
    const stopNetwork = observeNetworkActivity((value) => {
      if (!mounted) return
      state = value; render()
      const meter = element.querySelector<HTMLElement>('.dashboard-rates')
      if (meter) renderTrafficMeter(meter, state)
    })
    return () => {
      mounted = false
      stopAccount()
      stopNetwork()
    }
}

let stopWorkspace = (): void => undefined

export const page: PageModule = {
  moduleId: 'dashboard.overview', tab: 'dashboard', order: 0,
  mount: (element) => {
    stopWorkspace()
    element.className = 'dashboard-workspace'
    const switcher = document.createElement('div'); switcher.className = 'dashboard-view-switch'
    switcher.setAttribute('role', 'tablist'); switcher.setAttribute('aria-label', '仪表盘视图')
    const content = document.createElement('section'); content.id = 'dashboard-view-content'
    content.setAttribute('role', 'tabpanel'); content.tabIndex = 0
    const views = [['overview', '仪表盘'], ['network', 'AI网络配置']] as const
    type View = typeof views[number][0]
    let selected: View | undefined
    let stopView = (): void => undefined
    const buttons = views.map(([view, label]) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label
      button.id = `dashboard-view-${view}`; button.dataset.dashboardView = view
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', content.id)
      button.addEventListener('click', () => select(view))
      switcher.append(button)
      return button
    })
    const select = (view: View): void => {
      if (selected === view) return
      stopView(); selected = view
      for (const button of buttons) {
        const active = button.dataset.dashboardView === view
        button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1
      }
      content.className = view === 'network' ? 'dashboard-network-view' : ''
      content.dataset.dashboardScreen = view
      content.setAttribute('aria-labelledby', `dashboard-view-${view}`)
      content.replaceChildren()
      if (view === 'overview') {
        const overview = document.createElement('section'); content.append(overview)
        stopView = mountOverview(overview, () => select('network'))
      } else {
        const network = document.createElement('section')
        const details = document.createElement('section')
        const diagnostics = document.createElement('section')
        content.append(network, diagnostics, details)
        networkPage.mount(network, { tab: 'tunnel' })
        networkDiagnosticsPage.mount(diagnostics, { tab: 'tunnel' })
        const stopDetails = mountTunnelDetails(details)
        stopView = () => { stopDetails(); networkDiagnosticsPage.unmount(); networkPage.unmount() }
      }
    }
    switcher.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : selected === 'overview' ? 1 : 0
      select(views[index][0]); buttons[index].focus()
    })
    element.replaceChildren(switcher, content)
    select('overview')
    stopWorkspace = () => { stopView(); stopView = () => undefined }
  },
  unmount: () => stopWorkspace()
}

function renderApiKeyGuide(): HTMLElement {
  const guide = document.createElement('section')
  guide.className = 'api-key-guide'
  const heading = document.createElement('div')
  heading.className = 'api-key-guide-heading'
  const title = document.createElement('h2')
  title.textContent = '接入 API KEY'
  const description = document.createElement('p')
  description.textContent = '选择要使用的 AI，按对应入口完成接入。'
  heading.append(title, description)
  const list = document.createElement('div')
  list.className = 'api-key-guide-list'
  for (const entry of apiKeyGuideEntries) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'api-key-guide-card'
    card.dataset.apiKeyShell = entry.id
    card.setAttribute('aria-label', `接入 ${entry.label} 的 API KEY`)
    const mark = document.createElement('span')
    mark.className = 'api-key-guide-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.append(platformIcon(entry.id))
    const copy = document.createElement('span')
    copy.className = 'api-key-guide-copy'
    const label = document.createElement('strong')
    label.textContent = entry.label
    const detail = document.createElement('span')
    detail.textContent = entry.description
    copy.append(label, detail)
    card.append(mark, copy)
    card.addEventListener('click', () => requestModelApiNavigation(entry.id))
    list.append(card)
  }
  guide.append(heading, list)
  return guide
}

function fact(label: string, value: string): HTMLElement {
  const row = document.createElement('div')
  const term = document.createElement('dt')
  term.textContent = label
  const detail = document.createElement('dd')
  detail.textContent = value
  row.append(term, detail)
  return row
}

function secondaryCard(
  titleText: string,
  descriptionText: string,
  actionLabel: string | undefined,
  iconName: IconName,
  activate: (() => void) | undefined
): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'dashboard-card'
  const title = document.createElement('strong'); title.className = 'dashboard-card-title'
  title.textContent = titleText
  const description = document.createElement('span'); description.className = 'dashboard-card-description'
  description.textContent = descriptionText
  const copy = document.createElement('span'); copy.className = 'dashboard-card-copy'
  copy.append(title, description)
  card.append(icon(iconName), copy)
  if (actionLabel !== undefined && activate !== undefined) {
    card.setAttribute('aria-label', actionLabel)
    card.append(Object.assign(document.createElement('span'), { className: 'dashboard-card-arrow', textContent: '→' }))
    card.addEventListener('click', activate)
  }
  return card
}
