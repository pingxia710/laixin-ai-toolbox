import { applyTheme, currentThemeSetting, type Theme } from '../theme'
import { faultEntry, faultListHead, readFaultRecords } from '../recent-faults'
import { button } from '../page-ui'
import { revealSupport } from '../support-widget'
import type { PageModule } from './types'
import type { DesktopView, UpdateView } from '../../../desktop-types'
import { displayReleaseVersion } from '../../../release-version'
import { icon } from '../icons'

// 下载进行中 1 秒跟进进度;其余 15 秒足够,⛔ 一律 1 秒轮询。
export function settingsPollDelayMs(updateState: string): number {
  return updateState === 'downloading' ? 1000 : 15_000
}

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'settings.boundaries', tab: 'settings', order: 0,
  mount: (element) => {
    let active = true
    const group = (title: string) => {
      const section = document.createElement('section'); section.className = 'settings-group'
      section.append(Object.assign(document.createElement('h2'), { textContent: title })); element.append(section)
      return section
    }
    element.replaceChildren()
    const appearance = group('外观')
    const row = document.createElement('div'); row.className = 'setting-row'
    const label = document.createElement('label'); label.htmlFor = 'theme-select'; label.textContent = '界面外观'
    const select = document.createElement('select'); select.id = 'theme-select'; select.className = 'theme-select'
    for (const [value, text] of [['light', '浅色'], ['dark', '深色'], ['console', '深蓝'], ['classic', '经典']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option)
    }
    select.value = currentThemeSetting()
    select.addEventListener('change', () => applyTheme(select.value as Theme))
    row.append(label, select); appearance.append(row)

    const feedback = document.createElement('p'); feedback.className = 'account-note'; feedback.setAttribute('role', 'status')
    const zoomRow = document.createElement('div'); zoomRow.className = 'setting-row'
    const zoomLabel = document.createElement('label'); zoomLabel.htmlFor = 'zoom-select'; zoomLabel.textContent = '界面缩放'
    const zoom = document.createElement('select'); zoom.id = 'zoom-select'; zoom.className = 'theme-select'; zoom.disabled = true
    for (const value of ['1', '1.1', '1.25', '1.5']) zoom.append(Object.assign(document.createElement('option'), { value, textContent: `${Math.round(Number(value) * 100)}%` }))
    zoomRow.append(zoomLabel, zoom); appearance.append(zoomRow, Object.assign(document.createElement('p'), { className: 'account-note', textContent: '自动记住缩放比例和窗口大小、位置。' }), feedback)

    const background = group('后台与提醒')
    const backgroundNote = document.createElement('p'); backgroundNote.className = 'account-note'
    const notifyLabel = document.createElement('label'); notifyLabel.className = 'setting-row'
    const notify = document.createElement('input'); notify.type = 'checkbox'; notify.disabled = true
    notifyLabel.append(Object.assign(document.createElement('span'), { textContent: '额度不足时提醒我' }), notify)
    background.append(backgroundNote, notifyLabel, Object.assign(document.createElement('p'), { className: 'account-note', textContent: 'AI 额度或网络流量剩余 10% 及以下时提醒。两者分别计算，同一周期不重复打扰。' }))
    // 「工具箱意外退出时，网络不断」：说的是**意外**——崩溃、被安全软件关掉、开机还没打开工具箱。
    // ⛔ 出现「常驻」「守护」「LaunchAgent」这类词，客户不认识；也 ⛔ 写成「关掉工具箱后保持连接」，
    // 那句上面那条后台说明已经讲过（关窗口≠退出），两句话摆在一起客户分不清是两回事还是一回事。
    const residentLabel = document.createElement('label'); residentLabel.className = 'setting-row'
    const residentToggle = document.createElement('input'); residentToggle.type = 'checkbox'; residentToggle.disabled = true
    residentLabel.append(Object.assign(document.createElement('span'), { textContent: '工具箱意外退出时，网络不断' }), residentToggle)
    const residentNote = document.createElement('p'); residentNote.className = 'account-note'
    const residentDefaultNote = '打开后，工具箱崩溃、被系统或安全软件关掉、或者开机后你还没打开工具箱，网络都照常连着。你点断开、退出账号，或选择“退出工具箱”时，网络照样会断开。'
    // 客户选了开、但这次没装上：开关显示着开而那件事并没有发生，就是假装成功，必须说出来。
    // ⛔ 把开关拨回去（那是替客户改了他的选择，比静默失败更糟），也 ⛔ 弹窗——网络本身好好的，
    // 丢的只是「工具箱不在时保持」。下次打开工具箱会按客户的选择再装一次，所以说得清「还会再试」。
    const residentInactiveNote = '已记下你的选择，但这次没能生效：工具箱关掉后网络不会保持。网络本身不受影响，下次打开工具箱会再试一次。'
    const residentNoteFor = (status: { enabled: boolean; supported: boolean; active: boolean }): string =>
      !status.supported ? '当前安装暂不支持这项设置。' : status.enabled && !status.active ? residentInactiveNote : residentDefaultNote
    residentNote.textContent = residentDefaultNote
    background.append(residentLabel, residentNote)
    // 读状态失败 ⛔ 把开关永久留在禁用态:控件创建时就是 disabled,只有读成功那一支解禁,
    // catch 那一支只改文案 —— 一次偶发的读失败等于客户再也点不了它,而文案写着「暂时」。
    // 挂到本页本来就有的轮询上重试,偶发失败自己就恢复了。(0.4.10 的开机自启就坏在这个形状上:
    // 读必失败 + 只改文案不解禁 + 文案看起来像临时故障 = 没人发现开关根本点不了。)
    const readResident = async (): Promise<boolean> => {
      try {
        const status = await window.toolbox.desktop.residentEnabled()
        if (!active) return true
        residentToggle.checked = status.enabled; residentToggle.disabled = !status.supported
        residentNote.textContent = residentNoteFor(status)
        return true
      } catch { if (active) residentNote.textContent = '暂时无法读取这项设置的状态，正在重试。'; return false }
    }
    residentToggle.addEventListener('change', () => {
      const wanted = residentToggle.checked
      residentToggle.disabled = true
      void (async () => {
        try {
          const status = await window.toolbox.desktop.setResidentEnabled({ enabled: wanted })
          if (!active) return
          residentToggle.checked = status.enabled; residentToggle.disabled = false
          // 关掉要当场把「以后自动拉起」撤掉；撤不掉时主进程照实回 supported=false，
          // 这里就得把开关拨回真实状态并说清「没生效」，⛔ 让客户以为关掉了。
          if (!status.supported) residentNote.textContent = '这项设置没有保存成功，请重试或联系来信客服。'
          else { residentNote.textContent = residentNoteFor(status); feedback.textContent = '已保存' }
        } catch { if (active) { residentToggle.disabled = false; residentNote.textContent = '暂时无法保存这项设置，请重试。' } }
      })()
    })
    // FB-1 自动回传开关。与客户主动点的「一键上报」不同,自动回传必须让客户看得见、关得掉;
    // 说明只讲我们回传什么:故障类型,⛔ 写「诊断数据」这类可以装下任何东西的词。
    const failureLabel = document.createElement('label'); failureLabel.className = 'setting-row'
    const failureToggle = document.createElement('input'); failureToggle.type = 'checkbox'; failureToggle.disabled = true
    failureLabel.append(Object.assign(document.createElement('span'), { textContent: '连接失败时自动告知来信故障类型' }), failureToggle)
    const failureNote = document.createElement('p'); failureNote.className = 'account-note'
    failureNote.textContent = '连不上网络时，工具箱自动告诉我们是哪一类故障（如组件缺失、端口占用、权益到期），方便下一版修对方向。只回传故障类型，不含任何个人信息或使用记录。'
    background.append(failureLabel, failureNote)
    const readFailureReport = async (): Promise<boolean> => {
      try {
        const status = await window.toolbox.desktop.failureReportEnabled()
        if (!active) return true
        failureToggle.checked = status.enabled; failureToggle.disabled = !status.supported
        return true
      } catch { if (active) failureNote.textContent = '暂时无法读取这项设置的状态，正在重试。'; return false }
    }
    failureToggle.addEventListener('change', () => {
      failureToggle.disabled = true
      void (async () => {
        try {
          const status = await window.toolbox.desktop.setFailureReportEnabled({ enabled: failureToggle.checked })
          if (!active) return
          failureToggle.checked = status.enabled; failureToggle.disabled = false
          if (!status.supported) failureNote.textContent = '这项设置没有保存成功，请重试或联系来信客服。'
          else feedback.textContent = '已保存'
        } catch { if (active) { failureToggle.disabled = false; failureNote.textContent = '暂时无法保存这项设置，请重试。' } }
      })()
    })
    const loginLabel = document.createElement('label'); loginLabel.className = 'setting-row'
    const loginToggle = document.createElement('input'); loginToggle.type = 'checkbox'; loginToggle.disabled = true
    loginLabel.append(Object.assign(document.createElement('span'), { textContent: '开机自动启动来信 AI 工具箱' }), loginToggle)
    const loginNote = document.createElement('p'); loginNote.className = 'account-note'
    loginNote.textContent = '开机启动后，AI网络是否连接仍由你上次的选择决定；退出工具箱后不会自动重启。'
    const loginDefaultNote = loginNote.textContent
    background.append(loginLabel, loginNote)
    const readLoginItem = async (): Promise<boolean> => {
      try {
        const status = await window.toolbox.desktop.loginItem()
        if (!active) return true
        loginToggle.checked = status.enabled; loginToggle.disabled = !status.supported
        loginNote.textContent = status.supported ? loginDefaultNote : '当前安装暂不支持开机自启。'
        return true
      } catch { if (active) loginNote.textContent = '暂时无法读取开机自启状态，正在重试。'; return false }
    }
    // 读成功就从待重试表里去掉;没读成功的每轮轮询再试一次。
    const pendingReads = new Map<string, () => Promise<boolean>>([['resident', readResident], ['loginItem', readLoginItem], ['failureReport', readFailureReport]])
    const attemptPendingReads = async (): Promise<void> => {
      for (const [key, read] of [...pendingReads]) if (await read()) pendingReads.delete(key)
    }
    void attemptPendingReads()
    loginToggle.addEventListener('change', () => {
      loginToggle.disabled = true
      void (async () => {
        try {
          const status = await window.toolbox.desktop.setLoginItem({ enabled: loginToggle.checked })
          if (!active) return
          loginToggle.checked = status.enabled; loginToggle.disabled = !status.supported
          if (!status.supported) loginNote.textContent = '系统没有接受开机自启设置，请重试或联系来信客服。'
          else feedback.textContent = '已保存'
        } catch { if (active) { loginToggle.disabled = false; loginNote.textContent = '暂时无法保存开机自启设置，请重试。' } }
      })()
    })
    const updates = group('更新')
    const autoLabel = document.createElement('label'); autoLabel.className = 'setting-row'
    const auto = document.createElement('input'); auto.type = 'checkbox'; auto.disabled = true; auto.id = 'auto-update'
    autoLabel.append(Object.assign(document.createElement('span'), { textContent: '自动下载新版并提醒我' }), auto)
    updates.append(autoLabel, Object.assign(document.createElement('p'), { className: 'account-note', textContent: '工具箱会定期检查新版本，有新版时自动下载，下载完成后提醒。更新并重启由你点击确认，不会自动断开 AI网络。' }))
    // 保存进行中:此时三项是被本函数禁用的,⛔ 让轮询把它们提前解禁(客户会在保存途中又改一次)。
    let saving = false
    const configure = async () => {
      saving = true
      zoom.disabled = notify.disabled = auto.disabled = true
      try {
        const value = await window.toolbox.desktop.configure({ zoom: zoom.value, quotaNotifications: notify.checked, autoUpdate: auto.checked })
        if (active) { preferences(value); feedback.textContent = '已保存' }
      } catch { if (active) feedback.textContent = '暂时无法保存设置，请重试。' }
      finally { saving = false; if (active) zoom.disabled = notify.disabled = auto.disabled = false }
    }
    zoom.addEventListener('change', () => { void configure() }); notify.addEventListener('change', () => { void configure() }); auto.addEventListener('change', () => { void configure() })
    const preferences = (value: DesktopView) => {
      zoom.value = String(value.preferences.zoom); notify.checked = value.preferences.quotaNotifications; auto.checked = value.preferences.autoUpdate
      backgroundNote.textContent = value.backgroundAvailable ? '关闭窗口后工具箱仍在后台运行，AI网络保持连接。可从系统菜单栏或托盘打开；选择“退出工具箱”才会断开网络。' : '系统托盘暂不可用。关闭窗口将退出工具箱并断开 AI网络，请保持窗口打开。'
    }

    const help = group('帮助')
    const support = document.createElement('div'); support.className = 'setting-row'
    support.append(Object.assign(document.createElement('p'), { textContent: '安装或连接遇到问题时，来信客服可以协助处理。' }), button('联系来信客服', { onClick: revealSupport }))
    help.append(support)
    const diagRow = document.createElement('div'); diagRow.className = 'setting-row'
    const diagOutput = document.createElement('pre'); diagOutput.className = 'diagnostics-output'; diagOutput.hidden = true
    const diagStatus = document.createElement('p'); diagStatus.className = 'account-note'; diagStatus.setAttribute('role', 'status')
    const diagRun = button('一键诊断', { onClick: () => { void runDiagnostics() } })
    const diagCopy = button('复制诊断信息', { onClick: () => { void copyDiagnostics() } }); diagCopy.disabled = true
    diagRow.append(Object.assign(document.createElement('p'), { textContent: '出问题时先点一键诊断，把结果复制给来信客服，客服就能直接定位。' }), diagRun, diagCopy)
    // 最近故障单独列出来：客服问「你试过什么」时，客户自己就能看到，不用在整页诊断文本里找。
    const faultTitle = Object.assign(document.createElement('p'), { className: 'account-note', textContent: '最近故障与已试过的处理' })
    // 分列的字全部来自主进程给的结构化记录，⛔ 回头解析诊断全文。
    const faultList = document.createElement('ol'); faultList.className = 'fault-list'
    faultTitle.hidden = faultList.hidden = true
    help.append(diagRow, diagStatus, faultTitle, faultList, diagOutput)
    const runDiagnostics = async () => {
      diagRun.disabled = true; diagCopy.disabled = true; diagStatus.textContent = '正在检查网络、已装的 AI、模型接入与本机服务…（约十几秒）'
      try {
        const value = JSON.parse((await window.toolbox.diagnostics.run()).snapshot) as { text: string; errors: string[]; faults?: unknown }
        if (!active) return
        diagOutput.textContent = value.text; diagOutput.hidden = false; diagCopy.disabled = false
        const faults = readFaultRecords(value.faults)
        faultList.replaceChildren(...(faults.length ? [faultListHead(), ...faults.map(faultEntry)] : []))
        faultTitle.hidden = faultList.hidden = faults.length === 0
        diagStatus.textContent = value.errors.length ? `诊断完成，有 ${value.errors.length} 项没读到，已列在末尾。` : '诊断完成。'
      } catch { if (active) diagStatus.textContent = '诊断没有完成，请重试。' }
      finally { if (active) diagRun.disabled = false }
    }
    const copyDiagnostics = async () => {
      try { const value = JSON.parse((await window.toolbox.diagnostics.copy()).snapshot) as { copied: boolean }; if (active) diagStatus.textContent = value.copied ? '已复制，粘贴给来信客服即可。' : '请先点一键诊断。' }
      catch { if (active) diagStatus.textContent = '复制失败，请手动选中上面的内容复制。' }
    }

    const about = group('关于')
    const version = document.createElement('p'); version.className = 'settings-version'; version.textContent = '正在读取客户端版本…'
    const updateStatus = document.createElement('p'); updateStatus.setAttribute('role', 'status')
    const check = button('检查更新', { onClick: () => { void update('checkUpdate') } })
    const actions = document.createElement('div'); actions.className = 'action-row'; actions.append(check)
    about.append(version, updateStatus, actions)
    let clientVersion = ''
    let latestUpdate: UpdateView | undefined
    let updateDialog: HTMLDialogElement | undefined
    let dismissedUpdateVersion = ''

    const closeUpdateDialog = (): void => { updateDialog?.close() }
    const renderUpdateDialogContent = (dialog: HTMLDialogElement, value: UpdateView): void => {
      const release = dialog.querySelector<HTMLElement>('.update-dialog-release')
      const summary = dialog.querySelector<HTMLElement>('.update-dialog-summary')
      const notes = dialog.querySelector<HTMLElement>('.update-dialog-notes')
      const progress = dialog.querySelector<HTMLProgressElement>('.update-dialog-progress')
      const progressStatus = dialog.querySelector<HTMLElement>('.update-dialog-progress-status')
      const primary = dialog.querySelector<HTMLButtonElement>('.update-dialog-primary')
      if (!release || !summary || !notes || !progress || !progressStatus || !primary) return
      release.textContent = value.version ? `v${value.version}` : '正在检查版本…'
      summary.textContent = clientVersion === '' ? '正在读取当前版本…' : `当前版本 v${clientVersion}，新版本已可用。`
      notes.textContent = value.notes || '此版本未提供更新说明。'
      progress.hidden = value.state !== 'downloading'; progress.value = value.progress
      progressStatus.textContent = value.state === 'downloading' ? `${value.message} ${value.progress}%` : value.state === 'ready'
        ? '新版已下载并完成校验，确认后将重启工具箱。' : value.state === 'installing' ? value.message : ''
      progressStatus.hidden = progressStatus.textContent === ''
      const action = value.state === 'available' || value.state === 'error' ? 'downloadUpdate' : value.state === 'ready' ? 'installUpdate' : ''
      primary.dataset.updateAction = action
      primary.disabled = action === ''
      primary.replaceChildren()
      if (value.state === 'downloading') primary.append(icon('download'), document.createTextNode(`正在下载 ${value.progress}%`))
      else if (value.state === 'installing') primary.append(document.createTextNode('正在重启…'))
      else primary.append(icon('download'), document.createTextNode(value.state === 'ready' ? '更新并重启' : value.state === 'error' ? '重新下载' : '立即更新'))
    }
    const renderUpdateDialog = (value: UpdateView): void => {
      const relevant = ['available', 'downloading', 'ready', 'installing'].includes(value.state) || (value.state === 'error' && value.version !== '')
      if (!relevant) { closeUpdateDialog(); return }
      if (updateDialog === undefined && dismissedUpdateVersion === value.version) return
      if (updateDialog === undefined) {
        const dialog = document.createElement('dialog'); dialog.className = 'recovery-dialog update-dialog'
        const header = document.createElement('header'); header.className = 'update-dialog-header'
        const mark = document.createElement('span'); mark.className = 'update-dialog-mark'; mark.append(icon('sparkle'))
        const title = document.createElement('h2'); title.textContent = '发现新版本'; title.id = 'update-dialog-title'
        dialog.setAttribute('aria-labelledby', title.id)
        const close = document.createElement('button'); close.type = 'button'; close.className = 'update-dialog-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭更新窗口')
        close.addEventListener('click', () => dialog.close())
        header.append(mark, title, close)

        const content = document.createElement('div'); content.className = 'update-dialog-content'
        const release = document.createElement('p'); release.className = 'update-dialog-release'
        const summary = document.createElement('p'); summary.className = 'update-dialog-summary'
        const divider = document.createElement('div'); divider.className = 'update-dialog-divider'
        const notesTitle = document.createElement('h3'); notesTitle.textContent = '更新内容'
        const notes = document.createElement('div'); notes.className = 'update-dialog-notes'; notes.setAttribute('aria-label', '更新内容')
        const progress = document.createElement('progress'); progress.className = 'update-dialog-progress'; progress.max = 100; progress.setAttribute('aria-label', '新版下载进度')
        const progressStatus = document.createElement('p'); progressStatus.className = 'update-dialog-progress-status'; progressStatus.setAttribute('role', 'status')
        content.append(release, summary, divider, notesTitle, notes, progress, progressStatus)

        const footer = document.createElement('footer'); footer.className = 'update-dialog-actions'
        const later = button('稍后更新', { onClick: () => dialog.close() }); later.className = 'button update-dialog-later'
        const primary = document.createElement('button'); primary.type = 'button'; primary.className = 'button primary-action update-dialog-primary'
        primary.addEventListener('click', () => {
          const action = primary.dataset.updateAction
          if (action === 'downloadUpdate' || action === 'installUpdate') void update(action)
        })
        footer.append(later, primary); dialog.append(header, content, footer)
        dialog.addEventListener('close', () => {
          if (updateDialog === dialog) {
            dismissedUpdateVersion = latestUpdate?.version ?? ''
            updateDialog = undefined
          }
          dialog.remove()
        })
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close() })
        document.body.append(dialog); dialog.showModal(); updateDialog = dialog
      }
      renderUpdateDialogContent(updateDialog, value)
    }
    const renderUpdate = (value: UpdateView) => {
      latestUpdate = value
      updateStatus.textContent = value.message + (value.state === 'downloading' ? ` ${value.progress}%` : '')
      check.disabled = ['checking', 'downloading', 'installing'].includes(value.state)
      renderUpdateDialog(value)
    }
    const update = async (method: 'checkUpdate' | 'downloadUpdate' | 'installUpdate') => {
      if (method === 'checkUpdate') dismissedUpdateVersion = ''
      check.disabled = true
      try { const value = await window.toolbox.desktop[method](); if (active) renderUpdate(value) }
      // 桥本身失败时没有新状态可渲染，得自己把「检查更新」放开；成功路径由 renderUpdate 按状态决定，
      // ⛔ 在 finally 里无条件恢复（下载中本该保持禁用）。
      catch { if (active) { updateStatus.textContent = '操作未完成，请重试。'; check.disabled = false } }
    }
    let loading = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let pollDelay = settingsPollDelayMs('')
    const refresh = async (initial = false) => {
      if (loading || !active) return
      loading = true
      try {
        const value = await window.toolbox.desktop.status()
        if (!active) return
        renderUpdate(value.update)
        pollDelay = settingsPollDelayMs(value.update.state)
        // 跟两个开关同一个坏法:这三项创建时就是 disabled,原来只有 initial 那一次读成功才解禁,
        // 失败就永远停在禁用态——一次偶发的读失败 = 客户再也改不了缩放/提醒/自动更新,
        // 而文案写着「暂时」。改成「只要还锁着就补一次」:首次成功照旧,首次失败由后面的轮询接上。
        // 已经解禁之后 ⛔ 每轮都重写一遍(那会在客户刚改完的瞬间用后台旧值把选择盖回去)。
        if (!saving && (initial || zoom.disabled)) { preferences(value); zoom.disabled = notify.disabled = auto.disabled = false }
        if (pendingReads.size > 0) await attemptPendingReads()
      } catch { if (active) updateStatus.textContent = '暂时无法读取设置，正在重试。' }
      finally { loading = false }
    }
    const tick = (): void => {
      void (async () => {
        // 页面隐藏时暂停读取,回来后按当前节奏继续;⛔ 空闲时也每秒轮询。
        if (active && document.visibilityState !== 'hidden') await refresh()
        if (active) pollTimer = setTimeout(tick, pollDelay)
      })()
    }
    void refresh(true).then(() => { if (active) pollTimer = setTimeout(tick, pollDelay) })
    void window.toolbox.app.info().then((info) => {
      if (!active) return
      clientVersion = info.version
      version.textContent = `来信 AI 工具箱 · ${displayReleaseVersion(info.version)}`
      if (latestUpdate !== undefined) renderUpdateDialog(latestUpdate)
    })
      .catch(() => { if (active) version.textContent = '暂时无法读取版本信息' })
    cleanup = () => { active = false; closeUpdateDialog(); if (pollTimer !== undefined) clearTimeout(pollTimer) }
  },
  unmount: () => cleanup()
}
