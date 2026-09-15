import type { PageModule } from './types'
import { accountAction, cancelAccountNavigation, finishAccountNavigation, onAccountChange, refreshAccount, takeAccountEntryMode } from '../account-state'
import { actionButton, mountAccountOverview, textNode } from '../ui/account-overview'
import { mountAccountSecurity } from '../ui/account-security'
import { mountDeviceReport } from '../ui/device-report'
import { revealSupport } from '../support-widget'
import { mountAccountServices } from '../ui/account-services'
import { inviteFieldHint } from '../../../commercial-copy'

// Recovery codes only live in this explicit, one-time dialog, never in account snapshots or browser storage.
function showRecoveryCode(value: string, username: string): Promise<void> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog'); dialog.className = 'recovery-dialog'
    const title = textNode('h2', '保存你的恢复码'); title.id = 'recovery-title'; dialog.setAttribute('aria-labelledby', title.id)
    const code = document.createElement('textarea'); code.readOnly = true; code.rows = 3; code.value = value
    code.setAttribute('aria-label', '一次性恢复码')
    const message = textNode('p', ''); message.setAttribute('role', 'status')
    const copy = actionButton('复制恢复码', () => {
      void Promise.resolve().then(() => navigator.clipboard.writeText(code.value)).then(() => { message.textContent = '已复制，请保存到你信任的密码管理器或安全位置。' })
        .catch(() => { code.focus(); code.select(); message.textContent = '自动复制失败，请手动复制选中的恢复码。' })
    })
    const done = actionButton('我已保存', () => { code.value = ''; dialog.close(); dialog.remove(); resolve() }, true)
    const buttons = document.createElement('div'); buttons.className = 'account-actions'; buttons.append(copy, done)
    dialog.append(title, textNode('p', `账号：${username}`), textNode('p', '恢复码只显示这一次。忘记密码时可凭账号和此码重设密码；使用或更换后，旧码立即失效。请勿发给他人。'), code, message, buttons)
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); message.textContent = '请先保存恢复码，再点击“我已保存”。' })
    document.body.append(dialog); dialog.showModal()
  })
}

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'account.customer', tab: 'account', order: 0,
  mount: (element) => {
    cleanup(); let active = true; let mode: 'login' | 'register' | 'recover' = takeAccountEntryMode(); let usernameValue = ''
    let unsubscribe = (): void => undefined
    let stopDeviceReport = (): void => undefined
    const render = () => {
      if (!active) return
      unsubscribe()
      unsubscribe = onAccountChange((view) => {
        if (!active) return
        stopDeviceReport()
        element.dataset.accountMode = view.state === 'signed-in' ? 'overview' : 'entry'
        element.className = 'account-workspace'
        const main = document.createElement('div'); main.className = 'account-main-grid'
        const access = document.createElement('section'); access.className = 'account-access account-panel'
        const overview = document.createElement('section'); overview.className = 'account-entitlements account-panel'
        const services = document.createElement('div'); services.className = 'account-service-grid'
        const safety = document.createElement('div'); safety.className = 'account-safety-grid'
        const securityPanel = document.createElement('section'); securityPanel.className = 'account-panel account-security-panel'
        const help = document.createElement('section'); help.className = 'account-panel account-help-panel'
        access.append(textNode('p', '来信账号', 'section-eyebrow'), textNode('h2', view.state === 'signed-in' ? '已登录' : mode === 'recover' ? '找回密码' : mode === 'register' ? '注册来信账号' : '登录来信账号'))
        const message = textNode('p', view.message, 'account-message'); message.setAttribute('role', 'status'); access.append(message)
        mountAccountOverview(overview, view, 'account')
        main.append(access, overview); safety.append(securityPanel, help)
        element.replaceChildren(main, services, safety)
        mountAccountServices(services, view)
        securityPanel.append(textNode('h3', '账号安全'))
        if (view.state === 'signed-in') {
          const identity = document.createElement('dl'); identity.className = 'account-facts'
          for (const [label, value] of [['账号', view.account!.username], ['登录状态', '已登录'], ['密码恢复码', view.overview ? view.overview.recoveryReady ? '已设置' : '尚未设置' : '暂时无法获取']]) {
            const row = document.createElement('div'); row.append(textNode('dt', label), textNode('dd', value)); identity.append(row)
          }
          access.append(identity, textNode('p', '在右侧查看体验和套餐流量，在下方管理订单和账号安全。', 'account-note'))
          const buttons = document.createElement('div'); buttons.className = 'account-actions'
          buttons.append(actionButton('刷新权益', () => { void refreshAccount() }), actionButton('退出登录', () => { void accountAction(() => window.toolbox.account.logout()) }))
          const security = document.createElement('details'); security.className = 'account-security'
          security.append(textNode('summary', view.overview?.recoveryReady ? '更换密码恢复码' : '设置密码恢复码'))
          const recovery = document.createElement('form'); recovery.className = 'account-form'
          const label = textNode('label', '验证当前密码'); const password = document.createElement('input')
          password.name = 'currentPassword'; password.type = 'password'; password.autocomplete = 'current-password'; password.required = true
          label.append(password)
          const submit = textNode('button', '生成新恢复码', 'secondary-action'); submit.type = 'submit'
          recovery.append(textNode('p', '更换后旧恢复码立即失效。新码只显示一次，请妥善保存。', 'account-note'), label, submit)
          recovery.addEventListener('submit', (event) => {
            event.preventDefault(); submit.disabled = true
            const input = { password: password.value }; password.value = ''
            void accountAction(async () => {
              const response = await window.toolbox.account.rotateRecovery(input)
              if (response.recoveryCode) void showRecoveryCode(response.recoveryCode, view.account!.username)
              return response
            })
          })
          security.append(recovery)
          access.append(buttons)
          securityPanel.append(security)
          stopDeviceReport = mountDeviceReport(help)
          mountAccountSecurity(securityPanel); return
        }
        securityPanel.append(textNode('p', view.state === 'signed-out' ? '登录后可管理密码、恢复码和登录设备。' : '账号状态暂时无法读取，请刷新后查看。', 'account-note'))
        help.append(textNode('h3', '客服协助'), textNode('p', '登录后可主动发送基本电脑配置并获得回执，便于客服协助。', 'account-note'), actionButton('联系来信客服', revealSupport))
        if (view.state === 'unavailable') {
          access.append(actionButton('重新读取账号', () => { void refreshAccount() })); return
        }
        const form = document.createElement('form'); form.className = 'account-form'
        const field = (label: string, name: string, type: string, autocomplete: string) => {
          const row = document.createElement('label'); const title = textNode('span', label); title.id = `account-${name}-label`; row.append(title)
          const input = document.createElement('input'); input.type = type; input.name = name; input.autocomplete = autocomplete as AutoFill
          input.required = true
          if (name === 'recoveryCode') { input.minLength = 48; input.maxLength = 80 }
          input.setAttribute('aria-labelledby', title.id)
          row.append(input)
          const hint = name === 'username' ? mode === 'register' ? '取一个你熟悉、好记的账号名。' : '填写注册来信工具箱时使用的账号。'
            : name === 'recoveryCode' ? '填写保存的恢复码，或客服发放的一次性找回凭证。' : ''
          if (hint) { const note = textNode('small', hint, 'field-hint'); note.id = `account-${name}-hint`; input.setAttribute('aria-describedby', note.id); row.append(note) }
          form.append(row); return input
        }
        const username = field('账号', 'username', 'text', 'username'); username.value = usernameValue
        username.addEventListener('input', () => { usernameValue = username.value })
        const recoveryCode = mode === 'recover' ? field('恢复码', 'recoveryCode', 'text', 'off') : undefined
        const password = field(mode === 'recover' ? '新密码' : '密码', 'password', 'password', mode === 'login' ? 'current-password' : 'new-password')
        const confirmation = mode !== 'login' ? field('确认密码', 'confirmation', 'password', 'new-password') : undefined
        // 邀请有礼：注册时可填好友邀请码（选填）；不填的注册流程保持原样。
        const invite = mode === 'register' ? field('邀请码（选填）', 'inviteCode', 'text', 'off') : undefined
        if (invite) { invite.required = false; invite.maxLength = 32; const hint = textNode('small', inviteFieldHint(view.terms), 'field-hint'); hint.id = 'account-inviteCode-hint'; invite.setAttribute('aria-describedby', hint.id); invite.parentElement?.append(hint) }
        const show = document.createElement('label'); show.className = 'password-visibility'
        const toggle = document.createElement('input'); toggle.type = 'checkbox'
        toggle.addEventListener('change', () => { password.type = toggle.checked ? 'text' : 'password'; if (confirmation) confirmation.type = password.type })
        show.append(toggle, document.createTextNode('显示密码')); form.append(show)
        if (mode === 'register') form.append(textNode('p', '无需手机或邮箱。注册后请保存恢复码，忘记密码时用它找回账号。', 'account-note'))
        if (mode === 'recover') form.append(textNode('p', '输入原恢复码或客服核验后发放的一次性找回凭证。重设后旧登录全部失效，原购买权益保留。两者都没有时，联系客服提供原购买订单和付款归属证明；不要发送密码或恢复码。', 'account-note'))
        const submit = textNode('button', mode === 'register' ? '注册账号' : mode === 'recover' ? '重设密码' : '登录', 'primary-action'); submit.type = 'submit'
        submit.disabled = view.code === 'ACCOUNT_NOT_CONFIGURED'; form.append(submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          if (confirmation && password.value !== confirmation.value) { message.textContent = '两次密码输入不一致。'; confirmation.focus(); return }
          submit.disabled = true
          const input = { username: username.value, password: password.value, inviteCode: invite?.value.trim() ?? '' }; const code = recoveryCode?.value.trim() ?? ''
          const operation = mode
          password.value = ''; if (confirmation) confirmation.value = ''; if (recoveryCode) recoveryCode.value = ''; if (invite) invite.value = ''
          let saved: Promise<void> | undefined
          void accountAction(async () => {
            const response = operation === 'recover'
              ? await window.toolbox.account.recover({ username: input.username, password: input.password, recoveryCode: code })
              : await window.toolbox.account[operation](input)
            if (response.recoveryCode) {
              if (operation === 'recover') mode = 'login'
              saved = showRecoveryCode(response.recoveryCode, input.username)
            }
            return response
          }).then(async (next) => {
            await saved
            if (active && next.state === 'signed-in') finishAccountNavigation()
          })
        })
        const actions = document.createElement('div'); actions.className = 'account-actions'
        actions.append(actionButton(mode === 'login' ? '没有账号，去注册' : '已有账号，去登录', () => { mode = mode === 'login' ? 'register' : 'login'; render() }))
        if (mode === 'recover') actions.append(actionButton('恢复码也丢了，联系客服', revealSupport))
        if (mode === 'login') actions.append(actionButton('忘记密码', () => { mode = 'recover'; render() }))
        actions.append(actionButton('返回', cancelAccountNavigation))
        access.append(form, actions)
      })
    }
    render(); void refreshAccount()
    cleanup = () => { active = false; unsubscribe(); stopDeviceReport(); element.replaceChildren() }
  }, unmount: () => cleanup()
}
