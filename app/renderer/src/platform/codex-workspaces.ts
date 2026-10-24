import type { CodexWorkspacesApi } from '../../../preload/api/codex-workspaces'
import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { AiAccessStatus } from '../../../main/ai-access/service'
import type { CodexWorkspaceOpenCode, CodexWorkspaceOpenResult } from '../../../main/ai-access/codex-workspaces'
import type { CodexWorkspaceSourceId } from '../../../main/ai-access/codex-workspace-sources'
import { modelProviderIds, modelProviders, type ModelProviderId } from '../../../shared/model-providers'
import { platformIcon } from '../platform-icons'
import { providerIcons } from './api-service'
import { readCodexLoginStatus } from './access-status'
import { openProviderEditor } from './provider-editor'

export const codexWorkspaceOptions: readonly { id: CodexWorkspaceSourceId; title: string; description: string }[] = [
  { id: 'official', title: 'OpenAI 官方套餐', description: '沿用当前 Codex 官方登录与套餐。' },
  { id: 'multi', title: '来信多模型', description: '创建一个来信多模型对话；每一轮请在 Codex 自带模型选择器选择下一轮模型。' }
]

export interface CodexRouterViewState {
  readonly running: boolean
  readonly modelCount: number
  readonly error?: 'not_configured' | 'not_running' | 'port_conflict' | 'stale_route' | 'protocol_incompatible'
  readonly catalog: { readonly state: 'written' | 'missing' | 'unreadable' | 'modified' }
  readonly lastDesktopUse?: { readonly provider: ModelProviderId; readonly model: string; readonly internalModelId: string; readonly at: string }
}

export interface CodexWorkspaceViewState {
  readonly busy: Set<string>
  readonly drafts: Partial<Record<ModelProviderId, string>>
  message: string
  runtime?: CodexRouterViewState
  setupRequested: boolean
  repairing: boolean
  focusTarget?: string
  closeEditor?: () => void
}

export function createCodexWorkspaceViewState(): CodexWorkspaceViewState {
  return { busy: new Set(), drafts: {}, message: '', setupRequested: false, repairing: false }
}

export function readCodexRouterViewState(snapshot: string): CodexRouterViewState | undefined {
  try {
    const value: unknown = JSON.parse(snapshot)
    if (!value || typeof value !== 'object') return undefined
    const input = value as Record<string, unknown>
    const catalog = input.catalog as Record<string, unknown> | undefined
    if (typeof input.running !== 'boolean' || !Number.isInteger(input.modelCount) || !catalog ||
      !['written', 'missing', 'unreadable', 'modified'].includes(String(catalog.state))) return undefined
    const error = ['not_configured', 'not_running', 'port_conflict', 'stale_route', 'protocol_incompatible'].includes(String(input.error))
      ? input.error as CodexRouterViewState['error'] : undefined
    const candidate = input.lastDesktopUse as Record<string, unknown> | undefined
    const provider = candidate && modelProviderIds.includes(candidate.provider as ModelProviderId) ? candidate.provider as ModelProviderId : undefined
    const lastDesktopUse = provider && typeof candidate?.model === 'string' && typeof candidate.internalModelId === 'string' &&
      typeof candidate.at === 'string' && Number.isFinite(Date.parse(candidate.at))
      ? { provider, model: candidate.model, internalModelId: candidate.internalModelId, at: candidate.at } : undefined
    return { running: input.running, modelCount: input.modelCount as number,
      catalog: { state: catalog.state as CodexRouterViewState['catalog']['state'] }, ...(error ? { error } : {}),
      ...(lastDesktopUse ? { lastDesktopUse } : {}) }
  } catch { return undefined }
}

export function readCodexWorkspaceOpenResult(snapshot: string): CodexWorkspaceOpenResult | null {
  try {
    const value: unknown = JSON.parse(snapshot)
    if (typeof value !== 'object' || value === null) return null
    const result = value as Partial<CodexWorkspaceOpenResult>
    const option = codexWorkspaceOptions.find(item => item.id === result.source)
    const codes: readonly CodexWorkspaceOpenCode[] = ['opened', 'model_pool_empty', 'codex_not_installed', 'login_required', 'official_restore_failed']
    return typeof result.ok === 'boolean' && option !== undefined && codes.includes(result.code as CodexWorkspaceOpenCode)
      ? result as CodexWorkspaceOpenResult : null
  } catch { return null }
}

export function codexWorkspaceResultMessage(result: CodexWorkspaceOpenResult | null, title: string): string {
  if (result?.ok && result.source === 'multi') return `已在 Codex 打开“${title}”。GUI 退出后由受控本机后台路由继续服务；下一轮模型在 Codex 自带选择器（Codex Desktop）中选择。`
  if (result?.ok) return `已在 Codex 打开“${title}”。`
  switch (result?.code) {
    case 'model_pool_empty': return '请先验证并加入至少一个模型，再新建来信多模型对话。'
    case 'codex_not_installed': return '没有找到受信任的 Codex Desktop 或 Codex 安装，请先完成官方安装。'
    case 'login_required': return '请先在 Codex 完成官方套餐登录，再新建官方工作窗口。原有配置和窗口未改动。'
    case 'official_restore_failed': return '没能切回 Codex 官方配置，未新建工作窗口。请检查配置文件权限后重试。'
    default: return '工作窗口没有打开，请重试。原有窗口未改动。'
  }
}

export function codexWorkspaceIsMultiView(status: AiAccessStatus | null, state: CodexWorkspaceViewState): boolean {
  return status?.codexMultiModel?.mode === 'multi' || state.setupRequested
}

export function restoreCodexWorkspaceFocus(root: HTMLElement, state: CodexWorkspaceViewState): void {
  if (!state.focusTarget) return
  const target = root.querySelector<HTMLElement>(`[data-codex-focus="${state.focusTarget}"]`)
  state.focusTarget = undefined
  target?.focus()
}

export function renderCodexWorkspaces(
  workspaceApi: CodexWorkspacesApi | undefined,
  accessApi: AiAccessApi | undefined,
  status: AiAccessStatus | null,
  state: CodexWorkspaceViewState,
  onRender: () => void,
  onRefresh: () => Promise<void>,
  /** Codex 官方登录的当前阶段（由模型 API 页轮询传入）；官方线据此显示等待/取消态。 */
  codexLogin: ReturnType<typeof readCodexLoginStatus> = 'idle'
): HTMLElement {
  const section = node('section', '', 'codex-workspaces')
  const mode = status?.codexMultiModel?.mode ?? 'single'
  if (mode === 'multi') state.setupRequested = false
  const pool = status?.codexMultiModel?.models ?? []
  const modes = node('div', '', 'codex-mode-switch')
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Codex 模型模式')
  const single = modeButton('单模型切换', 'single')
  const multi = modeButton('多模型共用', 'multi')
  modes.append(single, multi)
  section.append(modes)

  if (!codexWorkspaceIsMultiView(status, state)) {
    if (state.message) {
      const notice = node('p', state.message, 'platform-notice codex-workspaces-notice')
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); section.append(notice)
    }
    return section
  }

  if (state.message) {
    const message = node('p', state.message, 'platform-notice codex-workspaces-notice')
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); section.append(message)
  }
  const runtimeIssue = renderRuntimeIssue()
  if (runtimeIssue) section.append(runtimeIssue)
  const poolList = node('div', '', 'codex-multi-model-pool')
  // 官方线（创始人 2026-09-29 定案）：多模型池第一条线是 OpenAI 官方套餐，登录有效绿色「已启用」，
  // 未登录可在这里发起登录（桌面端直登同样探测得到）。
  poolList.append(officialRow())
  for (const provider of modelProviderIds) poolList.append(providerRow(provider))
  section.append(poolList)

  if (mode === 'multi') {
    const row = node('article', '', 'model-provider codex-workspace-source')
    row.dataset.workspaceSource = 'multi'
    const brand = node('div', '', 'provider-brand')
    const detail = node('div', '', 'provider-details')
    detail.append(node('h3', '来信多模型'), node('p', 'GUI 退出后由受控本机后台路由继续服务；每轮在 Codex Desktop 自带选择器中选择模型。', 'platform-muted'))
    brand.append(platformIcon('codex'), detail)
    const form = node('form', '', 'codex-workspace-form')
    const button = node('button', '新建来信多模型对话', 'primary-action')
    button.type = 'submit'; button.disabled = workspaceApi === undefined || status === null || state.busy.has('multi')
    button.dataset.codexFocus = 'open-multi'
    if (state.busy.has('multi')) button.textContent = '正在打开…'
    form.append(button)
    form.onsubmit = event => { event.preventDefault(); if (!button.disabled) void openMulti() }
    row.append(brand, form); section.append(row)
  }
  return section

  function modeButton(label: string, target: 'single' | 'multi'): HTMLButtonElement {
    const setup = mode === 'single' && state.setupRequested
    const cancelsSetup = target === 'single' && setup
    const active = mode === target && !setup
    const button = node('button', label, active ? 'secondary-action is-current' : 'secondary-action')
    button.type = 'button'; button.disabled = status === null || state.busy.has('mode') || active || (accessApi === undefined && !cancelsSetup)
    button.setAttribute('aria-pressed', String(active)); button.dataset.codexFocus = `mode-${target}`
    button.onclick = () => {
      if (cancelsSetup) {
        state.setupRequested = false
        state.message = ''
        state.focusTarget = 'mode-multi'
        onRender(); return
      }
      if (target === 'multi' && pool.length === 0) {
        state.setupRequested = true
        state.message = ''
        onRender(); return
      }
      void switchMode(target)
    }
    return button
  }

  function renderRuntimeIssue(): HTMLElement | undefined {
    if (mode === 'single' && state.setupRequested) return undefined
    const runtime = state.runtime
    if (!state.repairing && runtime?.error === undefined) return undefined
    const stopped = !state.repairing && runtime?.error === 'not_running'
    const issue = node('div', '', 'codex-multi-evidence')
    issue.append(node('p', state.repairing ? '后台路由正在启动' : stopped ? '后台路由已停止' : '后台路由需要工具箱修复', 'platform-notice'))
    if (state.repairing) return issue
    const detail = runtime?.error === 'stale_route' ? '模型池已更新，需要工具箱刷新后台路由。'
      : runtime?.error === 'port_conflict' ? '本机后台服务被占用，需要工具箱检查后修复。'
        : runtime?.error === 'protocol_incompatible' ? '后台控制协议不兼容，需要工具箱重新建立连接。'
          : runtime?.error === 'not_running' ? '后台路由已停止，可以由工具箱重新启动。'
            : '后台路由尚未完成配置，需要工具箱检查。'
    issue.append(node('p', detail, 'platform-muted'))
    const repair = node('button', stopped ? '启动后台路由' : '检查并修复后台路由', 'secondary-action')
    repair.type = 'button'; repair.dataset.codexFocus = 'repair-router'
    repair.disabled = accessApi?.repairCodexMultiModelRouter === undefined
    repair.onclick = () => { if (!repair.disabled) void repairRouter() }
    issue.append(repair)
    return issue
  }

  async function repairRouter(): Promise<void> {
    if (!accessApi?.repairCodexMultiModelRouter || state.repairing) return
    state.repairing = true; state.message = '正在由工具箱检查并修复后台路由…'; onRender()
    try {
      const value: unknown = JSON.parse((await accessApi.repairCodexMultiModelRouter()).snapshot)
      const result = value && typeof value === 'object' ? value as { repaired?: unknown; reason?: unknown } : undefined
      if (result?.repaired === true || result?.reason === 'already_running') {
        state.message = result.repaired === true ? '后台路由已恢复。' : '后台路由已经可用。'
        await onRefresh()
      } else {
        state.message = manualRepairMessage(state.runtime?.error)
        state.focusTarget = 'repair-router'
      }
    } catch {
      state.message = '后台路由修复未完成；原模式、模型池和绑定均未改动。'
      state.focusTarget = 'repair-router'
    } finally { state.repairing = false; onRender() }
  }

  function manualRepairMessage(error: CodexRouterViewState['error']): string {
    if (error === 'port_conflict') return '工具箱无法自动修复：本机后台服务被其他程序占用。请关闭占用本机服务的程序后重试。'
    if (error === 'protocol_incompatible') return '工具箱无法自动修复：后台版本或控制协议不一致。请切回单模型继续使用；当前版本不会自动替换后台。'
    if (error === 'not_configured') return '后台配置尚未完成。请切回单模型，再重新进入多模型设置并验证加入模型。'
    return '工具箱无法自动修复后台路由；请切回单模型后重试。'
  }

  /** OpenAI 官方套餐线：登录有效→绿色「已启用」；未登录→登录入口（或等待中→取消授权）。 */
  function officialRow(): HTMLElement {
    const row = node('article', '', 'model-provider codex-workspace-source codex-official-source')
    row.dataset.workspaceSource = 'official'
    const brand = node('div', '', 'provider-brand')
    const detail = node('div', '', 'provider-details')
    detail.append(node('h3', 'OpenAI 官方套餐'))
    const form = node('form', '', 'codex-workspace-form')
    if (status?.officialAuthentication?.codex?.state === 'official') {
      detail.append(node('p', '官方登录有效；官方模型在 Codex Desktop 自带选择器中可选。', 'platform-muted'))
      const badge = node('span', '已启用', 'platform-badge is-current')
      badge.dataset.codexFocus = 'official-enabled'
      form.append(badge)
    } else {
      detail.append(node('p', codexLogin === 'pending'
        ? '正在等待浏览器授权，完成后这里显示已启用。'
        : '可在工具箱登录官方账号，也可直接在 Codex 桌面端登录；登录后此线显示已启用。', 'platform-muted'))
      const button = node('button', codexLogin === 'pending' ? '取消授权' : '登录官方账号', codexLogin === 'pending' ? 'secondary-action' : 'primary-action')
      button.type = 'button'; button.dataset.codexFocus = 'official-login'
      button.disabled = accessApi === undefined || state.busy.has('official-login')
      button.onclick = () => { if (!button.disabled) void officialLogin(codexLogin === 'pending') }
      form.append(button)
    }
    brand.append(platformIcon('codex'), detail)
    row.append(brand, form)
    return row
  }

  async function officialLogin(cancel: boolean): Promise<void> {
    if (!accessApi || state.busy.has('official-login')) return
    state.busy.add('official-login')
    state.message = cancel ? '正在取消官方授权…' : '正在发起官方登录…'
    onRender()
    try {
      const response = cancel ? await accessApi.cancelCodexOfficialLogin() : await accessApi.startCodexOfficialLogin()
      const next = readCodexLoginStatus(response.snapshot)
      state.message = cancel ? '已取消官方授权。' : next === 'pending' ? '请在打开的官方页面完成登录，完成后这里显示已启用。' : '官方授权未完成，请重试。'
    } catch {
      state.message = '官方登录未完成，请稍后重试。'
    } finally {
      state.busy.delete('official-login')
      onRender()
      void onRefresh()
    }
  }

  function providerRow(provider: ModelProviderId): HTMLElement {
    const joined = pool.find(entry => entry.provider === provider)
    const saved = status?.shells.codex.providerKeys[provider] === true
    const row = node('article', '', 'model-provider codex-workspace-source')
    row.dataset.workspaceSource = provider
    const brand = node('div', '', 'provider-brand')
    const detail = node('div', '', 'provider-details')
    detail.append(node('h3', modelProviders[provider].title), node('p', joined
      ? `已验证并加入模型池：${joined.model}` : saved ? 'Key 已安全保存，尚未验证加入模型池。' : '尚未添加到模型池。', 'platform-muted'))
    brand.append(platformIcon(providerIcons[provider]), detail)
    const form = node('form', '', 'codex-workspace-form')
    const input = node('input')
    input.type = 'password'; input.autocomplete = 'off'; input.maxLength = 512; input.minLength = 16; input.required = !saved
    input.placeholder = joined ? '输入新 Key；留空复用已保存 Key' : saved ? '留空复用已保存 Key' : '填写 API Key 并验证加入'
    input.setAttribute('aria-label', `${modelProviders[provider].title} Key`)
    input.dataset.codexFocus = `key-${provider}`; input.value = state.drafts[provider] ?? ''
    input.oninput = () => { state.drafts[provider] = input.value }
    const button = node('button', joined ? '更换 Key 并验证' : '验证并加入', 'secondary-action')
    button.type = 'submit'; button.disabled = accessApi === undefined || status === null || state.busy.has(provider)
    button.dataset.codexFocus = `submit-${provider}`
    if (state.busy.has(provider)) button.textContent = '正在验证…'
    form.append(input, button)
    form.onsubmit = event => {
      event.preventDefault()
      if (button.disabled || accessApi === undefined || input.reportValidity() === false) return
      void configure(provider, input.value.trim(), joined?.model ?? '')
    }
    const actions = node('div', '', 'platform-actions provider-actions-secondary')
    if (joined) {
      const edit = node('button', '编辑池内模型', 'secondary-action'); edit.type = 'button'
      edit.dataset.codexFocus = `edit-${provider}`; edit.onclick = () => editPoolModel(provider, saved, joined.model)
      const remove = node('button', '移出模型池', 'secondary-action'); remove.type = 'button'
      remove.dataset.codexFocus = `remove-${provider}`; remove.onclick = () => { void removeProvider(provider) }
      remove.disabled = state.busy.has(provider)
      actions.append(edit, remove)
    }
    const official = node('button', '去官方获取 Key', 'api-key-link'); official.type = 'button'
    official.onclick = () => { void accessApi?.openProviderConsole({ provider }).catch(() => { state.message = '官网未能打开，请重试。'; onRender() }) }
    actions.append(official)
    row.append(brand, form, actions)
    return row
  }

  async function switchMode(target: 'single' | 'multi'): Promise<void> {
    if (!accessApi || state.busy.has('mode')) return
    state.busy.add('mode'); state.message = `正在切换到${target === 'multi' ? '多模型共用' : '单模型'}…`; onRender()
    try {
      const next = safeStatus((await accessApi.setCodexMode({ mode: target })).snapshot)
      if (next?.codexMultiModel?.mode !== target) throw new Error('CODEX_MODE_NOT_COMMITTED')
      state.setupRequested = false; state.message = ''
      await onRefresh()
    } catch {
      state.message = `切换未完成，仍保持${mode === 'multi' ? '多模型共用' : '单模型'}；原有模型池和路由未改动。`
      state.focusTarget = `mode-${target}`
    } finally { state.busy.delete('mode'); onRender() }
  }

  async function configure(provider: ModelProviderId, key: string, model: string): Promise<boolean> {
    if (!accessApi || state.busy.has(provider)) return false
    state.busy.add(provider); state.message = `正在验证 ${modelProviders[provider].title}…`; onRender()
    let passed = false
    try {
      const result = safeStatus((await accessApi.configureCodexMultiModel({ provider, key, model })).snapshot)
      passed = result?.attempt?.shell === 'codex' && result.attempt.provider === provider && result.attempt.ok === true &&
        result.codexMultiModel?.models.some(entry => entry.provider === provider) === true
      state.message = passed ? `${modelProviders[provider].title} 已验证并加入模型池。Key 已保存不代表已实际使用；请等待 Codex Desktop 完整调用。`
        : `${modelProviders[provider].title} 未能验证；旧 Key、旧模型、旧路由和池条目均未改动。`
      if (passed) { state.drafts[provider] = ''; state.setupRequested = false; await onRefresh() }
      else state.focusTarget = `key-${provider}`
    } catch {
      state.message = `${modelProviders[provider].title} 更新未完成；旧 Key、旧模型、旧路由和池条目均未改动。`
      state.focusTarget = `key-${provider}`
    } finally { state.busy.delete(provider); onRender() }
    return passed
  }

  function editPoolModel(provider: ModelProviderId, saved: boolean, currentModel: string): void {
    if (!accessApi) return
    state.closeEditor?.()
    state.closeEditor = openProviderEditor(accessApi, 'codex', provider, saved, async (key, model) => ({
      ok: await configure(provider, key ?? '', model), message: state.message,
      keySaved: status?.shells.codex.providerKeys[provider] === true
    }), () => { state.focusTarget = `edit-${provider}`; onRender() }, undefined, currentModel)
  }

  async function removeProvider(provider: ModelProviderId): Promise<void> {
    if (!accessApi || state.busy.has(provider)) return
    state.busy.add(provider); state.message = `正在将 ${modelProviders[provider].title} 移出模型池…`; onRender()
    try {
      const next = safeStatus((await accessApi.removeCodexMultiModel({ provider })).snapshot)
      if (next?.codexMultiModel?.models.some(entry => entry.provider === provider)) throw new Error('CODEX_POOL_REMOVE_NOT_COMMITTED')
      const remaining = next?.codexMultiModel?.models ?? []
      state.message = remaining.length ? `${modelProviders[provider].title} 已移出模型池；它的旧调用证据已失效。`
        : `${modelProviders[provider].title} 已移出；模型池为空，已回到单模型并停止后台路由。`
      state.setupRequested = false
      await onRefresh()
      state.focusTarget = remaining.length ? `remove-${remaining[0].provider}` : 'mode-multi'
    } catch {
      state.message = `移出未完成，${modelProviders[provider].title} 仍在模型池；原有路由未改动。`
      state.focusTarget = `remove-${provider}`
    } finally { state.busy.delete(provider); onRender() }
  }

  async function openMulti(): Promise<void> {
    if (!workspaceApi || state.busy.has('multi')) return
    state.busy.add('multi'); state.message = '正在创建“来信多模型”…'; onRender()
    try {
      const result = readCodexWorkspaceOpenResult((await workspaceApi.open({ source: 'multi' })).snapshot)
      state.message = codexWorkspaceResultMessage(result, '来信多模型')
      if (result?.ok) await onRefresh()
      else state.focusTarget = 'open-multi'
    } catch { state.message = codexWorkspaceResultMessage(null, '来信多模型'); state.focusTarget = 'open-multi' }
    finally { state.busy.delete('multi'); onRender() }
  }
}

function safeStatus(snapshot: string): AiAccessStatus | null {
  try {
    const value: unknown = JSON.parse(snapshot)
    return typeof value === 'object' && value !== null ? value as AiAccessStatus : null
  } catch { return null }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}
