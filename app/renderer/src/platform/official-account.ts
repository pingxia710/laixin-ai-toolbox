import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { OfficialAccountApi } from '../../../preload/api/official-account'
import type { OfficialAccount } from '../../../shared/official-account'
import { readClaudeLoginStatus, readCodexLoginStatus, type ClaudeOfficialLoginStatus } from './access-status'
import type { AccountSummary, MountUsage } from './overview'
import { requestPlatformDownloadNavigation } from '../navigation'
import { icon } from '../icons'

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}

export function mountOfficialAccount(body: HTMLElement, footer: HTMLElement, shell: 'codex' | 'claude', accounts: OfficialAccountApi | undefined,
  api: AiAccessApi | undefined, mountUsage: MountUsage, onAccount: (account: AccountSummary | null) => void, onActivated: () => void): () => void {
  let mounted = true
  let busy = false
  let login: ClaudeOfficialLoginStatus = 'idle'
  let account: OfficialAccount | null = null
  let message = ''
  let codeDraft = ''
  let stopUsage = (): void => undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const label = shell === 'codex' ? 'Codex' : 'Claude Code'
  const pending = (): boolean => login === 'pending' || login === 'code-required'
  const action = (text: string, click: () => void, primary = false): HTMLButtonElement => {
    const button = node('button', text, primary ? 'primary-action' : 'secondary-action')
    button.type = 'button'; button.disabled = busy; button.onclick = click
    return button
  }
  const render = (): void => {
    stopUsage(); stopUsage = () => undefined
    body.replaceChildren(); footer.replaceChildren()
    onAccount(account?.state === 'signed-in' && !pending() ? { accountLabel: account.accountLabel ?? `${label} 账号`, plan: account.plan } : null)
    body.dataset.officialState = pending() ? login : account?.state ?? 'loading'
    if (account?.state === 'signed-in' && !pending() && !busy) {
      stopUsage = mountUsage(body, summary => { if (mounted && summary) onAccount({ ...summary, accountLabel: summary.accountLabel || account?.accountLabel || `${label} 账号` }) }, () => {
        if (!mounted) return
        account = { state: 'signed-out', accountLabel: null, plan: null }; render()
      }, account.accountKey)
      if (message) { const notice = node('p', message, 'platform-notice'); notice.setAttribute('role', 'status'); body.prepend(notice) }
      footer.append(action('刷新账号', () => { void checkAccount() }), action('重新登录', () => { void run('start') }))
      return
    }
    const empty = node('div', '', 'official-account-empty')
    const symbol = icon('account'); symbol.classList.add('official-account-symbol')
    const state = account?.state
    const title = pending() ? login === 'code-required' ? '粘贴官方登录码' : '等待官方登录'
      : !account || busy ? '正在确认账号…' : state === 'not-installed' ? `先安装 ${label}` : state === 'unavailable' ? '账号状态未确认' : '暂无账号'
    const description = pending() ? '请在官方页面完成登录，成功后这里会自动更新。'
      : state === 'not-installed' ? `安装 ${label} 后即可添加官方账号。`
      : state === 'unavailable' ? '暂时无法确认本机登录状态，可重新读取或发起官方登录。'
      : state === 'unsupported' ? '当前使用的是 API 登录方式，添加官方账号后查看套餐用量。'
      : `添加 ${label} 官方账号，登录后查看套餐和用量。`
    const notice = node('p', message || description, 'platform-muted')
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
    empty.append(symbol, node('h3', title), notice)
    if (login === 'code-required') {
      const form = node('form', '', 'official-account-code')
      const input = node('input'); input.type = 'password'; input.autocomplete = 'off'; input.placeholder = '粘贴登录码'; input.setAttribute('aria-label', 'Claude 登录码')
      input.value = codeDraft; input.oninput = () => { codeDraft = input.value }
      const submit = action('提交登录码', () => undefined, true); submit.type = 'submit'
      form.onsubmit = event => { event.preventDefault(); if (input.value.trim()) void run('code', input.value) }
      form.append(input, submit); empty.append(form)
    } else if (!pending() && account) {
      if (state === 'not-installed') empty.append(action('查看下载/版本', () => requestPlatformDownloadNavigation(shell === 'codex' ? 'codex' : 'claude-code'), true))
      else {
        const add = action('添加账号', () => { void run('start') }, true)
        add.disabled ||= !api; empty.append(add)
      }
    }
    if (pending()) footer.append(action('取消登录', () => { void run('cancel') }))
    else if (account) footer.append(action('刷新账号', () => { void checkAccount() }))
    body.append(empty)
  }
  const poll = (): void => {
    clearTimeout(timer)
    if (!mounted || !pending()) return
    timer = setTimeout(async () => {
      if (!mounted || !api || busy) { poll(); return }
      try {
        const previous = login
        login = shell === 'codex' ? readCodexLoginStatus((await api.codexOfficialStatus()).snapshot) : readClaudeLoginStatus((await api.claudeOfficialStatus()).snapshot)
        if (!mounted) return
        if (login === 'connected') { message = ''; codeDraft = ''; onActivated(); await checkAccount(); return }
        if (!pending()) { message = '登录尚未完成，请重新添加账号。'; render(); return }
        if (login !== previous) render()
      } catch { if (mounted) { message = '登录状态暂时未读到，正在重新确认。' } }
      poll()
    }, 1000)
  }
  const checkAccount = async (): Promise<void> => {
    if (!mounted || busy) return
    busy = true; message = ''; render()
    try {
      if (!accounts) throw new Error('OFFICIAL_ACCOUNT_UNAVAILABLE')
      if (api) login = shell === 'codex' ? readCodexLoginStatus((await api.codexOfficialStatus()).snapshot) : readClaudeLoginStatus((await api.claudeOfficialStatus()).snapshot)
      const value = JSON.parse((await accounts.read({ shell })).snapshot) as OfficialAccount
      if (!['signed-in', 'signed-out', 'not-installed', 'unsupported', 'unavailable'].includes(value.state)) throw new Error('OFFICIAL_ACCOUNT_INVALID')
      account = value
    } catch { account = { state: 'unavailable', accountLabel: null, plan: null } }
    finally { busy = false; if (mounted) { render(); poll() } }
  }
  const run = async (step: 'start' | 'cancel' | 'code', code = ''): Promise<void> => {
    if (!api || busy) return
    busy = true; message = ''; clearTimeout(timer)
    // Starting a new login stops polling quota for the previous identity.
    if (step === 'start') login = 'pending'
    render()
    try {
      const result = shell === 'codex'
        ? await (step === 'cancel' ? api.cancelCodexOfficialLogin() : api.startCodexOfficialLogin())
        : await (step === 'cancel' ? api.cancelClaudeOfficialLogin() : step === 'code' ? api.submitClaudeLoginCode({ code }) : api.startClaudeOfficialLogin())
      login = shell === 'codex' ? readCodexLoginStatus(result.snapshot) : readClaudeLoginStatus(result.snapshot)
      if (step === 'code' || step === 'cancel') codeDraft = ''
      if (login === 'failed') message = '登录未完成，请检查网络后重新添加账号。'
      if (login === 'not-installed') account = { state: 'not-installed', accountLabel: null, plan: null }
    } catch { login = 'failed'; message = '官方登录未能启动，请确认软件已安装且能够联网。' }
    finally {
      busy = false
      if (mounted) {
        render(); poll()
        if (login === 'connected' || step === 'cancel') { onActivated(); void checkAccount() }
      }
    }
  }
  render(); void checkAccount()
  return () => { mounted = false; clearTimeout(timer); stopUsage(); codeDraft = ''; body.replaceChildren(); footer.replaceChildren() }
}
