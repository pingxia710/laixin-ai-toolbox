import configuration from '../../../resources/support-contact.json'
import { mountHelpContact } from './components/help-contact'
import type { TabId } from './tabs'
import type { HelpState } from '../../main/support-contact/help-state'
import type { TunnelStatusView } from '../../preload/api/tunnel'
import { skeletonTabs } from './tabs'

export type StepContext = Pick<HelpState, 'software' | 'cardId' | 'stageCode' | 'reasonCodes'> & { readonly summary?: string }
const stepContexts = new Map<HTMLElement, () => StepContext>()
let reloadSupport: (scroll?: boolean) => void = () => undefined

function networkSupportContext(status: TunnelStatusView | undefined): Pick<HelpState, 'channelStatus' | 'reasonCodes'> {
  if (!status) return { channelStatus: '未知', reasonCodes: ['NETWORK_STATUS_UNAVAILABLE'] }
  const channelStatus = status.state === '已连' ? '已连'
    : ['未连', '未配置', '已断', '用户主动断开', '已停止并恢复原设置'].includes(status.state) ? '未连' : '未知'
  const reasonCodes: string[] = []
  if (status.unrestored) reasonCodes.push('NETWORK_RESTORE_INCOMPLETE')
  else if (status.state === '已停止并恢复原设置') reasonCodes.push('NETWORK_RESTORED')
  else if (status.state === '用户主动断开') reasonCodes.push('NETWORK_RESTORE_PENDING')
  if (status.componentMissing) reasonCodes.push('NETWORK_COMPONENT_MISSING')
  if (status.authorization === '等待重新确认账号权益') reasonCodes.push('NETWORK_ACCOUNT_RECHECK')
  if (status.authorization === '保留先前连接，等待重新核验') reasonCodes.push('NETWORK_ACCOUNT_LEASE')
  if (status.state === '通道待确认') reasonCodes.push('NETWORK_PROBE_UNCONFIRMED')
  // Only fixed categories leave the device; raw messages can contain paths or credentials.
  const categories: readonly [RegExp, string][] = [
    [/记录损坏|记录.*无法读取/, 'NETWORK_RECORD_INVALID'],
    [/系统代理设置未生效|TUNNEL_SETTINGS_NOT_APPLIED/, 'NETWORK_PROXY_NOT_APPLIED'],
    [/检测到其他代理|已有代理控制/, 'NETWORK_PROXY_CONFLICT'],
    [/端口.*占用/, 'NETWORK_PORT_CONFLICT'],
    [/节点身份/, 'NETWORK_NODE_IDENTITY'],
    [/授权已失效|授权失效|当前权益不可用|配额或授权问题/, 'NETWORK_AUTHORIZATION_UNAVAILABLE'],
    [/受组织策略或权限限制|受管理环境/, 'NETWORK_ENVIRONMENT_RESTRICTED'],
    [/已停止自动重连/, 'NETWORK_RECONNECT_STOPPED'],
    [/守护进程意外退出|未预期的问题/, 'NETWORK_PROCESS_EXIT']
  ]
  for (const [pattern, code] of categories) if (pattern.test(`${status.message}\n${status.unrestored}`)) reasonCodes.push(code)
  if (status.state === '异常' && reasonCodes.length === 0) reasonCodes.push('NETWORK_CONNECTION_ERROR')
  return { channelStatus, reasonCodes }
}

export function registerSupportContext(element: HTMLElement, read: () => StepContext): () => void {
  stepContexts.set(element, read)
  return () => { stepContexts.delete(element) }
}

export function refreshSupportContext(): void {
  reloadSupport()
}

function visibleStep(): StepContext | undefined {
  for (const [element, read] of stepContexts) {
    if (element.isConnected && !element.closest('[hidden]')) return read()
  }
  return undefined
}

export function revealSupport(): void {
  const details = document.querySelector<HTMLDetailsElement>('#tab-panel > .support-contact')
  if (!details) return
  const wasOpen = details.open
  details.open = true
  if (wasOpen) reloadSupport(true)
  details.scrollIntoView({ block: 'nearest' })
  details.querySelector('summary')?.focus()
}

export function mountSupport(element: HTMLElement, tab: TabId): () => void {
  let active = true; let cleanup = (): void => undefined; let request = 0
  const details = document.createElement('details'); details.className = 'support-contact'
  const summary = document.createElement('summary'); summary.textContent = '需要帮助？联系来信客服'
  const body = document.createElement('div'); body.className = 'support-content'; details.append(summary, body); element.append(details)
  const load = (scroll = false) => {
    if (!active || !details.open) return
    const version = ++request
    cleanup()
    const step = visibleStep()
    body.textContent = '正在读取当前步骤…'
    void Promise.allSettled([window.toolbox.app.info(), window.toolbox.tunnel.status(), window.toolbox.account.supportContext()]).then(([info, tunnel, account]) => {
      if (!active || version !== request) return
      const app = info.status === 'fulfilled' ? info.value : undefined
      const network = networkSupportContext(tunnel.status === 'fulfilled' ? tunnel.value : undefined)
      cleanup = mountHelpContact(body, { configuration, state: {
        ...(account.status === 'fulfilled' ? account.value : {}),
        software: tab, cardId: tab, stageCode: 'HELP', ...step,
        reasonCodes: [...new Set([...(step?.reasonCodes.length ? step.reasonCodes : ['USER_HELP_REQUESTED']), ...network.reasonCodes])], platform: app?.platform ?? '未知',
        channelStatus: network.channelStatus,
        systemVersion: '未知', toolboxVersion: app?.version ?? '未知'
      } }, { openContact: () => window.toolbox.support.open() })
      const context = document.createElement('p'); context.className = 'support-context'
      context.textContent = step?.summary ?? `当前页面：${skeletonTabs.find((item) => item.id === tab)?.label ?? tab}`
      body.prepend(context)
      if (scroll) body.scrollIntoView({ block: 'nearest' })
    })
  }
  reloadSupport = load
  const onToggle = () => load(true)
  details.addEventListener('toggle', onToggle)
  return () => { active = false; request++; cleanup(); details.removeEventListener('toggle', onToggle); if (reloadSupport === load) reloadSupport = () => undefined }
}
