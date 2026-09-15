interface ClosableWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  hide(): void
}

export function keepWindowInBackground(window: ClosableWindow, canHide: () => boolean, save: () => void): void {
  window.on('close', (event) => {
    save()
    if (!canHide()) return
    event.preventDefault()
    window.hide()
  })
}
