import { installNetworkGateCopy } from '../../../commercial-copy'
import { accountSnapshot } from '../account-state'
import { requestTabNavigation } from '../navigation'
import { icon } from '../icons'
import { platformIcon } from '../platform-icons'
import type { UsagePlatformId } from '../tabs'

export interface OfficialInstallPlatform {
  readonly id: 'codex' | 'claude-code' | 'hermes' | 'deepseek-harness' | 'zcode' | 'kimi-code'
  readonly label: string
  readonly description: string
  readonly resourceId: string
  readonly githubResourceId?: string
  readonly connectsInToolbox: boolean
}

export const officialInstallPlatforms: readonly OfficialInstallPlatform[] = [
  { id: 'codex', label: 'Codex', description: '官方桌面应用或命令行。装好后可在工具箱接入 DeepSeek，或登录自己的 ChatGPT 账号。', resourceId: 'codex-official-download', githubResourceId: 'codex-github', connectsInToolbox: true },
  { id: 'claude-code', label: 'Claude Code', description: '官方命令行 Agent。装好后可在工具箱接入 DeepSeek。官方下载页只有英文，浏览器可一键翻译。', resourceId: 'claude-code-official-install', githubResourceId: 'claude-code-github', connectsInToolbox: true },
  { id: 'hermes', label: 'Hermes', description: '官方桌面或命令行 Agent。装好后可在工具箱接入 DeepSeek。', resourceId: 'hermes-official-download', githubResourceId: 'hermes-github', connectsInToolbox: true },
  { id: 'deepseek-harness', label: 'DeepSeek Harness', description: 'DeepSeek 官方编码 Agent。工具箱提供官方下载入口。', resourceId: 'deepseek-harness-official-install', githubResourceId: 'deepseek-harness-github', connectsInToolbox: false },
  { id: 'zcode', label: '智谱 ZCode', description: '智谱官方 Agent。工具箱提供官方下载入口。', resourceId: 'zcode-official-download', connectsInToolbox: false },
  { id: 'kimi-code', label: 'Kimi Code', description: 'Kimi 官方编程 Agent。工具箱提供官方下载入口。', resourceId: 'kimi-code-official-install', githubResourceId: 'kimi-code-github', connectsInToolbox: false }
]

export interface ShellInventoryView {
  readonly id: OfficialInstallPlatform['id']
  readonly installed: boolean | null
  readonly version: string
  readonly latest: string
  readonly updatable: boolean
  readonly method: 'npm' | 'script' | 'app' | 'none'
  readonly location: string
}

export function accessFailureText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (/ACCOUNT_SERVICE_UNAVAILABLE/.test(text)) return '账号服务暂时连不上，请检查网络后重试。'
  return fallback
}

async function networkGateText(shell: OfficialInstallPlatform['id']): Promise<string | undefined> {
  const api = (window.toolbox as { shells?: { reachability?: (input: { shell: string }) => Promise<{ snapshot: string }> } }).shells
  if (!api?.reachability) return undefined
  try {
    const result = JSON.parse((await api.reachability({ shell })).snapshot) as { reachable: boolean }
    if (result.reachable) return undefined
  } catch { return undefined }
  let state = ''
  try { state = (await window.toolbox.tunnel.status()).state } catch { /* 读不到通道状态也照样提示 */ }
  return installNetworkGateCopy(accountSnapshot().terms, state)
}

export async function openOfficialDownloadPage(options: {
  readonly shell: OfficialInstallPlatform['id']
  readonly resourceId: string
  readonly opened: string
  readonly failed: string
}): Promise<{ readonly message: string; readonly networkHint: boolean }> {
  const gate = await networkGateText(options.shell)
  if (gate) return { message: gate, networkHint: true }
  try {
    await window.toolbox.download.openExternal(options.resourceId)
    return { message: options.opened, networkHint: false }
  } catch (error) {
    return { message: accessFailureText(error, options.failed), networkHint: false }
  }
}

/** 各 Agent 页「下载/版本信息」：只检测本机版本，并交接到官方入口。 */
export function mountInstallCard(element: HTMLElement, platform: UsagePlatformId): () => void {
  const entry = officialInstallPlatforms.find(item => item.id === platform)!
  let mounted = true
  let busy = false
  let inventory: ShellInventoryView | undefined
  let inventoryFailed = false
  let system = '本机'
  let message = ''
  let networkHint = false
  const shells = (): (typeof window.toolbox)['shells'] | undefined => (window.toolbox as { shells?: (typeof window.toolbox)['shells'] }).shells

  const render = (): void => {
    if (!mounted) return
    const button = (text: string, className: string, onClick: () => void, disabled = false, withIcon?: 'refresh' | 'github'): HTMLButtonElement => {
      const node = document.createElement('button'); node.type = 'button'; node.className = className; node.disabled = busy || disabled
      if (withIcon) node.append(icon(withIcon))
      node.append(document.createTextNode(text)); node.onclick = onClick
      return node
    }
    const header = document.createElement('header'); header.className = 'platform-card-header'
    const brand = document.createElement('div'); brand.className = 'platform-brand'
    const title = document.createElement('h2'); title.textContent = entry.label
    brand.append(platformIcon(platform), title)
    const headerActions = document.createElement('div'); headerActions.className = 'platform-header-actions'
    headerActions.append(button('官方下载', 'secondary-action', () => { void openDownload() }, !window.toolbox.download))
    if (entry.githubResourceId) headerActions.append(button('查看 GitHub', 'secondary-action', () => { void openGithub() }, !window.toolbox.download, 'github'))
    const badge = document.createElement('span'); badge.className = 'platform-badge'; badge.textContent = system
    header.append(brand, headerActions, badge)
    const subtitle = document.createElement('p'); subtitle.className = 'platform-muted'; subtitle.textContent = '下载安装与版本'
    const facts = document.createElement('dl'); facts.className = 'platform-facts'
    const rows: [string, string][] = [
      ['安装状态', inventory ? (inventory.installed === true ? '已安装' : inventory.installed === false ? '未安装' : '无法自动判断') : (inventoryFailed ? '暂时无法检测' : busy ? '正在检测…' : '未检测，点「检测版本」')],
      ['当前版本', inventory?.installed === true ? (inventory.version || '版本未知') : '—']
    ]
    for (const [label, value] of rows) {
      const row = document.createElement('div'); const key = document.createElement('dt'); key.textContent = label
      const text = document.createElement('dd'); text.textContent = value; row.append(key, text); facts.append(row)
    }
    if (inventory?.location) {
      const row = document.createElement('div'); const key = document.createElement('dt'); key.textContent = '安装位置'
      const text = document.createElement('dd'); text.textContent = inventory.location; row.append(key, text); facts.append(row)
    }
    const actions = document.createElement('div'); actions.className = 'platform-actions'
    actions.append(button(busy ? '正在检测…' : '检测版本', 'button secondary-action', () => { void readInventory() }, shells() === undefined, 'refresh'))
    if (inventory) {
      const latest = document.createElement('span'); latest.className = 'platform-muted'
      latest.classList.add('platform-latest-version')
      latest.textContent = `最新版本：${inventory.latest || '以官方发布页为准'}`
      actions.append(button(inventory.latest ? `下载最新版 ${inventory.latest}` : '下载最新版', 'button primary-action', () => { void openDownload() }, !window.toolbox.download))
      actions.append(latest)
    }
    const notice = document.createElement('p'); notice.className = 'platform-muted platform-notice'; notice.setAttribute('role', 'status')
    notice.textContent = message || (inventory ? `已读取版本。点击「下载最新版${inventory.latest ? ` ${inventory.latest}` : ''}」打开官方下载页。${entry.githubResourceId ? 'GitHub 用于查看官方源码与发行说明。' : ''}` : '点「检测版本」查看装没装上、装的哪版。下载安装可直接用上方「官方下载」。')
    if (networkHint) { const go = document.createElement('button'); go.type = 'button'; go.className = 'primary-action'; go.textContent = '去 AI网络'; go.onclick = () => requestTabNavigation('tunnel'); notice.append(document.createTextNode(' '), go) }
    element.replaceChildren(header, subtitle, facts, actions, notice)
  }

  const readInventory = async (): Promise<void> => {
    const api = shells()
    if (!api || busy) return
    busy = true; message = ''; render()
    try {
      const entries = JSON.parse((await api.inventory()).snapshot) as ShellInventoryView[]
      if (!mounted) return
      inventory = entries.find(item => item.id === platform)
      inventoryFailed = inventory === undefined
    } catch { inventoryFailed = true; message = '版本信息暂时无法读取，请稍后重试。' }
    finally { busy = false; render() }
  }

  const openDownload = async (): Promise<void> => {
    if (busy) return
    // 占位在 await 之前，双击只会真打开一次。
    busy = true; message = '正在检查官方站点是否可达…'; networkHint = false; render()
    const result = await openOfficialDownloadPage({
      shell: platform,
      resourceId: entry.resourceId,
      opened: '已打开官方下载页。安装或更新完成后，点「检测版本」确认。',
      failed: '暂时无法打开官方下载页，请稍后重试。'
    })
    message = result.message; networkHint = result.networkHint
    busy = false
    if (mounted) render()
  }

  const openGithub = async (): Promise<void> => {
    if (busy || !entry.githubResourceId) return
    busy = true; message = ''; render()
    try {
      await window.toolbox.download.openExternal(entry.githubResourceId)
      message = '已打开 GitHub。这里可查看官方源码与发行说明；下载安装请使用上方「官方下载」。'
    } catch (error) { message = accessFailureText(error, '暂时无法打开 GitHub，请检查网络后重试。') }
    finally { busy = false; if (mounted) render() }
  }

  render()
  void window.toolbox.app.info().then(info => {
    if (!mounted) return
    system = info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : '本机'; render()
  }).catch(() => undefined)
  // 进页面不自动检测（创始人 09-12 定）。
  return () => { mounted = false; element.replaceChildren() }
}
