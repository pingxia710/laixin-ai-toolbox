import type { AiAccessApi } from '../../../preload/api/ai-access'
import { apiFailureMessage, apiFailureMessages, type ApiRemedyResult, type ApiRequestRecord, type ApiServiceSnapshot, type ApiShell, type ModelProviderId } from '../../../shared/api-service-types'
import { remedyControl } from './remedy'
import { isProviderShellSupported, modelProviders, modelProviderIds } from '../../../shared/model-providers'
import { readApiCheck } from './access-status'
import { icon } from '../icons'
import { platformIcon } from '../platform-icons'
import type { UsagePlatformId } from '../tabs'

export const providerIcons: Record<ModelProviderId, UsagePlatformId> = {
  deepseek: 'deepseek-harness',
  'zhipu-api': 'zcode',
  zhipu: 'zcode',
  moonshot: 'kimi-code',
  kimi: 'kimi-code'
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] { return Object.assign(document.createElement(tag), { textContent: text, className }) }

/** Pending shell/provider pairs have no safe route, so their service panel must stay unreachable. */
export function providerServiceAvailable(shell: ApiShell, provider: ModelProviderId): boolean {
  return isProviderShellSupported(provider, shell)
}

export function serviceButtons(parent: HTMLElement, api: AiAccessApi | undefined, shell: ApiShell, provider: () => ModelProviderId): () => void {
  let closePanel = (): void => undefined
  const group = node('div', '', 'api-service-entry')
  for (const [label, glyph, tab] of [['进入 API 服务','arrow','service'], ['服务面板','usage','statistics']] as const) {
    const button = node('button', '', 'secondary-action api-service-small')
    button.type = 'button'; button.setAttribute('aria-label', label)
    const tooltip = node('span', label, 'api-action-tooltip'); tooltip.setAttribute('aria-hidden', 'true')
    button.append(icon(glyph), tooltip)
    const available = (): boolean => providerServiceAvailable(shell, provider())
    button.disabled = !api?.serviceStatus || !available()
    if (!available()) button.title = '此入口尚未完成原生验证，暂不能测试或查看服务状态。'
    button.onpointerenter = () => button.classList.remove('is-tooltip-dismissed')
    button.onblur = () => button.classList.remove('is-tooltip-dismissed')
    button.onkeydown = event => { if (event.key === 'Escape') button.classList.add('is-tooltip-dismissed') }
    button.onclick = () => {
      button.classList.add('is-tooltip-dismissed')
      if (!api || !available()) return
      closePanel(); closePanel = openApiService(api, shell, provider(), tab)
    }
    group.append(button)
  }
  parent.append(group)
  return () => { closePanel(); group.remove() }
}

export function summarizeRequests(records: readonly ApiRequestRecord[]) {
  const clients = records.filter(r => r.source === 'client')
  const cancelled = clients.filter(r => r.code === 'client_aborted')
  const settled = clients.filter(r => r.code !== 'client_aborted')
  return { count: clients.length, succeeded: settled.filter(r => r.ok).length, failed: settled.filter(r => !r.ok).length, cancelled: cancelled.length,
    input: settled.reduce((sum,r) => sum + (r.inputTokens ?? 0), 0), output: settled.reduce((sum,r) => sum + (r.outputTokens ?? 0), 0),
    tokensKnown: settled.length > 0 && settled.every(r => r.inputTokens !== null && r.outputTokens !== null) }
}

/** 与账号总览同一口径：有余额接口且读到数字才显示数字，否则指向官方控制台。 */
export function balanceMetricValue(balance: { supported: boolean; total: number | null; currency: string } | null | undefined): string {
  return balance?.supported && balance.total !== null ? `${balance.total.toFixed(2)} ${balance.currency || ''}`.trim() : '请到官方控制台查看'
}

function openApiService(api: AiAccessApi, shell: ApiShell, provider: ModelProviderId, initial: 'service' | 'statistics'): () => void {
  const priorFocus = document.activeElement as HTMLElement | null
  const definition = modelProviders[provider]
  const dialog = node('dialog', '', 'api-service-dialog')
  dialog.setAttribute('aria-label', `${definition.title} 服务面板`)
  const header = node('header', '', 'api-service-header')
  const brand = node('div', '', 'account-card-brand'); brand.append(platformIcon(providerIcons[provider]), node('h2', definition.title))
  const close = node('button', '关闭', 'secondary-action'); close.type = 'button'; close.onclick = () => dialog.close()
  header.append(brand, close)
  const tabs = node('div', '', 'api-service-tabs')
  const content = node('div', '', 'api-service-content')
  const notice = node('p', '', 'platform-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const actions = node('div', '', 'platform-actions')
  const refresh = node('button', '刷新状态', 'secondary-action'); refresh.type = 'button'; refresh.onclick = () => { void load() }
  // API-10：检查等待中同一颗按钮变成「取消检查」，中止在飞的自测请求；关面板也一样生效。
  const test = node('button', '测试接口与工具调用', 'primary-action'); test.type = 'button'
  test.onclick = () => { if (busy && probeInFlight) cancelProbe(); else void load(true) }
  actions.append(refresh, test)
  dialog.append(header, tabs, notice, content, actions, node('p', '测试会发送两次小型请求，按服务商规则计费，不操作你的文件。使用 API 时须保持工具箱运行；检查等待中可点「取消检查」或关闭此面板中止，已发出的请求可能仍按服务商规则计费，面板本身的服务不受影响。', 'platform-muted'))
  let tab = initial
  let snapshot: ApiServiceSnapshot | null = null
  let configuration: { endpoint: string; model: string } | null = null
  let balance: { supported: boolean; total: number | null; currency: string } | null = null
  let serviceRemedy: ApiRemedyResult | null = null
  let busy = false
  let probeInFlight = false
  let disposed = false
  for (const [value, label] of [['service','服务配置'], ['statistics','统计与诊断']] as const) {
    const button = node('button', label, 'secondary-action'); button.type = 'button'; button.dataset.serviceTab = value
    button.onclick = () => { tab = value; render() }; tabs.append(button)
  }
  const render = (): void => {
    if (disposed) return
    tabs.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.serviceTab === tab)))
    refresh.disabled = busy
    if (busy && probeInFlight) {
      test.disabled = false; test.textContent = '取消检查'
    } else {
      test.disabled = busy || !api.testProvider; test.textContent = '测试接口与工具调用'
    }
    content.replaceChildren()
    if (!snapshot) { content.append(node('p', '尚未读取到服务状态。', 'platform-muted')); return }
    const route = snapshot.routes.find(r => r.shell === shell && r.provider === provider)
    const check = snapshot.checks.find(c => c.shell === shell && c.provider === provider)
    const rows = snapshot.requests.filter(r => r.shell === shell && r.provider === provider)
    const status = node('div', '', 'platform-actions')
    status.append(node('span', snapshot.running ? '本机服务运行中' : '本机服务未运行', `platform-badge${snapshot.running ? ' is-current' : ''}`), node('span', route ? '此 AI 路由已启用' : '此 AI 路由未启用', 'platform-badge'))
    content.append(status)
    if (snapshot.startupError) {
      content.append(node('p', apiFailureMessages[snapshot.startupError], 'platform-notice'))
      // 文案说「请重启本机 API 服务」，按钮却只有刷新与测试；把该做的动作放在文案旁边。
      const control = remedyControl({ api, shell, provider, code: snapshot.startupError, initial: serviceRemedy,
        onSettled: result => { serviceRemedy = result; void load() } })
      if (control) content.append(control)
    }
    // 取消的检查用取消交代整行呈现（⛔ 再叠「在 AI 里按了停止」的客户端口径）；其余失败带出 notice。
    const checked = !check ? '尚未测试' : check.ok ? '模型回复、工具调用及流式返回已通过'
      : check.code === 'client_aborted' && check.notice ? check.notice
      : `${apiFailureMessage(check.code ?? 'invalid_reply', provider)}${check.notice ? ` ${check.notice}` : ''}`
    content.append(node('p', `${checked}${check ? ` · ${new Date(check.at).toLocaleString()}` : ''}`, 'platform-notice'))
    if (tab === 'service') {
      const facts = node('dl', '', 'platform-facts')
      for (const [label,value] of [['接入软件',shell === 'claude' ? 'Claude Code' : shell === 'codex' ? 'Codex' : 'Hermes'], ['Key 来源',definition.keySource], ['计费',definition.billingHint], ['本机地址',route?.baseUrl ?? '启用模型 API 后生成'], ['官方接口',route?.upstream ?? configuration?.endpoint ?? '暂时未读到'], ['模型 ID',route?.model ?? configuration?.model ?? '暂时未读到'], ['密钥', '上游 Key 加密管理；本机客户端令牌不在面板展示']]) {
        const row = node('div'); row.append(node('dt',label),node('dd',value)); facts.append(row)
      }
      content.append(facts)
      const consoleButton = node('button', '打开官方控制台', 'secondary-action'); consoleButton.type = 'button'
      consoleButton.onclick = () => { void api.openProviderConsole({ provider }).catch(() => { if (!disposed) notice.textContent = '未能打开控制台，请重试。' }) }
      content.append(consoleButton)
    } else {
      const totals = summarizeRequests(rows)
      const metrics = node('div', '', 'api-service-metrics')
      for (const [label,value] of [['客户端调用',String(totals.count)], ['成功 / 失败 / 已取消',`${totals.succeeded} / ${totals.failed} / ${totals.cancelled}`], ['输入 / 输出 Token',totals.tokensKnown ? `${totals.input} / ${totals.output}` : '未知或未完整返回'], ['余额 / 账单', balanceMetricValue(balance)]]) {
        const metric = node('div'); metric.append(node('span',label),node('strong',value)); metrics.append(metric)
      }
      content.append(metrics, node('p', '本次工具箱运行最近 200 条请求；自测单独标注，不计入客户端调用。入口调用不等于官方套餐用量，不收集对话内容或 Key。', 'platform-muted'))
      if (!rows.length) content.append(node('p', '暂无调用记录。启用后，重新打开 AI 并发送消息，再刷新这里。', 'platform-muted'))
      const list = node('ol', '', 'api-service-records')
      for (const row of rows.slice(0, 12)) {
        const item = node('li')
        const outcome = row.code === 'client_aborted' ? '已取消，未计入服务故障' : row.ok ? `成功 · ${row.durationMs} ms` : apiFailureMessage(row.code ?? 'upstream_error', row.provider)
        item.append(node('span', `${row.source === 'test' ? '接口自测' : '客户端调用'} · ${new Date(row.at).toLocaleTimeString()}`), node('span', outcome))
        list.append(item)
      }
      content.append(list)
    }
  }
  const cancelProbe = (): void => {
    // 与计费提示同一口径：中止的是「等结果」，已发出的请求服务商可能照规则计费。
    notice.textContent = '已取消检查，正在中止在飞的自测请求；已发出的请求可能仍按服务商规则计费。'
    void api.cancelServiceTests().catch(() => undefined)
  }
  const load = async (probe = false): Promise<void> => {
    if (busy || disposed) return
    busy = true; probeInFlight = probe
    notice.textContent = probe ? '正在向所选服务商发送测试请求，请稍候…' : ''; render()
    try {
      const result = await (probe ? api.testProvider({ shell, provider }) : api.serviceStatus())
      const value = readServiceSnapshot(result.snapshot)
      configuration = null
      balance = null
      try {
        if (api.providerBalance) {
          const value = JSON.parse((await api.providerBalance({ shell, provider })).snapshot) as { supported?: unknown; total?: unknown; currency?: unknown }
          if (typeof value?.supported === 'boolean') balance = { supported: value.supported,
            total: typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : null,
            currency: typeof value.currency === 'string' ? value.currency : '' }
        }
      } catch { /* 余额读不到就保持「请到官方控制台查看」，不影响诊断数据。 */ }
      try {
        const config = JSON.parse((await api.providerConfiguration({ shell, provider })).snapshot) as { endpoint?: unknown; model?: unknown }
        if (typeof config?.endpoint === 'string' && typeof config.model === 'string') configuration = { endpoint: config.endpoint, model: config.model }
      } catch { /* Show the live route, or an explicit unknown when metadata could not be read. */ }
      if (!disposed) { snapshot = value; notice.textContent = probe ? '检查已结束，结果如下。' : '' }
    } catch { if (!disposed) { snapshot = null; notice.textContent = '服务状态读取失败，请重试；这不是“没有用量”。' } }
    finally { busy = false; probeInFlight = false; render() }
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    // API-10：面板开着时的在飞自测请求随关闭一起中止，不留一个长等待的尾巴在后台占队列。
    if (probeInFlight) void api.cancelServiceTests().catch(() => undefined)
    dialog.remove(); if (priorFocus?.isConnected) priorFocus.focus()
  }
  dialog.addEventListener('close', dispose)
  document.body.append(dialog); dialog.showModal(); close.focus(); render(); void load()
  return dispose
}

export function readServiceSnapshot(raw: string): ApiServiceSnapshot {
  const value = JSON.parse(raw) as ApiServiceSnapshot
  if (!value || typeof value.running !== 'boolean' || !Array.isArray(value.routes) || !Array.isArray(value.requests) || !Array.isArray(value.checks)) throw new Error('API_SERVICE_INVALID')
  if (value.startupError && !Object.hasOwn(apiFailureMessages, value.startupError)) throw new Error('API_SERVICE_INVALID')
  for (const route of value.routes) if (!modelProviderIds.includes(route.provider) || !['codex','claude','hermes'].includes(route.shell) || typeof route.baseUrl !== 'string') throw new Error('API_SERVICE_INVALID')
  for (const request of value.requests) {
    if (!modelProviderIds.includes(request.provider) || !['codex','claude','hermes'].includes(request.shell) || !['test','client'].includes(request.source) || typeof request.ok !== 'boolean' || !Number.isFinite(Date.parse(request.at)) || !Number.isFinite(request.durationMs)) throw new Error('API_SERVICE_INVALID')
    if (request.code && !Object.hasOwn(apiFailureMessages, request.code)) throw new Error('API_SERVICE_INVALID')
    if ([request.inputTokens,request.outputTokens].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0))) throw new Error('API_SERVICE_INVALID')
  }
  value.checks.forEach(readApiCheck)
  return value
}
