import type { DesktopStore } from './preferences'

interface ClosableWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  hide(): void
}

export function showCloseToTrayHintOnce(store: Pick<DesktopStore, 'notified' | 'rememberNotification'>, show: () => void): void {
  const key = 'close-to-tray-hint-v1'
  if (store.notified(key)) return
  show()
  store.rememberNotification(key)
}

export function keepWindowInBackground(window: ClosableWindow, canHide: () => boolean, save: () => void, showHint?: () => void): void {
  window.on('close', (event) => {
    save()
    if (!canHide()) return
    event.preventDefault()
    showHint?.()
    window.hide()
  })
}
