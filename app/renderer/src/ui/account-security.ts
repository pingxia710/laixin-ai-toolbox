import type { AccountLogin } from '../../../account-types'
import { accountAction } from '../account-state'
import { actionButton, textNode } from './account-overview'

export function mountAccountSecurity(element: HTMLElement): void {
  const security = document.createElement('details'); security.className = 'account-security'
  security.append(textNode('summary', '修改密码与登录设备'))
  const passwordForm = document.createElement('form'); passwordForm.className = 'account-form'
  const current = passwordField(passwordForm, '当前密码', 'current-password')
  const next = passwordField(passwordForm, '新密码', 'new-password')
  const confirmation = passwordField(passwordForm, '确认新密码', 'new-password')
  const feedback = textNode('p', '', 'account-message'); feedback.setAttribute('role', 'status')
  const submit = textNode('button', '修改密码', 'primary-action'); submit.type = 'submit'
  passwordForm.append(textNode('p', '修改成功后，其他登录自动退出，账号原有权益保留。', 'account-note'), feedback, submit)
  passwordForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (next.value !== confirmation.value) { feedback.textContent = '两次新密码输入不一致。'; confirmation.focus(); return }
    const input = { currentPassword: current.value, password: next.value }
    current.value = ''; next.value = ''; confirmation.value = ''; submit.disabled = true
    void accountAction(() => window.toolbox.account.changePassword(input)).finally(() => { submit.disabled = false })
  })
  const devices = document.createElement('section'); devices.className = 'account-devices'
  const list = document.createElement('div'); const state = textNode('p', '', 'account-message'); state.setAttribute('role', 'status')
  let loading = false
  const refresh = actionButton('查看登录设备', () => { void load() })
  const load = async () => {
    if (loading) return
    loading = true; refresh.disabled = true; state.textContent = '正在读取登录设备…'
    try {
      const response = await window.toolbox.account.sessions()
      if (!devices.isConnected) return
      const sessions = JSON.parse(response.sessions) as AccountLogin[]
      list.replaceChildren()
      const names = { macos: 'Mac', windows: 'Windows', linux: 'Linux', web: '浏览器', unknown: '未记录设备类型' }
      for (const session of sessions) {
        const row = document.createElement('div'); row.className = 'account-session'
        row.append(textNode('strong', `${names[session.device]}${session.deviceId ? ` · 设备 ${session.deviceId.slice(-8)}` : ' · 旧版设备'}${session.current ? ' · 当前登录' : ''}`),
          textNode('p', session.createdAt ? `登录于 ${new Date(session.createdAt).toLocaleString('zh-CN')}` : '旧版登录，未记录登录时间', 'account-note'))
        if (!session.current) row.append(actionButton('退出此登录', () => { void accountAction(() => window.toolbox.account.revokeSession({ sessionId: session.id })).then(() => load()) }))
        list.append(row)
      }
      state.textContent = `共 ${sessions.length} 个有效登录。同一设备重复登录可能有多条记录。`
    } catch { if (devices.isConnected) state.textContent = '暂时无法读取登录设备，请重试。' }
    finally { loading = false; refresh.disabled = false }
  }
  devices.append(textNode('h3', '登录设备'), refresh, state, list)
  security.append(passwordForm, devices)

  const close = document.createElement('details'); close.className = 'account-security account-close'
  close.append(textNode('summary', '注销账号'))
  const closeForm = document.createElement('form'); closeForm.className = 'account-form'
  closeForm.append(textNode('p', '注销后不能再登录或找回此账号。历史订单保留供售后核对，不会自动退款。仍有效的网络和未完成订单须先处理。', 'account-note'))
  const password = passwordField(closeForm, '验证当前密码', 'current-password')
  const label = document.createElement('label'); label.className = 'password-visibility'
  const confirmed = document.createElement('input'); confirmed.type = 'checkbox'; confirmed.required = true
  label.append(confirmed, document.createTextNode('我确认注销当前来信账号'))
  const remove = textNode('button', '确认注销账号', 'secondary-action'); remove.type = 'submit'
  closeForm.append(label, remove)
  closeForm.addEventListener('submit', (event) => {
    event.preventDefault(); remove.disabled = true
    const input = { password: password.value, confirmed: confirmed.checked }; password.value = ''
    void accountAction(() => window.toolbox.account.closeAccount(input)).finally(() => { remove.disabled = false })
  })
  close.append(closeForm); element.append(security, close)
}

function passwordField(form: HTMLFormElement, label: string, autocomplete: 'current-password' | 'new-password'): HTMLInputElement {
  const row = textNode('label', label); const input = document.createElement('input')
  input.type = 'password'; input.autocomplete = autocomplete; input.required = true
  row.append(input); form.append(row); return input
}
