import type { PageModule } from './types'
import type { AccountView } from '../../../account-types'
import { accountAction, cancelAccountNavigation, finishAccountNavigation, onAccountChange, refreshAccount, takeAccountEntryMode } from '../account-state'
import { actionButton, mountAccountOverview, textNode } from '../ui/account-overview'
import { mountAccountSecurity } from '../ui/account-security'
import { mountDeviceReport } from '../ui/device-report'
import { revealSupport } from '../support-widget'
import { mountAccountServices } from '../ui/account-services'
import { inviteFieldHint } from '../../../commercial-copy'
import { mountWechatLoginPanel } from '../ui/wechat-login-panel'

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
    let wechatPending: Promise<AccountView> | undefined
    let wechatCanNavigate = true
    let inlineAttempted = false
    let revealWechat = true
    let stopWechatPanel = (): void => undefined
    const startWechat = (kind: 'login' | 'bind', container: HTMLElement, inline = false) => {
      if (wechatPending) return
      wechatCanNavigate = true
      const waiting = textNode('p', kind === 'bind' ? '已打开微信网页。扫码后请在网页输入当前账号密码完成绑定，工具箱正在等待结果…'
        : '已打开微信网页。扫码后请在网页登录或注册来信账号，工具箱正在等待结果…', 'account-note')
      waiting.setAttribute('role', 'status')
      const cancel = actionButton('取消本次验证', () => {
        void window.toolbox.account.cancelWechatLogin().then(({ cancelled }) => {
          if (cancelled) { waiting.textContent = '已取消，稍后可重新发起。'; cancel.disabled = true }
        })
      })
      if (!inline) container.append(waiting, cancel)
      const pending = accountAction(async () => {
        try {
          const response = await (inline ? window.toolbox.account.wechatInlineLogin() : window.toolbox.account.wechatLogin({ mode: kind }))
          if (response.recoveryCode) {
            const view = JSON.parse(response.snapshot) as AccountView
            void showRecoveryCode(response.recoveryCode, view.account?.username ?? '')
          }
          return response
        } finally { wechatPending = undefined }
      })
      wechatPending = pending
      void pending.then((next) => { if (active && wechatCanNavigate && next.state === 'signed-in') finishAccountNavigation() })
        .finally(() => { if (wechatPending === pending) wechatPending = undefined; waiting.remove(); cancel.remove() })
    }
    const render = () => {
      if (!active) return
      unsubscribe()
      unsubscribe = onAccountChange((view) => {
        if (!active) return
        stopDeviceReport()
        stopWechatPanel()
        element.dataset.accountMode = view.state === 'signed-in' ? 'overview' : 'entry'
        element.className = 'account-workspace'
        const main = document.createElement('div'); main.className = 'account-main-grid'
        const access = document.createElement('section'); access.className = 'account-access account-panel'
        const overview = document.createElement('section'); overview.className = 'account-entitlements account-panel'
        const services = document.createElement('div'); services.className = 'account-service-grid'
        const safety = document.createElement('div'); safety.className = 'account-safety-grid'
        const securityPanel = document.createElement('section'); securityPanel.className = 'account-panel account-security-panel'
        const help = document.createElement('section'); help.className = 'account-panel account-help-panel'
        if (view.state === 'signed-out' && mode === 'login') {
          const heading = document.createElement('div'); heading.className = 'account-entry-heading'
          const back = actionButton('返回', cancelAccountNavigation); back.className = 'account-text-action'
          heading.append(textNode('h2', '登录来信账号'), back); access.append(heading)
        } else access.append(textNode('p', '来信账号', 'section-eyebrow'), textNode('h2', view.state === 'signed-in' ? '已登录' : mode === 'recover' ? '找回密码' : mode === 'register' ? '注册来信账号' : '登录来信账号'))
        const message = textNode('p', view.message, 'account-message'); message.setAttribute('role', 'status'); access.append(message)
        mountAccountOverview(overview, view, 'account')
        main.append(access, overview); safety.append(securityPanel, help)
        element.replaceChildren(main, services, safety)
        mountAccountServices(services, view)
        securityPanel.append(textNode('h3', '账号安全'))
        if (view.state === 'signed-in') {
          // A later logout starts a new login visit; cancelled guest attempts do not.
          inlineAttempted = false
          revealWechat = true
          const identity = document.createElement('dl'); identity.className = 'account-facts'
          const facts = [['账号', view.account!.username], ['登录状态', '已登录']]
          if (view.terms?.wechatLoginAvailable === true) facts.push(['微信', view.overview?.wechatBound === true ? '已绑定'
            : view.overview?.wechatBound === false ? '未绑定' : '暂时无法获取'])
          facts.push(['密码恢复码', view.overview ? view.overview.recoveryReady ? '已设置' : '尚未设置' : '暂时无法获取'])
          for (const [label, value] of facts) {
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
          if (view.terms?.wechatLoginAvailable === true && view.overview?.wechatBound === false) {
            const bind = document.createElement('details'); bind.className = 'account-security'
            bind.append(textNode('summary', '绑定微信到当前账号'))
            bind.append(textNode('p', '扫码后在网页确认当前账号密码。绑定后原套餐和流量仍归属这个账号。', 'account-note'),
              actionButton('打开微信绑定网页', () => startWechat('bind', bind)))
            access.append(bind)
          }
          if (view.overview?.passwordReady === false) {
            securityPanel.append(textNode('p', '你使用微信注册，无需密码即可登录。若要使用账号密码登录，可退出后用保存的恢复码在「忘记密码」中设置密码。', 'account-note'))
          } else securityPanel.append(security)
          stopDeviceReport = mountDeviceReport(help)
          mountAccountSecurity(securityPanel, view.overview?.passwordReady !== false); return
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
          const hint = name === 'username' ? mode === 'register' ? '取一个你熟悉、好记的账号名。' : mode === 'login' ? '' : '填写注册来信工具箱时使用的账号。'
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
        const submit = textNode('button', mode === 'register' ? '注册账号' : mode === 'recover' ? '重设密码' : '账号密码登录', 'primary-action'); submit.type = 'submit'
        submit.disabled = view.code === 'ACCOUNT_NOT_CONFIGURED'; form.append(submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          if (confirmation && password.value !== confirmation.value) { message.textContent = '两次密码输入不一致。'; confirmation.focus(); return }
          submit.disabled = true
          const input = { username: username.value, password: password.value, inviteCode: invite?.value.trim() ?? '' }; const code = recoveryCode?.value.trim() ?? ''
          const operation = mode
          password.value = ''; if (confirmation) confirmation.value = ''; if (recoveryCode) recoveryCode.value = ''; if (invite) invite.value = ''
          let saved: Promise<void> | undefined
          const complete = async () => {
            if (wechatPending) {
              wechatCanNavigate = false
              const pending = wechatPending
              const { cancelled } = await window.toolbox.account.cancelWechatLogin()
              if (!cancelled) { message.textContent = '暂未取消微信验证，请先取消后再使用账号密码登录。'; submit.disabled = false; return }
              await pending
              if (!active) return
            }
            const next = await accountAction(async () => {
              const response = operation === 'recover'
                ? await window.toolbox.account.recover({ username: input.username, password: input.password, recoveryCode: code })
                : await window.toolbox.account[operation](input)
              if (response.recoveryCode) {
                if (operation === 'recover') mode = 'login'
                saved = showRecoveryCode(response.recoveryCode, input.username)
              }
              return response
            })
            await saved
            if (active && next.state === 'signed-in') finishAccountNavigation()
          }
          void complete().catch(() => { message.textContent = '暂时无法切换登录方式，请取消微信验证后重试。'; submit.disabled = false })
        })
        const actions = document.createElement('div'); actions.className = 'account-actions'
        const changeMode = (next: typeof mode) => {
          mode = next; inlineAttempted = false; revealWechat = true
          if (wechatPending) void window.toolbox.account.cancelWechatLogin().catch(() => undefined)
          render()
        }
        actions.append(actionButton(mode === 'login' ? '没有账号，去注册' : '已有账号，去登录', () => changeMode(mode === 'login' ? 'register' : 'login')))
        if (mode === 'recover') actions.append(actionButton('恢复码也丢了，联系客服', revealSupport))
        if (mode === 'login') actions.append(actionButton('忘记密码', () => changeMode('recover')))
        if (mode !== 'login') actions.append(actionButton('返回', cancelAccountNavigation))
        if (mode === 'login') {
          const columns = document.createElement('div'); columns.className = 'account-login-columns'
          const credentials = document.createElement('section'); credentials.className = 'account-password-panel'
          credentials.setAttribute('aria-label', '账号密码登录')
          credentials.append(textNode('h3', '账号密码登录'), form, actions)
          const wechat = document.createElement('section'); wechat.className = 'account-wechat-panel'
          wechat.setAttribute('aria-label', '微信登录')
          const wechatTitle = textNode('h3', '微信登录'); wechat.append(wechatTitle)
          if (view.terms?.wechatLoginAvailable === true) {
            const slot = document.createElement('div'); slot.className = 'account-wechat-frame'
            const status = textNode('p', wechatPending || !inlineAttempted ? '正在加载微信登录…' : '本次微信验证已结束，可刷新二维码重试。', 'account-note')
            status.setAttribute('role', 'status'); slot.append(status)
            const feedback = textNode('p', '', 'account-note account-wechat-feedback'); feedback.setAttribute('role', 'status')
            wechat.append(slot, feedback)
            const retry = actionButton('刷新二维码', () => { inlineAttempted = false; revealWechat = true; render() }, true)
            const cancelInline = actionButton('取消本次验证', () => {
              inlineAttempted = true
              void window.toolbox.account.cancelWechatLogin().then(({ cancelled }) => {
                if (!cancelled) feedback.textContent = '暂未取消，请稍后重试。'
              }).catch(() => { feedback.textContent = '暂时无法取消，请稍后重试。' })
            })
            cancelInline.className = 'account-text-action'
            wechat.append(wechatPending || !inlineAttempted ? cancelInline : retry)
            queueMicrotask(() => {
              if (!active || mode !== 'login' || element.dataset.accountMode !== 'entry' || !slot.isConnected) return
              if (revealWechat) { revealWechat = false; slot.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }
              if (wechatPending || !inlineAttempted) stopWechatPanel = mountWechatLoginPanel(slot,
                () => { feedback.textContent = '微信登录暂时无法显示，请取消后刷新重试。' },
                (mode) => {
                  wechatTitle.textContent = mode === 'quick' ? '微信快捷登录' : mode === 'qr' ? '微信扫码登录' : '微信登录'
                })
              if (!inlineAttempted && !wechatPending) { inlineAttempted = true; startWechat('login', wechat, true) }
            })
          } else {
            wechat.append(textNode('p', '暂未开放微信登录，请使用账号密码登录。', 'account-note'))
          }
          columns.append(credentials, wechat)
          access.append(columns)
        } else access.append(form, actions)
      })
    }
    render(); void refreshAccount()
    cleanup = () => { active = false; stopWechatPanel(); if (wechatPending) void window.toolbox.account.cancelWechatLogin(); unsubscribe(); stopDeviceReport(); element.replaceChildren() }
  }, unmount: () => cleanup()
}
