import { isAllowedEntryUrl } from './source-guard'

interface PreventableEvent {
  preventDefault(): void
}

interface GuardedWebContents {
  setWindowOpenHandler(handler: () => { readonly action: 'deny' }): void
  on(event: 'will-navigate', listener: (event: PreventableEvent, url: string) => void): void
  on(event: 'will-attach-webview', listener: (event: PreventableEvent) => void): void
}

export function installNavigationGuards(contents: GuardedWebContents, entryUrl: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedEntryUrl(url, entryUrl)) {
      event.preventDefault()
    }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
