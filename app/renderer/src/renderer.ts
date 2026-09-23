import { pageRegistry } from './page-registry'
import { startAccountRefreshLoop } from './account-state'
import { mountSupport } from './support-widget'
import { icon, type IconName } from './icons'
import { initializeTheme } from './theme'
import { TAB_NAVIGATION_EVENT, markServiceAvailability, requestedDiagnosticSoftware, requestedTab, requestedModelApiPlatform, requestedModelApiProvider, requestedPlatformDownloadPlatform } from './navigation'
import type { DiagnosticSoftware } from '../../network-diagnostics-types'
import type { SubscriptionCatalog } from '../../subscription-types'
import type { SharingCatalog } from '../../sharing-types'
import type { ModelProviderId } from '../../shared/model-providers'
import { displayReleaseVersion } from '../../release-version'
import { morePlatformEntries, morePlatformTrigger, movePinnedPlatform, nextTabIndex, pinPlatform, pinnedPlatformStorageKey, readPinnedPlatformIds, skeletonTabs, unpinPlatform, usagePlatformLabel, type MorePlatformId, type UsagePlatformId } from './tabs'
import { platformIcon } from './platform-icons'
import './styles.css'
import './brand.css'
import './platform-layout.css'
import { mountDesktopStatus } from './desktop-status'
import { showUpdateSuccessNotice } from './update-success'
import './dashboard.css'
import './network.css'
import './account.css'

initializeTheme()

const tabs = document.querySelector<HTMLElement>('#tabs')
const morePlatformsSlot = document.querySelector<HTMLElement>('#more-platforms-slot')
const panel = document.querySelector<HTMLElement>('#tab-panel')
const pageTitle = document.querySelector<HTMLElement>('#page-title')
const pageBreadcrumb = document.querySelector<HTMLElement>('#page-breadcrumb')
const appState = document.querySelector<HTMLElement>('#app-state')

if (tabs === null || morePlatformsSlot === null || panel === null || pageTitle === null || pageBreadcrumb === null || appState === null) {
  throw new Error('工具箱骨架缺少页签容器。')
}

const tabPanel = panel
const tabContainer = tabs
const headerTitle = pageTitle
const headerBreadcrumb = pageBreadcrumb
const headerAppState = appState
let activeIndex = 0
let activeUsagePlatform: UsagePlatformId = 'codex'
let activePlatformSection: 'model-api' | 'download' | undefined
let activeModelApiProvider: ModelProviderId | undefined
let activeDiagnosticSoftware: DiagnosticSoftware | undefined
let platform = 'loading'
let mountedPages = [] as ReturnType<typeof pageRegistry.modulesFor>
let unmountSupport = (): void => undefined
const tabButtons: HTMLButtonElement[] = []
const tabIcons: Record<(typeof skeletonTabs)[number]['id'], IconName> = {
  dashboard: 'dashboard', tunnel: 'network', usage: 'usage',
  'platform-layout': 'settings', purchase: 'receipt', sharing: 'share', account: 'account', referral: 'gift', settings: 'settings'
}
let previousGroup: (typeof skeletonTabs)[number]['group'] | undefined
for (const [index, tab] of skeletonTabs.entries()) {
  // 邀请有礼上方不加横线：它属于底部三件套，弹性空隙由 #tab-referral 自身吸收。
  if (previousGroup !== undefined && previousGroup !== tab.group && tab.id !== 'referral') {
    const divider = document.createElement('div')
    divider.className = 'nav-divider'
    divider.setAttribute('role', 'presentation')
    tabContainer.append(divider)
  }
  // 底部三件套内部的次级分隔线：邀请有礼 与 我的账号 之间（固定间距，不参与弹性空隙分配）。
  if (tab.id === 'account') {
    const subDivider = document.createElement('div')
    subDivider.className = 'nav-divider nav-divider-sub'
    subDivider.setAttribute('role', 'presentation')
    tabContainer.append(subDivider)
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tab'
  button.hidden = tab.sidebar === false
  button.id = 'tab-' + tab.id
  button.setAttribute('aria-controls', 'tab-panel')
  button.setAttribute('role', 'tab')
  button.setAttribute('aria-label', tab.label)
  button.append(tab.id === 'usage' ? platformIcon('codex') : icon(tabIcons[tab.id]), document.createTextNode(tab.label))
  button.addEventListener('click', () => selectTab(index))
  tabContainer.append(button)
  tabButtons.push(button)
  if (tab.id === morePlatformTrigger.afterTab) {
    const marker = document.createElement('div')
    marker.className = 'more-platforms-marker'
    marker.setAttribute('role', 'presentation')
    tabContainer.append(marker)
    appendMorePlatforms(morePlatformsSlot, marker)
    const divider = document.createElement('div')
    divider.className = 'nav-divider more-platforms-divider'
    divider.setAttribute('role', 'presentation')
    tabContainer.append(divider)
  }
  previousGroup = tab.group
}

function appendMorePlatforms(container: HTMLElement, marker: HTMLElement): void {
  const control = document.createElement('div')
  control.className = 'more-platform-control'
  const pinnedEntries = document.createElement('div')
  pinnedEntries.className = 'pinned-platforms'
  pinnedEntries.setAttribute('role', 'presentation')
  tabContainer.querySelector('#tab-usage')?.after(pinnedEntries)
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.id = 'more-platforms-trigger'
  trigger.className = 'tab more-platforms-trigger'
  trigger.setAttribute('aria-controls', 'more-platforms')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.append(icon('dashboard'), document.createTextNode(morePlatformTrigger.label))

  const popover = document.createElement('section')
  popover.id = 'more-platforms'
  popover.className = 'more-platforms-popover'
  popover.setAttribute('aria-label', '更多平台列表')
  popover.hidden = true
  const list = document.createElement('ul')
  list.className = 'more-platforms-list'
  let draggingPlatformId: MorePlatformId | null = null
  const empty = document.createElement('p')
  empty.textContent = '所有平台都已放在左侧，可拖回这里收起。'
  empty.hidden = true
  const manageLayout = document.createElement('button')
  manageLayout.type = 'button'
  manageLayout.className = 'more-platform-layout-button'
  manageLayout.append(icon('settings'), document.createTextNode('管理平台布局'))
  popover.append(list, empty, manageLayout)
  control.append(trigger, popover)
  container.append(control)

  let expanded = false
  let pinnedIds = readPinnedPlatformIds(window.localStorage)
  const usageIndex = skeletonTabs.findIndex((tab) => tab.id === 'usage')
  const dashboardIndex = skeletonTabs.findIndex((tab) => tab.id === 'dashboard')
  const layoutIndex = skeletonTabs.findIndex((tab) => tab.id === 'platform-layout')
  const positionControl = (): void => {
    const rect = marker.getBoundingClientRect()
    const navRect = tabContainer.getBoundingClientRect()
    container.style.position = 'fixed'
    container.style.top = `${rect.top}px`
    container.style.left = `${rect.left}px`
    container.style.right = 'auto'
    container.style.width = `${rect.width}px`
    container.hidden = rect.bottom <= Math.max(0, navRect.top) || rect.top >= Math.min(window.innerHeight, navRect.bottom)
    if (container.hidden && expanded) setExpanded(false)
  }
  const positionPopover = (): void => {
    if (!expanded) return
    const triggerRect = trigger.getBoundingClientRect()
    const margin = 16
    const left = Math.min(triggerRect.right + 14, window.innerWidth - popover.offsetWidth - margin)
    const top = Math.max(margin, Math.min(triggerRect.top, window.innerHeight - popover.offsetHeight - margin))
    popover.style.left = `${Math.max(margin, left)}px`
    popover.style.top = `${top}px`
  }
  const setExpanded = (value: boolean): void => {
    expanded = value
    trigger.classList.toggle('is-active', value)
    trigger.setAttribute('aria-expanded', String(value))
    popover.hidden = !value
    positionPopover()
  }
  const clearDragState = (): void => {
    pinnedEntries.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after').forEach((entry) => {
      entry.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after')
    })
  }
  const persistPinnedPlatforms = (): void => {
    try {
      window.localStorage.setItem(pinnedPlatformStorageKey, JSON.stringify(pinnedIds))
    } catch {
      // 无法写入本机偏好时，本次窗口仍保留布局结果。
    }
  }
  const renderPinnedPlatforms = (): void => {
    pinnedEntries.replaceChildren()
    for (const platformId of pinnedIds) {
      const platform = morePlatformEntries.find((entry) => entry.id === platformId)
      if (platform === undefined) continue
      const row = document.createElement('div')
      row.className = 'pinned-platform-row'
      row.dataset.pinnedPlatform = platform.id
      row.draggable = true
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tab pinned-platform-entry'
      button.id = `tab-platform-${platform.id}`
      button.dataset.pinnedPlatform = platform.id
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', 'tab-panel')
      button.setAttribute('aria-label', platform.label)
      button.setAttribute('aria-description', '可拖动调整左侧导航顺序')
      button.title = '可拖动调整左侧导航顺序'
      const selected = activeIndex === usageIndex && activeUsagePlatform === platform.id
      button.setAttribute('aria-selected', String(selected))
      button.classList.toggle('is-active', selected)
      button.tabIndex = selected ? 0 : -1
      button.append(platformIcon(platform.id), document.createTextNode(platform.label))
      button.addEventListener('click', () => { setExpanded(false); selectTab(usageIndex, platform.id) })
      // 收回不再放「−」按钮：把平台拖到「更多平台」上即可（键盘 Delete 仍可用）。
      button.title = '拖动可调整顺序；拖到「更多平台」上可收回'
      row.addEventListener('dragstart', (event) => {
        draggingPlatformId = platform.id
        event.dataTransfer?.setData('text/plain', platform.id)
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
        row.classList.add('is-dragging')
      })
      row.addEventListener('dragend', () => {
        draggingPlatformId = null
        clearDragState()
      })
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return
        event.preventDefault()
        removePinnedPlatform(platform.id)
        trigger.focus()
      })
      row.addEventListener('dragover', (event) => {
        if (draggingPlatformId === null || draggingPlatformId === platform.id) return
        event.preventDefault()
        event.stopPropagation()
        const placeAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
        pinnedEntries.querySelectorAll('.is-drop-before, .is-drop-after').forEach((entry) => entry.classList.remove('is-drop-before', 'is-drop-after'))
        row.classList.add(placeAfter ? 'is-drop-after' : 'is-drop-before')
      })
      row.addEventListener('drop', (event) => {
        if (draggingPlatformId === null || draggingPlatformId === platform.id) return
        event.preventDefault()
        event.stopPropagation()
        const placeAfter = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
        pinnedIds = movePinnedPlatform(pinnedIds, draggingPlatformId, platform.id, placeAfter)
        persistPinnedPlatforms()
        renderPinnedPlatforms()
        draggingPlatformId = null
      })
      row.append(button)
      pinnedEntries.append(row)
    }
    pinnedEntries.hidden = pinnedIds.length === 0
    list.replaceChildren()
    for (const platform of morePlatformEntries) {
      if (pinnedIds.includes(platform.id)) continue
      const item = document.createElement('li')
      item.className = 'more-platform-entry'
      item.append(platformIcon(platform.id), Object.assign(document.createElement('span'), { className: 'more-platform-entry-label', textContent: platform.label }))
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'platform-layout-action'
      add.textContent = '+'
      add.title = `将 ${platform.label} 放到左侧导航`
      add.setAttribute('aria-label', `将 ${platform.label} 放到左侧导航`)
      add.addEventListener('click', () => {
        const next = pinPlatform(pinnedIds, platform.id)
        if (next.length === pinnedIds.length) return
        pinnedIds = next
        persistPinnedPlatforms()
        renderPinnedPlatforms()
        pinnedEntries.querySelector<HTMLButtonElement>(`#tab-platform-${platform.id}`)?.focus()
      })
      item.append(add)
      list.append(item)
    }
    empty.hidden = list.childElementCount !== 0
    positionControl()
    positionPopover()
  }
  const removePinnedPlatform = (platformId: MorePlatformId): void => {
    pinnedIds = unpinPlatform(pinnedIds, platformId)
    persistPinnedPlatforms()
    renderPinnedPlatforms()
    if (activeIndex === usageIndex && activeUsagePlatform === platformId) selectTab(dashboardIndex)
  }
  // 拖到「更多平台」（触发器或展开的列表）上松手 = 收回。
  const returnTargets: [HTMLElement, string][] = [[control, 'is-drop-target'], [list, 'is-return-target']]
  for (const [target, className] of returnTargets) {
    target.addEventListener('dragover', (event) => {
      if (draggingPlatformId === null) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      target.classList.add(className)
    })
    target.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
      target.classList.remove(className)
    })
    target.addEventListener('drop', (event) => {
      if (draggingPlatformId === null) return
      event.preventDefault()
      const platformId = draggingPlatformId
      draggingPlatformId = null
      target.classList.remove(className)
      clearDragState()
      removePinnedPlatform(platformId)
      trigger.focus()
    })
  }
  trigger.addEventListener('click', () => setExpanded(!expanded))
  manageLayout.addEventListener('click', () => { setExpanded(false); selectTab(layoutIndex) })
  document.addEventListener('pointerdown', (event) => {
    if (expanded && event.target instanceof Node && !control.contains(event.target) && !pinnedEntries.contains(event.target)) setExpanded(false)
  })
  document.addEventListener('keydown', (event) => {
    if (expanded && event.key === 'Escape') {
      setExpanded(false)
      trigger.focus()
    }
  })
  document.addEventListener('scroll', (event) => {
    if (expanded && event.target !== popover && event.target !== control) setExpanded(false)
    positionControl()
  }, true)
  window.addEventListener('resize', () => {
    positionControl()
    positionPopover()
  })
  tabContainer.addEventListener('scroll', positionControl)
  container.parentElement?.addEventListener('scroll', positionControl)
  persistPinnedPlatforms()
  renderPinnedPlatforms()
  requestAnimationFrame(positionControl)
}

function selectTab(index: number, usagePlatform: UsagePlatformId = 'codex', platformSection?: 'model-api' | 'download', diagnosticSoftware?: DiagnosticSoftware,
  modelApiProvider?: ModelProviderId): void {
  activeIndex = index
  activeUsagePlatform = usagePlatform
  activePlatformSection = platformSection
  activeDiagnosticSoftware = diagnosticSoftware
  activeModelApiProvider = modelApiProvider
  tabButtons.forEach((button, buttonIndex) => {
    const selected = buttonIndex === activeIndex && !button.hidden
    button.classList.toggle('is-active', selected)
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  })
  const activeTab = skeletonTabs[activeIndex]
  tabContainer.querySelectorAll<HTMLButtonElement>('.pinned-platform-entry[data-pinned-platform]').forEach((button) => {
    const selected = activeTab.id === 'usage' && button.dataset.pinnedPlatform === usagePlatform
    button.classList.toggle('is-active', selected)
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  })
  const label = activeTab.id === 'usage' ? usagePlatformLabel(usagePlatform) : activeTab.label
  tabPanel.setAttribute('aria-labelledby', activeTab.sidebar === false ? 'page-title' : activeTab.id === 'usage' ? `tab-platform-${usagePlatform}` : 'tab-' + activeTab.id)
  headerTitle.textContent = label
  headerBreadcrumb.textContent = label
  document.title = '来信 AI 工具箱 · ' + label
  for (const mounted of mountedPages) {
    mounted.unmount()
  }
  unmountSupport()
  tabPanel.replaceChildren()
  // 平台门:darwin 与 win32 全开(win 通道已由 tb-tunnel-win 接入,随试装包验证);未确认平台仍闭。
  const tabUnavailable = platform === 'loading' ||
    (platform !== 'darwin' && platform !== 'win32' && activeTab.id === 'tunnel')
  if (tabUnavailable) {
    const notice = document.createElement('p')
    notice.textContent = platform === 'loading' ? '正在读取软件信息…' : '暂未确认当前系统，请重新打开工具箱。'
    tabPanel.append(notice)
    mountedPages = []
    return
  }
  mountedPages = pageRegistry.modulesFor(activeTab.id)
  for (const page of mountedPages) {
    const section = document.createElement('section')
    section.dataset.moduleId = page.moduleId
    page.mount(section, { tab: activeTab.id, usagePlatform, platformSection, diagnosticSoftware: activeDiagnosticSoftware, modelApiProvider: activeModelApiProvider })
    tabPanel.append(section)
  }
  unmountSupport = mountSupport(tabPanel, activeTab.id)
}

function handleTabKeydown(event: KeyboardEvent): void {
  const buttons = Array.from(tabContainer.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([hidden])'))
  const currentIndex = buttons.findIndex((button) => button === event.target)
  if (currentIndex < 0) return
  const activate = (index: number): void => { buttons[index].click(); buttons[index].focus() }
  if (event.key === 'Home') {
    event.preventDefault()
    activate(0)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    activate(buttons.length - 1)
    return
  }
  const direction: -1 | 1 | undefined =
    event.key === 'ArrowUp' || event.key === 'ArrowLeft'
      ? -1
      : event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : undefined
  if (direction === undefined) {
    return
  }
  event.preventDefault()
  activate(nextTabIndex(currentIndex, direction, buttons.length))
}

tabContainer.addEventListener('keydown', handleTabKeydown)

document.addEventListener(TAB_NAVIGATION_EVENT, (event) => {
  const tab = requestedTab(event)
  if (tab === undefined) {
    return
  }
  const index = skeletonTabs.findIndex((candidate) => candidate.id === tab)
  if (index < 0) {
    return
  }
  const modelApiPlatform = requestedModelApiPlatform(event)
  const downloadPlatform = requestedPlatformDownloadPlatform(event)
  const usagePlatform = modelApiPlatform ?? downloadPlatform ?? 'codex'
  const diagnosticSoftware = requestedDiagnosticSoftware(event)
  selectTab(index, usagePlatform, modelApiPlatform ? 'model-api' : downloadPlatform ? 'download' : undefined, diagnosticSoftware, requestedModelApiProvider(event))
  if (tabButtons[index].hidden) tabPanel.focus()
  else tabButtons[index].focus()
})

selectTab(activeIndex)
void window.toolbox.app.info().then((info) => {
  platform = info.platform
  headerAppState.textContent = displayReleaseVersion(info.version)
  selectTab(activeIndex, activeUsagePlatform, activePlatformSection, undefined, activeModelApiProvider)
  mountDesktopStatus(headerAppState)
  void window.toolbox.desktop?.ready().catch(() => { /* An ordinary launch has no pending update. */ })
  // 「更新成功」弹窗:推送为主(回执可能晚于启动才写好),ready 后再拉一次兜底;弹窗模块自己去重。
  window.toolbox.desktop?.onUpdateSucceeded((notice) => showUpdateSuccessNotice(notice))
  window.toolbox.desktop?.updateSuccess().then((notice) => showUpdateSuccessNotice(notice)).catch(() => { /* Ordinary launch. */ })
  const stopAccountRefresh = startAccountRefreshLoop()
  void window.toolbox.subscription?.catalog().then((response) => {
    if (response.error || !response.data) return
    const catalog = JSON.parse(response.data) as SubscriptionCatalog
    if (Array.isArray(catalog.products)) markServiceAvailability('purchase', !catalog.products.some((product) => product.enabled))
  }).catch(() => { /* Unknown availability stays unlabelled; the service page offers retry. */ })
  void window.toolbox.sharing?.catalog().then((response) => {
    if (response.error || !response.data) return
    const catalog = JSON.parse(response.data) as SharingCatalog
    if (Array.isArray(catalog.listings)) markServiceAvailability('sharing', !catalog.listings.some((listing) => listing.enabled))
  }).catch(() => { /* Unknown availability stays unlabelled; the service page offers retry. */ })
  window.addEventListener('pagehide', stopAccountRefresh, { once: true })
}).catch(() => {
  platform = 'unknown'
  headerAppState.textContent = '客户端信息暂时无法读取'
  selectTab(activeIndex, activeUsagePlatform, activePlatformSection, undefined, activeModelApiProvider)
})
