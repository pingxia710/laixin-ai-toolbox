import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { AiAccessProvider, AiAccessShell, AiAccessStatus } from '../../../main/ai-access/service'
import { readAccessStatus, readClaudeLoginStatus, readCodexLoginStatus, type ClaudeOfficialLoginStatus } from './access-status'
import { platformIcon } from '../platform-icons'
import { usagePlatformLabel, type UsagePlatformId } from '../tabs'
import { accessShell } from './model'
import { modelProviderIds, modelProviders, providerShellContract } from '../../../shared/model-providers'
import { apiFailureMessage, apiFailureMessages, type ApiFailure, type ApiRemedyResult, type ApiUsageStage } from '../../../shared/api-service-types'
import { remedyControl } from './remedy'
import { readUsageStages, usageStageFor, usageStages } from './usage-stages'
import { requestNetworkDiagnosticNavigation } from '../navigation'
import { providerIcons, serviceButtons } from './api-service'
import { fallbackRestartGuidanceMessage, readRestartGuidance, restartGuidanceMessage } from './restart-guidance'
import { macUsageReceiptSupported, requestUsageReceipt, requestUsageReceiptSave,
  usageReceiptCopiedNotice, usageReceiptEmptyNotice, usageReceiptFailureNotice, usageReceiptSaveNotice,
  usageReceiptSectionHint, type UsageReceiptResult } from './usage-receipt-view'

/** 复验结果在行里至少留这么久，客户才看得见「已恢复」。 */
export const REMEDY_LINGER_MS = 8_000
import { icon } from '../icons'
import { openProviderEditor } from './provider-editor'
import { measureProviderLatency } from './provider-latency'
import { openOfficialDownloadPage } from './install-card'

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}

export const modelApiProviderOptions = modelProviderIds.map(id => ({
  id, title: modelProviders[id].title, icon: providerIcons[id],
  description: `${modelProviders[id].keySource}。${modelProviders[id].billingHint}`
}))

/** A project-local Codex file is diagnostic-only; the native client reads its user configuration. */
export function codexProjectConfigurationNotice(shell: AiAccessShell, target: NonNullable<AiAccessStatus['configurationTargets']>[AiAccessShell] | undefined): string | undefined {
  return shell === 'codex' && target?.reason === 'project-configuration-ignored'
    ? '检测到项目目录里的 Codex 配置；模型 API 仍使用用户级配置，工具箱会写入有效的用户级配置。'
    : undefined
}

// 平台只在启动后取一次；回执入口只在 macOS 渲染，其余平台连按钮都不出现。
let macPlatformProbe: Promise<boolean> | undefined
function macUsageReceiptPlatform(): Promise<boolean> {
  macPlatformProbe ??= Promise.resolve(window.toolbox?.app?.info?.())
    .then(info => macUsageReceiptSupported(info?.platform ?? ''))
    .catch(() => false)
  return macPlatformProbe
}

/**
 * Mac 使用回执（API-04）：生成 → 预览 → 复制或保存，全部客户手动触发；
 * 没有记录、取消保存都只给一句如实提示，⛔ 出现「已发送」或任何自动上传。
 * 平台门在确认 macOS 前不渲染任何入口（容器保持为空），⛔ 先挂出再撤掉让 Windows 闪现；
 * 保存只回传主进程预览快照标识，⛔ 把回执文本交回渲染层。`initial`/`onResult` 让整页重绘后预览不丢。
 */
export function usageReceiptSection(api: AiAccessApi | undefined, initial: UsageReceiptResult | null,
  onResult: (result: UsageReceiptResult) => void): HTMLElement | null {
  if (api === undefined) return null
  const section = node('div', '', 'platform-actions usage-receipt')
  const fillIfMac = async (): Promise<void> => {
    if (!(await macUsageReceiptPlatform())) return
    fillSection()
  }
  const fillSection = (): void => {
    if (section.childElementCount > 0) return
    const button = (text: string): HTMLButtonElement => {
      const element = node('button', text, 'secondary-action')
      element.type = 'button'
      return element
    }
    const state = node('p', '', 'platform-muted usage-receipt-state')
    state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite')
    const generate = button('生成 Mac 使用回执')
    generate.classList.add('usage-receipt-generate')
    section.append(node('p', 'Mac 使用回执：连续使用模型 API 的结果只记录在本机。可生成一份脱敏回执，先预览再复制或保存，由你自行发送给支持方。', 'platform-muted'), generate, state)
    let previewed: UsageReceiptResult | null = initial
    const showResult = (result: UsageReceiptResult, announce = true): void => {
      section.querySelectorAll('.usage-receipt-preview, .usage-receipt-actions, .usage-receipt-hint').forEach(item => { item.remove() })
      onResult(result)
      if (!result.ok || result.receipt === undefined) {
        if (announce) state.textContent = usageReceiptEmptyNotice(result)
        return
      }
      previewed = result
      const receipt = result.receipt
      const snapshotId = result.snapshotId
      const text = node('pre', receipt, 'usage-receipt-preview')
      const controls = node('div', '', 'platform-actions usage-receipt-actions')
      const copy = button('复制回执')
      copy.onclick = () => { void navigator.clipboard?.writeText(receipt).then(() => { state.textContent = usageReceiptCopiedNotice() }).catch(() => { state.textContent = usageReceiptFailureNotice() }) }
      const save = button('保存为文件')
      save.onclick = () => { void saveToFile(save, snapshotId) }
      controls.append(copy, save)
      section.append(text, controls, node('p', usageReceiptSectionHint(), 'platform-muted usage-receipt-hint'))
    }
    const saveToFile = async (control: HTMLButtonElement, snapshotId: string | undefined): Promise<void> => {
      if (!previewed?.ok) return
      control.disabled = true
      try {
        state.textContent = usageReceiptSaveNotice(await requestUsageReceiptSave(api, snapshotId))
      } catch {
        state.textContent = usageReceiptFailureNotice()
      } finally { control.disabled = false }
    }
    generate.onclick = () => {
      void (async () => {
        generate.disabled = true
        state.textContent = '正在生成本机回执…'
        try {
          showResult(await requestUsageReceipt(api))
        } catch {
          state.textContent = usageReceiptFailureNotice()
        } finally { generate.disabled = false }
      })()
    }
    // 整页重绘后恢复上一次的预览；首帧没有就保持安静。
    if (previewed !== null) showResult(previewed, false)
  }
  void fillIfMac()
  return section
}

/** A configured route or retained recovery state must finish in its original configuration target. */
export function hasClaudeConfigurationBinding(status: AiAccessStatus | null): boolean {
  const claude = status?.shells.claude
  return claude !== undefined && ((claude.selected !== null && claude.selected !== 'official') || claude.suspended !== undefined ||
    claude.interrupted !== undefined || claude.legacyDirect !== undefined)
}

/** The directory picker is a safe repair only before Claude has a route or recovery state to finish. */
export function canChooseClaudeConfigurationProject(
  status: AiAccessStatus | null,
  target: NonNullable<AiAccessStatus['configurationTargets']>[AiAccessShell] | undefined,
  pickerAvailable: boolean
): boolean {
  if (!pickerAvailable || status === null || hasClaudeConfigurationBinding(status)) return false
  return target?.reason !== 'project-config-overrides-user' && (target === undefined || target.writable)
}

/**
 * 「当前选中」＝该壳 selected 指向它，且没有被暂停或中断；三壳各自判定，其他壳的选择不影响本壳。
 * ⛔ 选中不等于软件已实际调用——调用证据只由 usage-stages 三态证据区显示。
 */
export function currentSelection(shell: AiAccessShell | null, status: AiAccessStatus | null, mode: 'official' | AiAccessProvider): boolean {
  return shell !== null && status?.shells[shell].selected === mode && status.shells[shell].suspended?.provider !== mode &&
    status.shells[shell].interrupted?.provider !== mode
}

/**
 * 选中来源的按钮文案走配置口径：只说明客户已选中它、配置已写。
 * ⛔ 用「使用中」冒充软件已验通——刚保存就显示使用中，客户会把选中来源当成整条接入已经通过。
 */
/** `clientMissing`：Key 配给的是 Claude Code 命令行版，但这台电脑只有 Claude 桌面版——配置没有软件会读，⛔ 说「已配置」。 */
export function selectionActionLabel(current: boolean, clientMissing = false): '已配置' | '启用' | '未生效' {
  return current ? clientMissing ? '未生效' : '已配置' : '启用'
}

export interface ClaudeEditionsView { readonly cli: boolean; readonly desktop: boolean }

/** 只装了 Claude 桌面版时给的说明；读不到版本情况或装了命令行版都不说，⛔ 误报。 */
export function claudeDesktopOnlyNotice(editions: ClaudeEditionsView | null): string | undefined {
  if (editions === null || editions.cli || !editions.desktop) return undefined
  return '这台电脑装的是 Claude 桌面版，还没有装 Claude Code 命令行版。Claude 桌面版只能登录 Claude 账号使用，不能用 DeepSeek、智谱、Kimi 的 Key（这是 Anthropic 的限制）。要用这些 Key，请安装 Claude Code 命令行版，装好后在终端（Windows 上是 PowerShell）里输入 claude 使用。'
}

export function readClaudeEditions(snapshot: string): ClaudeEditionsView | null {
  try {
    const value = JSON.parse(snapshot) as { cli?: unknown; desktop?: unknown }
    return typeof value.cli === 'boolean' && typeof value.desktop === 'boolean' ? { cli: value.cli, desktop: value.desktop } : null
  } catch { return null }
}

function codexOfficialDescription(status: AiAccessStatus | null, login: ReturnType<typeof readCodexLoginStatus>): string {
  if (login === 'pending') return '正在等待浏览器授权，完成后自动更新。'
  if (login === 'connected') return '本次官方授权已完成；模型来源以当前配置为准。'
  const authentication = status?.officialAuthentication?.codex
  if (authentication?.state === 'login-required' && authentication.reason === 'other-tool-api-key') {
    return '工具箱已解除自己的 API 接管，但检测到其他工具留下的 API Key。工具箱不会删除它；请先登录 ChatGPT 官方账号再使用。'
  }
  if (authentication?.state === 'login-required') return '工具箱已解除自己的 API 接管，但尚未确认 ChatGPT 官方登录；请先登录官方账号再使用。'
  if (authentication?.state === 'official') return '工具箱已解除自己的 API 接管，并确认当前有 ChatGPT 官方登录。'
  return '使用 ChatGPT 官方账号套餐，登录授权由官方页面完成。'
}

function officialSwitchMessage(shell: AiAccessShell, status: AiAccessStatus): string {
  // Hermes 没有官方套餐：解除就是解除工具箱接管，⛔ 不冒充官方登录语义。
  if (shell === 'hermes') return '已解除工具箱接管，Hermes 不再使用工具箱 API。有接入前备份时可点「恢复接入前配置」找回原配置；旧安装没有备份时无法自动恢复。'
  if (shell !== 'codex') return '工具箱 API 路由已解除。请在这个 AI 里完成或确认官方账号登录。'
  const authentication = status.officialAuthentication?.codex
  if (authentication?.state === 'login-required' && authentication.reason === 'other-tool-api-key') {
    return '已解除工具箱接管，但检测到其他工具留下的 API Key。工具箱没有删除它；请先登录 ChatGPT 官方账号后再使用。'
  }
  if (authentication?.state === 'login-required') return '已解除工具箱接管，但尚未确认 ChatGPT 官方登录；请先完成官方账号登录。'
  return authentication?.state === 'official' ? '已解除工具箱接管，并确认当前有 ChatGPT 官方登录。' : '已解除工具箱接管；请在这个 AI 里确认官方账号登录。'
}

/**
 * `focusProvider`：从用量页「去填写 / 检查 Key」跳进来时，落地要停在这家服务商那一行上——
 * 定位、高亮，并把这一行的 Key 编辑器直接展开。⛔ 只把客户丢在页面顶上让他自己找。
 */
export function mountModelApi(element: HTMLElement, platform: UsagePlatformId, api: AiAccessApi | undefined,
  focusProvider?: AiAccessProvider): () => void {
  const shell = accessShell(platform)
  const label = usagePlatformLabel(platform)
  let mounted = true
  let busy = false
  let status: AiAccessStatus | null = null
  let login: ReturnType<typeof readCodexLoginStatus> = 'idle'
  let claudeLogin: ClaudeOfficialLoginStatus = 'idle'
  const claudeBusy = (): boolean => claudeLogin === 'pending' || claudeLogin === 'code-required'
  let message = ''
  let usage: readonly ApiUsageStage[] = []
  let remedy: ApiRemedyResult | null = null
  // 复验结果要在行里留得住：复验一通过 attempt 就 ok 了，失败行连同「已恢复」胶囊会被整体删掉，
  // 客户根本来不及看见（实测只活 1 毫秒）。记下当时的判类与时刻，让这一行再留 8 秒。
  let remedyCode: ApiFailure | null = null
  let remedyTimer: ReturnType<typeof setTimeout> | undefined
  let claudeCodeDraft = ''
  // 官方登录等待期间每 1.5 秒整树重建，正在输入的 Key 会被清空、焦点掉到 body。
  // 与登录码同一套做法：草稿留在闭包里，重建后回填。草稿连同它属于哪一家一起记，
  // ⛔ 让上一家没提交的 Key 落进另一家的输入框。
  let keyDraft: { provider: AiAccessProvider; value: string } | null = null
  /** Only the immediately-entered Key lives here while the customer chooses the verified sister product. */
  let suggestedKey: { from: AiAccessProvider; to: AiAccessProvider; value: string } | null = null
  // 本机 API 服务停了是「当前故障」，与「上次接入测试失败」是两件事，各自留各自的复验结果。
  let startupError: ApiFailure | null = null
  let serviceRemedy: ApiRemedyResult | null = null
  // 这一页没有这家的行（非接入壳平台）就当没带：⛔ 把客户留在一个不存在的定位上。
  let editing: AiAccessProvider | null = shell !== null && focusProvider !== undefined ? focusProvider : null
  // 高亮要一直挂着（挂载后紧接着的那次 refresh 会整页重建，⛔ 让它把定位擦掉）；滚动与聚焦只做第一次。
  let focusedRow: AiAccessProvider | null = editing
  let pendingScroll = editing !== null
  let scrollFrames = 0
  let poll: ReturnType<typeof setInterval> | undefined
  let closeProviderServices: (() => void)[] = []
  let closeEditor = (): void => undefined
  let receiptResult: UsageReceiptResult | null = null
  let claudeEditions: ClaudeEditionsView | null = null
  const stopPoll = (): void => { if (poll !== undefined) clearInterval(poll); poll = undefined }
  const action = (text: string, run: () => void, primary = false): HTMLButtonElement => {
    const button = node('button', text, primary ? 'primary-action' : 'secondary-action')
    button.type = 'button'; button.disabled = busy || !api || !status || login === 'pending' || claudeBusy()
    button.onclick = run
    return button
  }
  const startAction = (mode: 'official' | AiAccessProvider): HTMLButtonElement => {
    const current = currentSelection(shell, status, mode)
    const clientMissing = mode !== 'official' && shell === 'claude' && claudeDesktopOnlyNotice(claudeEditions) !== undefined
    const button = action(selectionActionLabel(current, clientMissing), () => { void switchProvider(mode) }, !current)
    button.classList.add('api-enable')
    button.classList.toggle('is-current', current && !clientMissing)
    if (!(current && clientMissing)) button.prepend(icon(current ? 'check' : 'play'))
    button.disabled ||= current
    return button
  }
  const editProvider = (provider: AiAccessProvider): void => {
    if (!api || !shell || !status || busy || providerShellContract(provider, shell).status !== 'supported') return
    closeEditor()
    closeEditor = openProviderEditor(api, shell, provider, status.shells[shell].providerKeys[provider], async (key, model) => {
      const ok = await switchProvider(provider, key, model)
      return { ok, message, keySaved: status?.shells[shell].providerKeys[provider] === true }
    }, () => { if (mounted) element.querySelector<HTMLButtonElement>(`[data-provider="${provider}"] .api-edit`)?.focus() })
  }
  const provider = (id: 'official' | AiAccessProvider, title: string, description: string, icon: UsagePlatformId): { row: HTMLElement; actions: HTMLElement; secondary: HTMLElement } => {
    const row = node('article', '', 'model-provider'); row.dataset.provider = id
    const selected = currentSelection(shell, status, id)
    row.classList.toggle('is-selected', selected)
    const brand = node('div', '', 'provider-brand'); brand.append(platformIcon(icon))
    const details = node('div', '', 'provider-details')
    const heading = node('div', '', 'provider-heading'); heading.append(node('h2', title))
    if (selected) heading.append(node('span', '当前配置', 'platform-badge is-current'))
    details.append(heading, node('p', description, 'platform-muted')); brand.append(details)
    const wrapper = node('div', '', 'provider-actions')
    const actions = node('div', '', 'platform-actions provider-actions-primary')
    const secondary = node('div', '', 'platform-actions provider-actions-secondary')
    wrapper.append(actions, secondary); row.append(brand, wrapper)
    return { row, actions, secondary }
  }
  const render = (): void => {
    if (!mounted) return
    if (claudeLogin !== 'code-required') claudeCodeDraft = ''
    if (editing === null || keyDraft?.provider !== editing) keyDraft = null
    // 官方登录等待期间每 1.5 秒轮询都会整页重建；先记住正在输入的那个框与光标位置，重建后回填。
    const active = document.activeElement as HTMLElement | null
    const focusedSelector = !(active && element.contains(active)) ? null
      : active.matches('.ai-account-code input') ? '.ai-account-code input'
        : active.matches('.model-key-form input[name="key"]') ? '.model-key-form input[name="key"]' : null
    const caret = focusedSelector ? (active as HTMLInputElement).selectionStart : null
    const root = node('div', '', 'model-api')
    if (!shell) {
      const native = provider('official', `${label} 官方`, '使用平台原生的模型与账号。工具箱提供官方获取入口与版本检测，不接管它的 API 配置。', platform)
      root.append(native.row); element.replaceChildren(root); return
    }
    closeProviderServices.forEach(close => close()); closeProviderServices = []
    const suspended = status?.shells[shell].suspended
    const interrupted = status?.shells[shell].interrupted
    const legacyDirect = status?.shells[shell].legacyDirect
    const current = suspended || interrupted ? undefined : status?.shells[shell].selected
    if (status?.legacyZaiKeySaved || current === 'zai') root.append(node('p', '检测到旧 Z.AI 国际站配置。它不会自动用于国内智谱；请重新添加国内入口的 Key。原记录保留，可切回官方。', 'platform-notice'))
    if (status?.storageNote) root.append(node('p', status.storageNote, 'platform-notice'))
    const attempt = status?.attempt
    // 刚进页面时还没有操作反馈；这时把上一次失败的判类说出来，⛔ 让处理按钮孤零零地摆着没有缘由。
    const failure = attempt && attempt.shell === shell && !attempt.ok
      ? `${modelProviders[attempt.provider].title} 上次接入没有成功。${apiFailureMessage(attempt.code ?? 'invalid_reply', attempt.provider)}${attempt.notice ? ` ${attempt.notice}` : ''}`
      : ''
    const notice = node('p', message || failure || (!status ? '正在读取模型配置…' : ''), 'platform-notice')
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); root.append(notice)
    const desktopOnly = shell === 'claude' ? claudeDesktopOnlyNotice(claudeEditions) : undefined
    if (desktopOnly) {
      const row = node('div', '', 'platform-actions claude-desktop-only-notice')
      row.append(node('p', desktopOnly, 'platform-notice'))
      const install = action('打开命令行版安装页', () => { void openClaudeCliInstallPage() }, true)
      install.disabled = busy
      row.append(install)
      root.append(row)
    }
    if (suspended) {
      root.append(node('p', `历史 ${modelProviders[suspended.provider].title} ${label} 接入已暂停，当前不再使用工具箱 API。请选择已验收入口或解除工具箱接管。`, 'platform-notice'))
    }
    if (interrupted) {
      root.append(node('p', `${modelProviders[interrupted.provider].title} ${label} 的配置更新未完成，当前不再使用工具箱 API。请确认后点击“启用”重新写入配置。`, 'platform-notice'))
    }
    if (legacyDirect) {
      root.append(node('p', `检测到旧版 ${modelProviders[legacyDirect.provider].title} 直连记录；它未由当前工具箱网关接管。原 Key 保留在本机，确认后点击“启用”可迁移到当前安全路由。`, 'platform-notice'))
    }
    const target = status?.configurationTargets?.[shell]
    const claudeConfigurationBound = shell === 'claude' && hasClaudeConfigurationBinding(status)
    const codexProjectNotice = codexProjectConfigurationNotice(shell, target)
    if (codexProjectNotice) root.append(node('p', codexProjectNotice, 'platform-notice'))
    if (target && !target.writable) {
      const targetNotice = node('div', '', 'platform-actions configuration-target-notice')
      const text = target.reason === 'project-config-overrides-user'
        ? claudeConfigurationBound
          ? '当前 Claude Code 接入仍绑定先前的配置位置。请先切换到官方账号解除工具箱接管；工具箱会恢复接入前配置。完成收尾后才能选择或修复项目配置。'
          : '检测到当前项目配置优先。工具箱不会误改用户级配置；确认后只修复当前项目的配置。'
        : target.reason === 'managed-configuration'
          ? '当前配置由管理策略控制，工具箱不能改写。请联系管理员处理。'
          : target.reason === 'command-line-config-override'
            ? '当前 AI 使用了启动时指定的配置，工具箱不能安全改写。请按正常方式重新打开 AI 后再试。'
            : target.reason === 'symlinked-configuration'
              ? `配置文件是软链${target.symlink !== undefined ? `（链接在 ${target.symlink.path}，真身在 ${target.symlink.target}）` : ''}。工具箱不跟随软链写入：改动会影响所有指向同一个文件的配置。请自己决定——保留软链就直接改真身，或把链接换回普通文件后再点「启用」。`
              : target.reason === 'unreadable-configuration'
                ? '当前配置无法读取，工具箱不会冒险覆盖。请检查本机文件权限后重试。'
                : '当前 AI 的配置来源无法确认，工具箱不能安全改写。请关闭并重新打开 AI 后再试。'
      targetNotice.append(node('p', text, 'platform-notice'))
      if (target.reason === 'project-config-overrides-user' && !claudeConfigurationBound) {
        const confirm = action('按检测到的项目配置修复', () => { void selectConfigurationTarget() }, true)
        targetNotice.append(confirm)
      }
      root.append(targetNotice)
    }
    // Claude Code 的项目级 settings 会压过用户级配置，但工具箱不会猜客户当前在哪个项目里运行。
    // 已接管的路由和恢复备份必须在原配置位置收尾，不能在中途换目录。
    const canChooseClaudeProject = shell === 'claude' && canChooseClaudeConfigurationProject(status, target, api?.selectConfigurationProject !== undefined)
    if (canChooseClaudeProject) {
      const projectNotice = node('div', '', 'platform-actions configuration-project-notice')
      projectNotice.append(node('p', '当前项目有单独的 Claude Code 配置？选择项目目录后，工具箱只修复该项目的配置。', 'platform-notice'))
      projectNotice.append(action('选择项目目录并修复', () => { void selectConfigurationProject() }, true))
      root.append(projectNotice)
    }
    // 本机服务没在跑时，主页面此前既无提示也无处理按钮——客户只能在服务面板里看到一句文案。
    // 这里按 startupError 复用同一套处理动作，⛔ 让「上次接入测试通过」把当前故障盖住。
    if (startupError !== null) {
      const row = node('div', '', 'platform-actions service-fault-row')
      row.append(node('p', apiFailureMessage(startupError), 'platform-notice'))
      if (suspended) {
        row.append(node('span', '这条历史接入已暂停，不能重新写入或复验。请选择已验收入口，或解除工具箱接管后使用官方账号。', 'platform-muted'))
      } else {
        const control = remedyControl({ api, shell, code: startupError, initial: serviceRemedy,
          onSettled: result => { serviceRemedy = result; void refresh() } })
        if (control) row.append(control)
      }
      root.append(row)
    }
    if (failure) remedyCode = attempt!.code ?? 'unknown'
    // 失败行没了、但刚刚的复验结果还在保留期内，就继续把这一行留着。
    const lingering = !failure && remedy !== null && remedy.shell === shell && remedyCode !== null &&
      Date.now() - Date.parse(remedy.at) < REMEDY_LINGER_MS
    if (failure || lingering) {
      const row = node('div', '', 'platform-actions remedy-row')
      if (suspended) {
        row.append(node('span', '历史接入已暂停，工具箱不会对它执行自动修复。请选择已验收入口，或解除工具箱接管。', 'platform-muted'))
      } else {
        const control = remedyControl({ api, shell, provider: (failure ? attempt!.provider : remedy?.provider) ?? undefined, code: remedyCode ?? 'unknown', initial: remedy,
          onSettled: result => { remedy = result; void refresh() } })
        if (control) row.append(control)
      }
      const suggested = failure ? attempt?.suggestedProvider : undefined
      const suggestedContract = suggested === undefined ? undefined : providerShellContract(suggested, shell)
      if (failure && suggested !== undefined && attempt?.code === 'key_product_mismatch' && suggestedContract?.status === 'supported') {
        const transient = suggestedKey !== null && suggestedKey.from === attempt.provider && suggestedKey.to === suggested
        if (transient) row.append(action(`使用这把 Key 切换到 ${modelProviders[suggested].title}`, () => {
          const next = suggestedKey
          suggestedKey = null
          if (next) void switchProvider(next.to, next.value, suggestedContract.defaultModel)
        }, true))
        else row.append(action(`到 ${modelProviders[suggested].title} 填写 Key`, () => {
          editing = suggested; focusedRow = suggested; pendingScroll = true; render()
        }))
      }
      row.append(action('查看诊断', () => { requestNetworkDiagnosticNavigation(shell) }))
      root.append(row)
      if (lingering) {
        // 保留期一到就自己重画一次把这一行收走，⛔ 让它永远赖在页面上。
        clearTimeout(remedyTimer)
        remedyTimer = setTimeout(() => { remedy = null; remedyCode = null; render() }, Math.max(0, REMEDY_LINGER_MS - (Date.now() - Date.parse(remedy!.at))))
      }
    }
    if (shell !== 'hermes') {
      const official = provider('official', shell === 'codex' ? 'OpenAI 官方' : 'Claude 官方', shell === 'codex'
        ? codexOfficialDescription(status, login)
        : claudeLogin === 'pending' ? '正在等待浏览器授权；登录前请先连上 AI网络。' : claudeLogin === 'code-required' ? '官方页面显示了登录码，请粘到下面提交。' : claudeLogin === 'connected' ? '本次官方登录已完成；模型来源以当前配置为准。' : claudeLogin === 'not-installed' ? '未找到已安装的 Claude Code，请到「下载/版本信息」打开官方下载页。' : '使用 Claude 官方账号套餐，登录由工具箱发起、官方页面完成。', platform)
      const use = startAction('official')
      use.disabled ||= !status?.shells[shell].officialAvailable || status.shells[shell].selected === 'official'
      official.actions.append(use)
      if (shell === 'codex') {
        if (login === 'pending') {
          const cancel = action('取消授权', () => { void runLogin(true) }); cancel.disabled = busy || !api
          official.actions.append(cancel)
        } else official.actions.append(action('登录官方账号', () => { void runLogin(false) }))
      } else if (shell === 'claude') {
        if (claudeLogin === 'code-required') {
          const form = node('form', '', 'ai-account-code')
          const input = document.createElement('input'); input.type = 'text'; input.placeholder = '粘贴登录码'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Claude 登录码')
          input.value = claudeCodeDraft
          input.oninput = () => { claudeCodeDraft = input.value }
          const submit = node('button', '提交', 'primary-action'); submit.type = 'submit'; submit.disabled = busy || !api
          const cancel = node('button', '取消', 'secondary-action'); cancel.type = 'button'; cancel.onclick = () => { void runClaudeLogin('cancel') }
          form.append(input, submit, cancel)
          form.addEventListener('submit', (event) => { event.preventDefault(); void runClaudeLogin('code', input.value) })
          official.actions.append(form)
        } else if (claudeLogin === 'pending') {
          const cancel = node('button', '取消登录', 'secondary-action'); cancel.type = 'button'; cancel.disabled = busy || !api; cancel.onclick = () => { void runClaudeLogin('cancel') }
          official.actions.append(cancel)
        } else {
          const start = node('button', claudeLogin === 'connected' ? '重新登录账号' : '登录 Claude 账号', 'secondary-action'); start.type = 'button'; start.disabled = busy || !api || !status
          start.onclick = () => { void runClaudeLogin('start') }
          official.actions.append(start)
        }
      }
      root.append(official.row)
    } else {
      root.append(node('p', 'Hermes 没有自己的官方模型套餐，这里配置它要使用的模型 API。', 'platform-muted'))
      // Hermes 的「解除工具箱接管」入口：接管中、中断或旧直连状态都要可达；
      // ⛔ 不渲染官方套餐行，解除也不是切换官方。恢复是显式第二步，按恢复点可见性给入口。
      const hasHermesBinding = (current !== null && current !== 'official') || suspended !== undefined || interrupted !== undefined || legacyDirect !== undefined
      if (status && hasHermesBinding) {
        const exit = node('div', '', 'platform-actions hermes-exit')
        exit.append(node('p', '不再使用工具箱的 Hermes 接入？解除只移除工具箱写入的设置；有接入前备份时可再点「恢复接入前配置」找回原配置。', 'platform-muted'))
        exit.append(action('解除工具箱接管', () => { void switchProvider('official') }))
        root.append(exit)
      } else if (status && status.shells[shell].selected === 'official') {
        root.append(node('p', '已解除工具箱接管，Hermes 不在工具箱路由上。', 'platform-muted'))
        const recovery = status.shells[shell].recoveryPointAvailable
        if (recovery === true) {
          const restoreRow = node('div', '', 'platform-actions hermes-restore')
          restoreRow.append(node('p', '想回到接入前的模型配置？工具箱保留了接入前备份，可一键恢复。', 'platform-muted'))
          restoreRow.append(action('恢复接入前配置', () => { void restorePrevious() }))
          root.append(restoreRow)
        } else if (recovery === false) {
          root.append(node('p', '没有找到接入前配置备份，无法自动恢复原配置。', 'platform-muted'))
        }
      }
    }
    for (const option of modelApiProviderOptions) {
      const keySaved = status?.shells[shell].providerKeys[option.id] === true
      const contract = providerShellContract(option.id, shell)
      const row = provider(option.id, option.title, `${contract.productDescription} ${option.description} ${contract.description}`, option.icon)
      {
        if (contract.status !== 'supported') {
          row.row.classList.add('is-unavailable')
          const unavailable = action('暂不可用', () => undefined)
          unavailable.disabled = true
          row.actions.append(unavailable)
          row.secondary.append(node('span', '此 AI 尚未完成该产品的原生验证，工具箱不会保存或启用这条配置。', 'platform-muted'))
          const getKey = action('查看官方产品说明', () => { void api?.openProviderConsole({ provider: option.id }).catch(() => { message = '控制台未能打开，请重试。'; render() }) })
          getKey.classList.add('api-key-link'); row.secondary.append(getKey)
          root.append(row.row)
          continue
        }
        const start = startAction(option.id); start.disabled ||= !keySaved
        row.actions.append(start)
        const edit = action('', () => editProvider(option.id))
        edit.classList.add('api-service-small', 'api-edit'); edit.setAttribute('aria-label', '编辑')
        const hint = node('span', '编辑', 'api-action-tooltip'); hint.setAttribute('aria-hidden', 'true')
        edit.append(icon('edit'), hint)
        edit.onpointerenter = () => edit.classList.remove('is-tooltip-dismissed')
        edit.onblur = () => edit.classList.remove('is-tooltip-dismissed')
        edit.onkeydown = event => { if (event.key === 'Escape') edit.classList.add('is-tooltip-dismissed') }
        row.actions.append(edit)
        closeProviderServices.push(serviceButtons(row.actions, api, shell, () => option.id))
        row.secondary.append(action(keySaved ? '更换API key' : '添加API key', () => {
          editing = option.id; render(); element.querySelector<HTMLInputElement>('input[name="key"]')?.focus()
        }, !keySaved))
        const getKey = action('去官方获取 Key', () => { void api?.openProviderConsole({ provider: option.id }).catch(() => { message = '控制台未能打开，请重试。'; render() }) })
        getKey.classList.add('api-key-link'); row.secondary.append(getKey)
        if (editing === option.id) row.row.append(keyForm(option.id))
        if (current === option.id) {
          // 三态只挂「记的正是这家」的证据；切来源后旧来源的三态 ⛔ 挂到新来源行下冒充它的成功。
          const stages = usageStages(usageStageFor(usage, shell, option.id), () => remedyControl({
            api, shell, provider: option.id, code: 'configuration_failed', initial: remedy,
            onSettled: result => { remedy = result; void refresh() }
          }))
          if (stages) row.row.append(stages)
        }
      }
      root.append(row.row)
    }
    // Mac 使用回执：生成/预览/复制/保存都是客户手动动作；结果跨重绘保留在挂载状态里。
    const receipt = usageReceiptSection(api, receiptResult, next => { receiptResult = next })
    if (receipt) root.append(receipt)
    root.append(node('p', '点击「启用」会验证并切换当前 AI 的模型 API，不会打开 AI 窗口。验证包含两次小型请求，按服务商规则计费。切换完成后工具箱会按当前客户端的实际运行状态告诉你下一步；旧会话不会自动改用新渠道，真实客户端调用可在服务面板查看。', 'platform-muted'))
    if (shell === 'codex') root.append(node('p', 'Codex CLI 已验证不等于 Codex 桌面版已验证。桌面版只有经工具箱当前网关拿到完整回答，并核对到官方桌面进程与同一连接后，才会显示为已验证。', 'platform-muted codex-desktop-verification-note'))
    if (!status && !busy) {
      const retry = action('重试读取', () => { void refresh() }); retry.disabled = !api; root.append(retry)
    }
    element.replaceChildren(root)
    // 客户自己去编辑别的行（或把这一行关了）之后，定位就不再属于任何一行。
    if (focusedRow !== null && editing !== focusedRow) { focusedRow = null; pendingScroll = false }
    if (focusedRow !== null) focusProviderRow(focusedRow)
    if (focusedSelector) {
      const input = root.querySelector<HTMLInputElement>(focusedSelector)
      if (input) {
        input.focus()
        if (caret !== null) { try { input.setSelectionRange(caret, caret) } catch { /* 非文本输入无选区 */ } }
      }
    }
  }
  /**
   * 停到这家服务商那一行：高亮每次重绘都补回去，滚动与抢焦点只做第一次——
   * 之后的重绘 ⛔ 再把页面滚回去、⛔ 再抢走客户的光标。
   */
  const focusProviderRow = (provider: AiAccessProvider): void => {
    const row = element.querySelector<HTMLElement>(`[data-provider="${provider}"]`)
    if (!row) { focusedRow = null; pendingScroll = false; return }
    row.dataset.focusedProvider = 'true'
    if (!pendingScroll) return
    // 页面模块是**先 mount、后挂进文档**的：这一刻整棵树还没连上，滚动与聚焦都不生效。
    // 等下一帧连上了再做，⛔ 把这一次白白用掉，把客户丢在页面顶上。
    if (!row.isConnected) {
      if (scrollFrames++ > 60) { pendingScroll = false; return }
      requestAnimationFrame(() => { if (mounted && focusedRow !== null) focusProviderRow(focusedRow) })
      return
    }
    pendingScroll = false
    row.scrollIntoView({ block: 'center' })
    const input = row.querySelector<HTMLInputElement>('input[name="key"]')
    if (input && !input.disabled) input.focus()
    else row.querySelector<HTMLButtonElement>('.api-edit')?.focus()
  }
  const keyForm = (provider: AiAccessProvider): HTMLFormElement => {
    const form = node('form', '', 'model-key-form')
    const providerLabel = modelProviders[provider].title
    const field = node('label', `${providerLabel} Key`)
    const input = node('input'); input.type = 'password'; input.name = 'key'; input.autocomplete = 'off'; input.required = true
    input.minLength = 16; input.maxLength = 512; input.disabled = busy
    input.value = keyDraft?.provider === provider ? keyDraft.value : ''
    field.append(input)
    const controls = node('div', '', 'platform-actions')
    const submit = action(busy ? '正在验证…' : '保存并验证', () => undefined, true); submit.type = 'submit'
    const speedResult = node('p', '', 'provider-latency-result'); speedResult.setAttribute('role', 'status'); speedResult.setAttribute('aria-live', 'polite')
    const speed = action('测速', () => { void testSpeed() })
    const testSpeed = async (): Promise<void> => {
      if (!api || !shell || speed.disabled) return
      if (!input.reportValidity()) return
      speed.disabled = true; submit.disabled = true; input.disabled = true; speed.textContent = '测速中…'; speedResult.textContent = ''
      speedResult.textContent = await measureProviderLatency(api, shell, provider, input.value.trim())
      speed.disabled = false; submit.disabled = false; input.disabled = false; speed.textContent = '测速'
    }
    input.oninput = () => { keyDraft = { provider, value: input.value }; speedResult.textContent = '' }
    controls.append(submit, speed)
    form.append(field, node('p', `Key 来源：${modelProviders[provider].keySource}。仅为 ${label} 保存和接入，不会配置或影响其他 AI。上游 Key 加密留在工具箱；壳只保存本机客户端令牌。`, 'platform-muted'), controls)
    form.append(speedResult, node('p', '测速测量 API 首段有效回复耗时，不保存 Key、不切换配置；会发送一次小型请求，按服务商规则计费。', 'platform-muted'))
    form.onsubmit = event => {
      event.preventDefault()
      const key = input.value.trim(); input.value = ''; keyDraft = null
      void saveKeyFlow(provider, key)
    }
    return form
  }
/**
 * API-06（复核返工）：快捷表单换 Key 走主进程**单次原子动作** useProviderWithKey——
 * 候选 Key 先探测，探测、写入、配置任一步失败都回到原 Key、原模型、原路由，
 * ⛔ 未启用来源先把 Key 写进本地再验证（旧返工的两步 saveProviderKey→useProvider 有此回归）。
 * 模型由主进程内部沿用该来源已存选择，⛔ 表单把默认模型写死。
 */
const saveKeyFlow = async (provider: AiAccessProvider, key: string): Promise<void> => {
  if (!api || !shell || !status || busy || login === 'pending' || claudeBusy()) return
  busy = true; message = '正在验证并切换，请稍候…'; render()
  try {
    status = readAccessStatus((await api.useProviderWithKey({ shell, provider, key })).snapshot)
    if (!mounted) return
    const attempt = status?.attempt
    editing = null
    if (attempt?.shell === shell && attempt.provider === provider && !attempt.ok) {
      if (attempt.code === 'key_product_mismatch' && attempt.suggestedProvider !== undefined) {
        suggestedKey = { from: provider, to: attempt.suggestedProvider, value: key }
      }
      message = `${modelProviders[provider].title} 尚未完成接入。${apiFailureMessage(attempt.code ?? 'invalid_reply', provider)}${attempt.notice ? ` ${attempt.notice}` : ''}`
    } else {
      message = `${modelProviders[provider].title} 的 Key 已验证并更新，模型选择保持不变。服务面板将记录实际调用。`
    }
  } catch {
    message = '切换未完成，工具箱没有用这次输入覆盖已有配置。请检查软件安装及已有配置后重试。'
  } finally { busy = false; if (mounted) render() }
}
  // API-11：登录等待/输登录码期间只轻量轮询官方登录态端点，不刷配置目标、不读用量——
  // 每轮全量 status 会让主进程 spawn profiles＋ps 读 7 个 shell 文件，把登录页的电脑拖卡。
  // 登录态没有变化就不重绘整页；出结果后停轮询并全量刷一次，把配置目标与用量一起对齐。
  const pollLogin = async (): Promise<void> => {
    if (!mounted || !api) return
    try {
      const nextLogin = shell === 'codex' ? readCodexLoginStatus((await api.codexOfficialStatus()).snapshot) : 'idle'
      const nextClaude: ClaudeOfficialLoginStatus = shell === 'claude' && api.claudeOfficialStatus ? readClaudeLoginStatus((await api.claudeOfficialStatus()).snapshot) : 'idle'
      if (!mounted || (nextLogin === login && nextClaude === claudeLogin)) return
      login = nextLogin; claudeLogin = nextClaude
      if (login === 'pending' || claudeBusy()) { render(); return }
      stopPoll()
      render()
      void refresh()
    } catch { /* 单次登录态读失败按兵不动，下个周期再问；⛔ 把登录等待误报成页面故障 */ }
  }
  const refresh = async (): Promise<void> => {
    if (!mounted || busy || !api) return
    try {
      const next = readAccessStatus((await api.status()).snapshot)
      // 三态与配置一致性在服务快照里；读不到就先不显示，⛔ 让整页报错。
      let nextUsage: readonly ApiUsageStage[] = []
      let nextStartupError: ApiFailure | null = null
      try {
        const service = JSON.parse((await api.serviceStatus()).snapshot) as { usage?: unknown; startupError?: unknown }
        nextUsage = readUsageStages(service.usage)
        nextStartupError = typeof service.startupError === 'string' && Object.hasOwn(apiFailureMessages, service.startupError)
          ? service.startupError as ApiFailure : null
      } catch { nextUsage = []; nextStartupError = null }
      const nextLogin = shell === 'codex' ? readCodexLoginStatus((await api.codexOfficialStatus()).snapshot) : 'idle'
      const nextClaude: ClaudeOfficialLoginStatus = shell === 'claude' && api.claudeOfficialStatus ? readClaudeLoginStatus((await api.claudeOfficialStatus()).snapshot) : 'idle'
      // 只看文件在不在，不运行软件；客户装上命令行版后下一次刷新说明就会消失。
      const editionsApi = shell === 'claude' ? (window.toolbox as { shells?: { claudeEditions?: () => Promise<{ snapshot: string }> } } | undefined)?.shells?.claudeEditions : undefined
      const nextEditions = editionsApi === undefined ? null : await editionsApi().then(result => readClaudeEditions(result.snapshot), () => null)
      if (!mounted || busy) return
      status = next; login = nextLogin; claudeLogin = nextClaude; usage = nextUsage; startupError = nextStartupError; claudeEditions = nextEditions
      if ((login === 'pending' || claudeBusy()) && poll === undefined) poll = setInterval(() => { void pollLogin() }, 1500)
      if (login !== 'pending' && !claudeBusy()) stopPoll()
    } catch {
      if (!mounted) return
      status = null; startupError = null; message = '模型配置暂时无法读取，请重试。'; stopPoll()
    }
    render()
  }
  const openClaudeCliInstallPage = async (): Promise<void> => {
    if (busy) return
    busy = true; message = '正在检查官方站点是否可达…'; render()
    const result = await openOfficialDownloadPage({
      shell: 'claude-code',
      resourceId: 'claude-code-official-install',
      opened: '已打开 Claude Code 命令行版官方安装页。装好后回到这里，提示会自动消失。',
      failed: '暂时无法打开官方安装页，请稍后重试。'
    })
    message = result.message
    busy = false
    if (mounted) { render(); void refresh() }
  }
  const restartHint = async (): Promise<string> => {
    if (!api?.restartGuidance || !shell) return shell ? fallbackRestartGuidanceMessage(shell) : ''
    try {
      return restartGuidanceMessage(readRestartGuidance((await api.restartGuidance({ shell })).snapshot, shell))
    } catch {
      return fallbackRestartGuidanceMessage(shell)
    }
  }
  const switchProvider = async (mode: 'official' | AiAccessProvider, key?: string, model?: string): Promise<boolean> => {
    if (!api || !shell || !status || busy || login === 'pending' || claudeBusy()) return false
    const contract = mode === 'official' ? undefined : providerShellContract(mode, shell)
    if (contract !== undefined && contract.status !== 'supported') {
      message = `${contract.title} 尚未完成 ${label} 原生验证，工具箱不会保存或启用这条配置。`
      render()
      return false
    }
    const enteredKey = key
    suggestedKey = null
    const selectedModel = contract === undefined ? undefined : enteredKey === undefined ? model : model ?? contract.defaultModel
    busy = true; message = '正在验证并切换，请稍候…'; render()
    let succeeded = false
    try {
      status = readAccessStatus((await (mode === 'official' ? api.useOfficial({ shell }) : selectedModel !== undefined
        ? api.configureProvider({ provider: mode, shell, key: enteredKey ?? '', model: selectedModel }) : api.useProvider({ provider: mode, shell }))).snapshot)
      editing = null
      if (mode !== 'official' && status.attempt?.shell === shell && !status.attempt.ok) {
        if (enteredKey !== undefined && status.attempt.code === 'key_product_mismatch' && status.attempt.suggestedProvider !== undefined) {
          suggestedKey = { from: mode, to: status.attempt.suggestedProvider, value: enteredKey }
        }
        message = `${modelProviders[mode].title} 尚未完成接入。${apiFailureMessage(status.attempt.code ?? 'invalid_reply', mode)}${status.attempt.notice ? ` ${status.attempt.notice}` : ''}`
      }
      succeeded = status.shells[shell].selected === mode && !(mode !== 'official' && status.attempt?.shell === shell && !status.attempt.ok)
      if (succeeded) {
        const hint = await restartHint()
        message = mode === 'official' ? `${officialSwitchMessage(shell, status)} ${hint}`
          : `${modelProviders[mode].title} ${status.attempt?.ok ? '模型与工具调用测试通过，' : ''}配置已写入 ${label}。${hint} 服务面板将记录实际调用。`
      } else if (mode === 'official') message = officialSwitchMessage(shell, status)
    } catch {
      message = '切换未完成，工具箱没有用这次输入覆盖已有配置。请检查软件安装及已有配置后重试。'
    } finally { busy = false; render() }
    return succeeded
  }
  // 显式恢复接入前配置（解除是第一步，这是第二步）：失败时说明没有可用备份，⛔ 假装恢复成功。
  const restorePrevious = async (): Promise<void> => {
    if (!api || !shell || busy) return
    busy = true; message = '正在恢复接入前配置…'; render()
    try {
      status = readAccessStatus((await api.restorePreviousConnection({ shell })).snapshot)
      message = '已恢复接入前的模型配置，Hermes 不再由工具箱管理。'
    } catch {
      message = '恢复未完成：没有找到可用的接入前配置备份。Hermes 当前配置没有被覆盖。'
    } finally { busy = false; if (mounted) { render(); void refresh() } }
  }
  const selectConfigurationTarget = async (): Promise<void> => {    if (!api || !shell || !status || busy) return
    busy = true; message = '正在确认配置位置…'; render()
    try {
      status = readAccessStatus((await api.selectConfigurationTarget({ shell, scope: 'project' })).snapshot)
      message = status.configurationTargets?.[shell]?.writable
        ? '已确认当前项目配置位置。现在可以继续保存并启用 API。'
        : '当前项目配置仍不能安全改写，工具箱没有改写任何配置。请重新打开 AI 后再试。'
    } catch { message = '未能确认当前项目配置位置，工具箱没有改写任何配置。请重新打开 AI 后再试。' }
    finally { busy = false; if (mounted) render() }
  }
  const selectConfigurationProject = async (): Promise<void> => {
    if (!api || shell !== 'claude' || !status || busy || !api.selectConfigurationProject) return
    busy = true; message = '正在等待选择项目目录…'; render()
    try {
      status = readAccessStatus((await api.selectConfigurationProject({ shell })).snapshot)
      message = status.configurationTargets?.[shell]?.scope === 'project' && status.configurationTargets[shell]?.writable
        ? '已确认所选项目的配置位置。现在可以继续保存并启用 API。'
        : '没有选择可写的项目配置，工具箱没有改写任何配置。'
    } catch { message = '未能确认所选项目配置，工具箱没有改写任何配置。请重新打开 AI 后再试。' }
    finally { busy = false; if (mounted) render() }
  }
  const runLogin = async (cancel: boolean): Promise<void> => {
    if (!api || busy) return
    busy = true; message = ''; render()
    try {
      login = readCodexLoginStatus((await (cancel ? api.cancelCodexOfficialLogin() : api.startCodexOfficialLogin())).snapshot)
      message = cancel ? '已取消官方授权。' : '请在打开的官方页面完成登录。'
    } catch { message = '官方授权未完成，请确认 Codex 已安装且能够运行后重试。' }
    finally { busy = false; if (mounted) { render(); void refresh() } }
  }
  const runClaudeLogin = async (step: 'start' | 'cancel' | 'code', code = ''): Promise<void> => {
    if (!api || busy || !api.startClaudeOfficialLogin) return
    if (step === 'code' && !code.trim()) return
    busy = true; message = ''; render()
    try {
      const result = step === 'start' ? await api.startClaudeOfficialLogin() : step === 'cancel' ? await api.cancelClaudeOfficialLogin() : await api.submitClaudeLoginCode({ code })
      claudeLogin = readClaudeLoginStatus(result.snapshot)
      message = step === 'cancel' ? '已取消 Claude 官方登录。' : step === 'code' ? '登录码已提交，正在核实登录状态…'
        : claudeLogin === 'not-installed' ? '未找到已安装的 Claude Code，请到「下载/版本信息」打开官方下载页。' : '已打开 Claude 官方授权页；如页面最后显示登录码，请粘回这里提交。登录前请先连上 AI网络。'
    } catch { message = 'Claude 官方登录未完成，请稍后重试。' }
    finally { busy = false; if (mounted) { render(); void refresh() } }
  }
  render()
  if (shell && api) void refresh()
  else if (shell) { message = '当前客户端暂不支持模型配置，请更新工具箱。'; render() }
  return () => { mounted = false; keyDraft = null; suggestedKey = null; claudeCodeDraft = ''; stopPoll(); closeEditor(); closeProviderServices.forEach(close => close()); element.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.value = '' }); element.replaceChildren() }
}
