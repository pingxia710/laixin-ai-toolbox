import type { CodexWorkspacesApi } from '../../../preload/api/codex-workspaces'
import type { AiAccessStatus } from '../../../main/ai-access/service'
import type { CodexWorkspaceOpenCode, CodexWorkspaceOpenResult } from '../../../main/ai-access/codex-workspaces'
import type { CodexWorkspaceSourceId } from '../../../main/ai-access/codex-workspace-sources'
import { platformIcon } from '../platform-icons'
import { providerIcons } from './api-service'

export const codexWorkspaceOptions: readonly {
  id: CodexWorkspaceSourceId
  title: string
  description: string
}[] = [
  { id: 'official', title: 'OpenAI 官方套餐', description: '沿用当前 Codex 官方登录与套餐。' },
  { id: 'deepseek', title: 'DeepSeek API', description: '这个新工作窗口固定使用 DeepSeek 开放平台。' },
  { id: 'moonshot', title: 'Kimi API', description: '这个新工作窗口固定使用 Kimi 开放平台。' },
  { id: 'zhipu-api', title: '智谱 API', description: '这个新工作窗口固定使用智谱开放平台。' }
]

export interface CodexWorkspaceViewState {
  readonly busy: Set<CodexWorkspaceSourceId>
  readonly drafts: Partial<Record<Exclude<CodexWorkspaceSourceId, 'official'>, string>>
  message: string
}

export function createCodexWorkspaceViewState(): CodexWorkspaceViewState {
  return { busy: new Set(), drafts: {}, message: '' }
}

export function readCodexWorkspaceOpenResult(snapshot: string): CodexWorkspaceOpenResult | null {
  try {
    const value: unknown = JSON.parse(snapshot)
    if (typeof value !== 'object' || value === null) return null
    const result = value as Partial<CodexWorkspaceOpenResult>
    const option = codexWorkspaceOptions.find(item => item.id === result.source)
    const codes: readonly CodexWorkspaceOpenCode[] = ['opened', 'key_missing', 'key_rejected', 'provider_unavailable', 'codex_not_installed']
    return typeof result.ok === 'boolean' && option !== undefined && codes.includes(result.code as CodexWorkspaceOpenCode)
      ? result as CodexWorkspaceOpenResult : null
  } catch { return null }
}

export function codexWorkspaceResultMessage(result: CodexWorkspaceOpenResult | null, title: string): string {
  if (result?.ok) return `已在 Codex 打开“${title}”。这个窗口的来源已经固定，工具箱现在可以退出。`
  switch (result?.code) {
    case 'key_missing': return `请先填写 ${title} 的 API Key。`
    case 'key_rejected': return `${title} 的 Key 没有通过验证，原有官方登录、Key 和窗口均未改动。`
    case 'provider_unavailable': return `${title} 暂时无法完成接口验证，请稍后重试。原有窗口未改动。`
    case 'codex_not_installed': return '没有找到受信任的 Codex Desktop 或 Codex 安装，请先完成官方安装。'
    default: return '工作窗口没有打开，请重试。原有窗口未改动。'
  }
}

export function renderCodexWorkspaces(
  api: CodexWorkspacesApi | undefined,
  status: AiAccessStatus | null,
  state: CodexWorkspaceViewState,
  onRender: () => void,
  onRefresh: () => Promise<void>
): HTMLElement {
  const section = node('section', '', 'codex-workspaces')
  const header = node('header', '', 'codex-workspaces-header')
  header.append(node('h2', 'Codex 四来源工作窗口'), node('p', '每次新建时选择来源。已打开的窗口各用各的来源，互不切换；API 窗口打开后不需要保持工具箱运行。', 'platform-muted'))
  const message = node('p', state.message, 'platform-notice codex-workspaces-notice')
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite')
  section.append(header, message)

  for (const option of codexWorkspaceOptions) {
    const apiSource = option.id === 'official' ? undefined : option.id
    const row = node('article', '', 'model-provider codex-workspace-source')
    row.dataset.workspaceSource = option.id
    const brand = node('div', '', 'provider-brand')
    const image = platformIcon(option.id === 'official' ? 'codex' : providerIcons[option.id])
    const detail = node('div', '', 'provider-details')
    detail.append(node('h3', option.title), node('p', option.description, 'platform-muted'))
    brand.append(image, detail)
    const form = node('form', '', 'codex-workspace-form')
    const saved = apiSource === undefined || status?.shells.codex.providerKeys[apiSource] === true
    let input: HTMLInputElement | undefined
    if (apiSource !== undefined) {
      input = node('input')
      input.type = 'password'; input.autocomplete = 'off'; input.maxLength = 512; input.minLength = 16
      input.placeholder = saved ? '留空使用已保存 Key' : '填写 API Key'
      input.setAttribute('aria-label', `${option.title} API Key`)
      input.value = state.drafts[apiSource] ?? ''
      input.oninput = () => { state.drafts[apiSource] = input?.value ?? '' }
      form.append(input)
    }
    const button = node('button', apiSource === undefined || saved ? '新建工作窗口' : '验证 Key 并新建', 'primary-action')
    button.type = 'submit'
    button.disabled = api === undefined || status === null || state.busy.has(option.id)
    if (state.busy.has(option.id)) button.textContent = '正在打开…'
    form.append(button)
    form.onsubmit = event => {
      event.preventDefault()
      if (button.disabled || api === undefined) return
      if (apiSource !== undefined && !saved && input?.reportValidity() === false) return
      const key = apiSource === undefined ? '' : input?.value.trim() ?? ''
      void open(option.id, option.title, key)
    }
    row.append(brand, form)
    section.append(row)
  }
  return section

  async function open(source: CodexWorkspaceSourceId, title: string, key: string): Promise<void> {
    if (api === undefined || state.busy.has(source)) return
    state.busy.add(source); state.message = `正在创建“${title}”…`; onRender()
    try {
      const result = readCodexWorkspaceOpenResult((await api.open({ source, key })).snapshot)
      state.message = codexWorkspaceResultMessage(result, title)
      if (result?.ok && source !== 'official') state.drafts[source] = ''
      if (result?.ok) await onRefresh()
    } catch { state.message = codexWorkspaceResultMessage(null, title) }
    finally { state.busy.delete(source); onRender() }
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}
