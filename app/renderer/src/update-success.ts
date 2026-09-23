import { icon } from './icons'
import type { UpdateSuccessNotice } from '../../desktop-types'

// 「更新成功」弹窗:更新重启后的第一次启动,告诉客户「从哪版升上来、这版改了什么」。
// 视觉与「发现新版本」弹窗同一套(update-dialog 类),不要第二套样式;
// ⛔ 每次启动弹多次:一次更新只认第一眼,shown 钉住本次页面生命周期。
let shown = false

export function showUpdateSuccessNotice(notice: UpdateSuccessNotice): void {
  if (shown || notice.version === '') return
  shown = true
  const dialog = document.createElement('dialog')
  dialog.className = 'recovery-dialog update-dialog update-success-dialog'
  const header = document.createElement('header')
  header.className = 'update-dialog-header'
  const mark = document.createElement('span')
  mark.className = 'update-dialog-mark'
  mark.append(icon('sparkle'))
  const title = document.createElement('h2')
  title.textContent = '更新成功!'
  title.id = 'update-success-title'
  dialog.setAttribute('aria-labelledby', title.id)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'update-dialog-close'
  close.textContent = '×'
  close.setAttribute('aria-label', '关闭更新成功窗口')
  close.addEventListener('click', () => dialog.close())
  header.append(mark, title, close)

  const content = document.createElement('div')
  content.className = 'update-dialog-content'
  const release = document.createElement('p')
  release.className = 'update-dialog-release'
  release.textContent = `v${notice.version}`
  const summary = document.createElement('p')
  summary.className = 'update-dialog-summary'
  // 旧 pending 没记 previous(0.5.8 及更早装的这版)时给「已更新到」兜底文案,⛔ 显示「从 v 更新到」。
  summary.textContent = notice.previous === ''
    ? `已更新到 v${notice.version}。`
    : `已从 v${notice.previous} 更新到 v${notice.version}。`
  const divider = document.createElement('div')
  divider.className = 'update-dialog-divider'
  const notesTitle = document.createElement('h3')
  notesTitle.textContent = '更新内容'
  const notes = document.createElement('div')
  notes.className = 'update-dialog-notes'
  notes.setAttribute('aria-label', '更新内容')
  notes.textContent = notice.notes || '此版本未提供更新说明。'
  content.append(release, summary, divider, notesTitle, notes)

  const footer = document.createElement('footer')
  footer.className = 'update-dialog-actions'
  const ack = document.createElement('button')
  ack.type = 'button'
  ack.className = 'button primary-action update-dialog-primary'
  ack.textContent = '我知道了'
  ack.addEventListener('click', () => dialog.close())
  footer.append(ack)
  dialog.append(header, content, footer)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close() })
  document.body.append(dialog)
  dialog.showModal()
}
