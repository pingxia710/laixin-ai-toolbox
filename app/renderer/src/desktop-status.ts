import { requestPlatformDownloadNavigation, requestTabNavigation } from './navigation'
import { isTabId } from './tabs'

export function mountDesktopStatus(version: HTMLElement): void {
  if (!window.toolbox.desktop) return
  const updated = document.createElement('button'); updated.type = 'button'; updated.hidden = true
  updated.addEventListener('click', () => requestTabNavigation('settings'))
  version.after(updated)
  const notices = document.createElement('div'); notices.className = 'desktop-alerts'; notices.hidden = true
  document.querySelector('#tab-panel')?.before(notices)
  const unsubscribe = window.toolbox.desktop.onNavigate((tab) => {
    if (tab === 'codex-download' || tab === 'install') requestPlatformDownloadNavigation('codex')
    else if (isTabId(tab)) requestTabNavigation(tab)
  })
  let active = true, loading = false, previous = ''
  const refresh = async () => {
    if (!active || loading) return
    loading = true
    try {
      const value = await window.toolbox.desktop.status()
      if (!active) return
      updated.hidden = !['available', 'ready'].includes(value.update.state)
      updated.textContent = value.update.state === 'ready' ? '新版已备好' : '有新版本'
      const signature = JSON.stringify(value.alerts)
      if (signature !== previous) {
        previous = signature; notices.replaceChildren(); notices.hidden = !value.alerts.length
        for (const alert of value.alerts) {
          const entry = document.createElement('button'); entry.type = 'button'; entry.textContent = alert.message
          entry.addEventListener('click', () => requestTabNavigation(alert.kind === 'ai' ? 'usage' : 'tunnel'))
          notices.append(entry)
        }
      }
    } catch { /* Existing page-level status remains usable while the bridge is unavailable. */ }
    finally { loading = false }
  }
  void refresh()
  const timer = setInterval(() => { void refresh() }, 5000)
  window.addEventListener('pagehide', () => { active = false; clearInterval(timer); unsubscribe() }, { once: true })
}
