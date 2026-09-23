import { requestPlatformDownloadNavigation, requestTabNavigation } from './navigation'
import { isTabId } from './tabs'
import type { UpdateView } from '../../desktop-types'

/** 顶栏入口的文案。下载中要显示进度:客户端会自动下载,不说就是一段没有任何反馈的等待,
 *  而「点了没反应」正是这条线花过一整版去修的症状。 */
function updateEntryLabel(update: UpdateView): string {
  switch (update.state) {
    // ⛔ 把版本号塞进这个位置:现有约定 displayReleaseVersion('0.5.11') = 'V0.511',
    // 在窄徽章里读起来像「零点五一一」。具体版本号在设置页的更新窗口里有完整呈现。
    case 'ready': return '新版已备好，点击更新'
    case 'available': return '有新版本'
    case 'downloading': return `正在下载新版 ${Math.min(100, Math.max(0, Math.round(update.progress)))}%`
    case 'installing': return '正在更新…'
    case 'checking': return '正在检查…'
    // ⛔ 把失败显示成「检查更新」:那会让「下载失败」看起来和「一切正常」一模一样,
    // 而「看起来没事」正是这条线反复栽过的坑。说出来,点进去有重试和原因。
    case 'error': return '更新未完成'
    default: return '检查更新'
  }
}

export function mountDesktopStatus(version: HTMLElement): void {
  if (!window.toolbox.desktop) return
  // 顶栏更新入口。**常驻**,⛔ 只在有更新时才出现 —— 更新入口原先只有托盘右键和一条会消失的系统通知,
  // 加上「设置 → 关于」里那个按钮藏在两层之下。通知错过就没有第二个地方可点。
  const entry = document.createElement('button')
  entry.type = 'button'; entry.className = 'update-entry'; entry.textContent = '检查更新'
  entry.addEventListener('click', () => requestTabNavigation('settings'))
  version.after(entry)
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
      // 只有「已备好」给强调色 —— 那是唯一一个「现在点它就能装上」的状态。
      // 其余状态说清楚在发生什么,⛔ 一律显示「有新版本」让人以为点了就能装。
      entry.classList.toggle('is-ready', value.update.state === 'ready')
      entry.textContent = updateEntryLabel(value.update)
      entry.title = value.update.message
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
