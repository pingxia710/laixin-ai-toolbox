import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { UsageSnapshot } from '../../../main/codex-usage/types'
import type { AiAccessStatus } from '../../../main/ai-access/service'
import { readAccessStatus } from './access-status'
import { platformIcon } from '../platform-icons'
import { usagePlatformLabel, type UsagePlatformId } from '../tabs'
import { accessShell, selectedModelApiProvider } from './model'
import { isProviderShellSupported, modelProviderIds, modelProviders } from '../../../shared/model-providers'
import type { ApiUsageStage, ModelProviderId } from '../../../shared/api-service-types'
import { providerIcons, serviceButtons } from './api-service'
import { readUsageStages, usageStageFor, usageStages } from './usage-stages'
import { icon } from '../icons'
import { mountOfficialAccount } from './official-account'

export type AccountSummary = Pick<UsageSnapshot, 'accountLabel' | 'plan'>
export type MountUsage = (root: HTMLElement, onAccount?: (account: AccountSummary | null) => void, onSignedOut?: () => void, accountKey?: string) => () => void

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}

export function mountAccountOverview(element: HTMLElement, platform: UsagePlatformId, api: AiAccessApi | undefined, mountUsage: MountUsage, openModelApi: () => void): () => void {
  const shell = accessShell(platform)!
  let mounted = true
  let currentApi: ModelProviderId = 'deepseek'
  let status: AiAccessStatus | null = null
  let manuallyViewed = false
  let balanceRequest = 0
  const root = node('div', '', 'platform-overview platform-account-overview')
  const notice = node('p', '正在读取模型配置…', 'platform-muted platform-overview-notice')
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  element.append(notice, root)

  const card = (provider: 'deepseek' | 'official', label: string, icon: UsagePlatformId, subtitle: string) => {
    const section = node('section', '', 'platform-card platform-account-card'); section.dataset.accountProvider = provider
    const header = node('header', '', 'account-card-header')
    const brand = node('div', '', 'account-card-brand')
    const title = node('h2', label)
    brand.append(platformIcon(icon), title)
    const badge = node('span', '', 'platform-badge'); badge.hidden = true
    header.append(brand, badge)
    const body = node('div', '', 'account-card-body')
    const footer = node('footer', '', 'account-card-footer')
    const button = node('button', provider === 'deepseek' ? '配置 DeepSeek API' : '管理官方套餐', 'secondary-action')
    button.type = 'button'; button.onclick = openModelApi
    footer.append(button)
    section.append(header, node('p', subtitle, 'platform-muted account-card-subtitle'), body, footer)
    root.append(section)
    return { section, brand, title, badge, body, footer, button }
  }

  const deepseek = card('deepseek', 'DeepSeek API', 'deepseek-harness', '自带 Key · 按 API 用量计费')
  const picker = node('div', '', 'account-api-picker')
  const trigger = node('button', '', 'account-api-trigger'); trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', '查看 API：DeepSeek API')
  const selectedName = node('span', 'DeepSeek API')
  const chevron = node('span', '', 'account-api-chevron'); chevron.setAttribute('aria-hidden', 'true')
  trigger.append(platformIcon('deepseek-harness'), selectedName, chevron)
  deepseek.title.replaceChildren(trigger); picker.append(deepseek.title); deepseek.brand.replaceWith(picker)
  const menu = node('div', '', 'account-api-menu'); menu.id = `account-api-menu-${shell}`; menu.hidden = true
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '选择要查看的 API')
  trigger.setAttribute('aria-controls', menu.id)
  const choices = modelProviderIds.map(provider => {
    const choice = node('button', '', 'account-api-choice'); choice.type = 'button'; choice.tabIndex = -1
    choice.dataset.provider = provider; choice.setAttribute('role', 'menuitemradio')
    choice.setAttribute('aria-label', modelProviders[provider].title); choice.setAttribute('aria-checked', String(provider === currentApi))
    const check = icon('check'); check.classList.add('account-api-choice-check')
    choice.append(platformIcon(providerIcons[provider]), node('span', modelProviders[provider].title), check)
    choice.onclick = () => { manuallyViewed = true; showProvider(provider); closeMenu(true) }
    menu.append(choice); return choice
  })
  picker.append(menu)
  const closeMenu = (focus = false): void => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus() }
  const openMenu = (): void => {
    menu.hidden = false; trigger.setAttribute('aria-expanded', 'true')
    choices.find(choice => choice.dataset.provider === currentApi)?.focus()
  }
  trigger.onclick = () => { if (menu.hidden) openMenu(); else closeMenu() }
  trigger.onkeydown = event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu() } }
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return }
    if (event.key === 'Tab') { closeMenu(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = choices.findIndex(choice => choice === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
    choices[next].focus()
  }
  const dismissMenu = (event: PointerEvent): void => { if (event.target instanceof Node && !picker.contains(event.target)) closeMenu() }
  document.addEventListener('pointerdown', dismissMenu)
  picker.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !picker.contains(event.relatedTarget)) closeMenu() })
  const facts = node('dl', '', 'platform-facts account-api-facts')
  const keyState = node('dd', '正在读取…')
  const billing = node('dd', '按量计费')
  for (const [label, value] of [['API Key', keyState], ['计费方式', billing]] as const) {
    const row = node('div'); row.append(node('dt', label), value); facts.append(row)
  }
  const balance = node('div', '', 'account-api-balance')
  const balanceValue = node('strong', '余额读取中…'), balanceNote = node('p', '', 'platform-muted'), peakNote = node('p', '', 'platform-muted account-peak-note')
  balance.append(node('span', 'API 余额', 'account-card-eyebrow'), balanceValue, balanceNote, peakNote)
  const readBalance = async (provider: ModelProviderId): Promise<void> => {
    const request = ++balanceRequest
    balanceValue.textContent = '余额读取中…'; balanceNote.textContent = ''; peakNote.textContent = ''; peakNote.hidden = true
    if (!api?.providerBalance) { balanceValue.textContent = '余额未读到'; balanceNote.textContent = '暂时无法读取余额。'; return }
    try {
      const value = JSON.parse((await api.providerBalance({ shell, provider })).snapshot) as { supported: boolean; total: number | null; currency: string; error?: string; peak: { peak: boolean; label: string } | null }
      if (!mounted || currentApi !== provider || request !== balanceRequest) return
      if (!value.supported) { balanceValue.textContent = '以控制台为准'; balanceNote.textContent = '这家服务商没有余额查询接口，余额和账单请在它的控制台查看。' }
      else if (value.total !== null) { balanceValue.textContent = `${value.total.toFixed(2)} ${value.currency || ''}`.trim(); balanceNote.textContent = value.total <= 5 ? '余额偏低，用完会提示 402，请及时充值。' : '来自服务商余额接口，官方套餐与 API 用量分别计算。' }
      else { balanceValue.textContent = '余额未读到'; balanceNote.textContent = value.error === 'key_missing' ? '先添加这个入口的 Key。' : value.error === 'key_rejected' ? 'Key 未通过服务商认证，请检查后重新添加。' : value.error === 'network_error' ? '未连上服务商，请检查网络后刷新。' : '服务商没有返回有效余额。' }
      peakNote.textContent = value.peak ? value.peak.label : ''
      peakNote.hidden = !value.peak
    } catch { if (mounted && currentApi === provider && request === balanceRequest) { balanceValue.textContent = '余额未读到'; balanceNote.textContent = '暂时无法读取余额。' } }
  }
  // 「接口测试过 / 配置已写 / 已观察到软件调用」三个小勾：客户在总览这一屏就知道配置到底生效没有。
  // 服务快照只读一次（挂载时），⛔ 在总览页轮询主进程；三步的判断复用 usage-stages，⛔ 另写一份。
  const stagesBlock = node('div', '', 'account-card-stages'); stagesBlock.hidden = true
  let stages: readonly ApiUsageStage[] = []
  const renderStages = (): void => {
    const stage = usageStageFor(stages, shell, currentApi)
    const block = stage ? usageStages(stage) : null
    stagesBlock.replaceChildren(...(block ? [block] : []))
    stagesBlock.hidden = block === null
  }
  deepseek.body.append(facts, balance, stagesBlock)
  let closeService = (): void => undefined
  const mountServiceButtons = (): void => {
    closeService()
    closeService = serviceButtons(deepseek.footer, api, shell, () => currentApi)
    const serviceEntry = deepseek.footer.querySelector('.api-service-entry')
    if (serviceEntry) deepseek.footer.insertBefore(serviceEntry, deepseek.footer.firstElementChild)
  }
  mountServiceButtons()

  let stopUsage = (): void => undefined
  const official = shell === 'hermes' ? null : card('official', `${usagePlatformLabel(platform)} 官方套餐`, platform, shell === 'codex' ? 'ChatGPT 官方套餐 · 套餐额度' : 'Claude 官方套餐 · 套餐额度')
  if (official) {
    const plan = node('span', '', 'usage-plan'); plan.hidden = true
    official.body.classList.add('platform-usage-card')
    official.section.querySelector('.account-card-subtitle')!.append(plan)
    const accountLabel = node('p', '', 'platform-muted account-card-identity'); accountLabel.hidden = true
    official.body.before(accountLabel)
    stopUsage = mountOfficialAccount(official.body, official.footer, shell as 'codex' | 'claude', window.toolbox.officialaccount, api, mountUsage, account => {
      if (!mounted) return
      accountLabel.textContent = account?.accountLabel ?? ''; accountLabel.hidden = !account?.accountLabel
      plan.textContent = account?.plan ?? ''; plan.hidden = !account?.plan
    }, () => { void read() })
  } else deepseek.footer.prepend(node('p', 'Hermes 没有官方模型套餐，使用所接入服务商的 API。', 'platform-muted'))

  const showProvider = (provider: ModelProviderId): void => {
    currentApi = provider
    const definition = modelProviders[currentApi]
    selectedName.textContent = definition.title
    trigger.setAttribute('aria-label', `查看 API：${definition.title}`)
    deepseek.section.dataset.accountProvider = currentApi
    trigger.querySelector('.platform-logo')?.replaceWith(platformIcon(providerIcons[currentApi]))
    choices.forEach(choice => choice.setAttribute('aria-checked', String(choice.dataset.provider === currentApi)))
    deepseek.section.querySelector('.account-card-subtitle')!.textContent = definition.billingHint
    deepseek.button.textContent = `配置 ${definition.title}`
    mountServiceButtons()
    void readBalance(currentApi)
    keyState.textContent = status ? status.shells[shell].providerKeys[currentApi] ? '已为此 AI 保存在本机' : '尚未添加' : '暂时无法读取'
    billing.textContent = definition.billingHint
    for (const [provider, entry] of [['deepseek', deepseek], ['official', official]] as const) {
      if (!entry) continue
      const selected = status?.shells[shell].suspended === undefined && status?.shells[shell].interrupted === undefined &&
        status?.shells[shell].selected === (provider === 'deepseek' ? currentApi : provider)
      entry.section.classList.toggle('is-selected', selected)
      entry.badge.classList.toggle('is-current', selected)
      entry.badge.hidden = !selected; entry.badge.textContent = '当前配置'
    }
    renderStages()
    if (manuallyViewed && !isProviderShellSupported(currentApi, shell)) {
      notice.textContent = `${definition.title} 尚未完成 ${usagePlatformLabel(platform)} 原生验证，工具箱不会测试或启用这条配置。`
    }
  }
  const readStages = async (): Promise<void> => {
    if (!api?.serviceStatus) return
    // 读不到就不显示这一块，⛔ 让整张卡片报错——余额与 Key 状态照旧。
    try { stages = readUsageStages((JSON.parse((await api.serviceStatus()).snapshot) as { usage?: unknown }).usage) } catch { stages = [] }
    if (mounted) renderStages()
  }
  const read = async (): Promise<void> => {
    try {
      if (!api) throw new Error('API_UNAVAILABLE')
      const result = readAccessStatus((await api.status()).snapshot)
      if (!mounted) return
      status = result
      showProvider(manuallyViewed ? currentApi : selectedModelApiProvider(platform, status) ?? 'deepseek')
      const suspended = status.shells[shell].suspended
      const interrupted = status.shells[shell].interrupted
      notice.textContent = suspended ? `历史 ${modelProviders[suspended.provider].title} ${usagePlatformLabel(platform)} 接入已暂停，当前不再使用工具箱 API。请选择已验收入口或解除工具箱接管。`
        : interrupted ? `${modelProviders[interrupted.provider].title} ${usagePlatformLabel(platform)} 配置更新未完成，路由已暂停。请到“模型 API”重新启用，或恢复官方。`
        : status.shells[shell].legacyDirect ? `检测到旧版 ${modelProviders[status.shells[shell].legacyDirect.provider].title} 直连记录；当前工具箱未接管该路由。请到“模型 API”确认后启用。`
        : status.shells[shell].selected === 'zai' ? '旧国际站配置不能用于国内智谱，请到“模型 API”重新添加国内 Key。'
        : '下拉可查看各家 API；实际启用请到“模型 API”。API 与官方套餐分别计费。'
    } catch {
      if (!mounted) return
      status = null
      showProvider(currentApi)
      keyState.textContent = '暂时无法读取'
      notice.textContent = '暂时无法读取模型配置，请在“模型 API”中重试。官方套餐用量独立显示。'
    }
  }
  void read()
  void readStages()
  return () => { mounted = false; document.removeEventListener('pointerdown', dismissMenu); stopUsage(); closeService(); element.replaceChildren() }
}
