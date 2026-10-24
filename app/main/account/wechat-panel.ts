import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { WechatPanelMode } from '../../account-types'

const wechatOrigin = 'https://open.weixin.qq.com'

export function allowedWechatNavigation(value: string, callback: string): boolean {
  try {
    const url = new URL(value); const target = new URL(callback)
    if (url.username || url.password) return false
    if (url.origin === wechatOrigin && url.pathname === '/connect/qrconnect') return true
    return url.origin === target.origin && [target.pathname, target.pathname.replace(/callback$/, 'complete'),
      target.pathname.replace(/callback$/, 'cancel')].includes(url.pathname)
  } catch { return false }
}

export function wechatPanelBounds(value: unknown, windowSize: readonly number[], zoom = 1): Rectangle | undefined {
  const rect = value as Record<string, unknown> | null
  if (!rect || typeof rect !== 'object' || typeof rect.visible !== 'boolean' ||
      ['x', 'y', 'width', 'height'].some((key) => typeof rect[key] !== 'number' || !Number.isFinite(rect[key]) || Math.abs(Number(rect[key])) > 10000)) {
    throw new Error('WECHAT_PANEL_BOUNDS_INVALID')
  }
  if (!rect.visible || Number(rect.width) <= 0 || Number(rect.height) <= 0) return undefined
  const x = Math.max(0, Math.round(Number(rect.x) * zoom)); const y = Math.max(0, Math.round(Number(rect.y) * zoom))
  const width = Math.min(windowSize[0], Math.round((Number(rect.x) + Number(rect.width)) * zoom)) - x
  const height = Math.min(windowSize[1], Math.round((Number(rect.y) + Number(rect.height)) * zoom)) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

/** Remote login content has its own sandbox and no preload or toolbox IPC authority. */
export class WechatLoginPanel {
  private owner?: BrowserWindow
  private view?: WebContentsView
  private bounds: unknown = { x: 0, y: 0, width: 0, height: 0, visible: false }
  private abandon?: () => void

  attach(owner: BrowserWindow): void {
    this.owner = owner
    owner.once('closed', () => { this.close(true); if (this.owner === owner) this.owner = undefined })
    owner.webContents.on('render-process-gone', () => this.close(true))
    owner.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) this.close(true) })
  }

  async open(authorizeUrl: string, abandon: () => void): Promise<void> {
    const owner = this.owner
    if (!owner || owner.isDestroyed()) throw new Error('WECHAT_PANEL_UNAVAILABLE')
    this.close()
    const url = new URL(authorizeUrl)
    const callback = url.searchParams.get('redirect_uri')!
    if (url.origin !== wechatOrigin || url.pathname !== '/connect/qrconnect' || !callback) throw new Error('WECHAT_PANEL_URL_INVALID')
    url.searchParams.set('login_type', 'jssdk'); url.searchParams.set('self_redirect', 'true')
    url.searchParams.set('stylelite', '1'); url.searchParams.set('color_scheme', 'light'); url.searchParams.set('style', 'black')
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'laixin-wechat-login'
    } })
    this.view = view; this.abandon = abandon
    view.setBackgroundColor('#ffffff')
    const content = view.webContents
    content.setWindowOpenHandler(() => ({ action: 'deny' }))
    const canUseLocalWechat = (origin: string, permission: string) => origin === wechatOrigin &&
      ['local-network', 'local-network-access', 'loopback-network'].includes(permission)
    content.session.setPermissionCheckHandler((_contents, permission, origin) => canUseLocalWechat(origin, permission))
    content.session.setPermissionRequestHandler((_contents, permission, done, details) => {
      let origin = ''
      try { origin = new URL(details.requestingUrl).origin } catch { /* Deny unknown origins. */ }
      done(canUseLocalWechat(origin, permission))
    })
    const guard = (navigation: { preventDefault(): void }, target: string) => { if (!allowedWechatNavigation(target, callback)) navigation.preventDefault() }
    content.on('will-navigate', guard)
    content.on('will-redirect', guard)
    content.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || this.view !== view) return
      const target = new URL(event.url)
      const destination = new URL(callback)
      if (target.origin !== destination.origin || target.pathname !== destination.pathname) return
      event.preventDefault()
      // Phone confirmation has no desktop user gesture. Promote only this
      // attempt's callback out of the official iframe into the isolated view.
      if (event.frame?.url.startsWith(`${wechatOrigin}/connect/qrconnect?`) &&
          !target.username && !target.password && target.searchParams.getAll('state').length === 1 &&
          target.searchParams.get('state') === url.searchParams.get('state')) {
        void content.loadURL(event.url).catch(() => { if (this.view === view) this.close(true) })
      }
    })
    content.on('will-attach-webview', (event) => event.preventDefault())
    content.on('did-finish-load', () => { if (this.view === view) this.updateBounds(this.bounds) })
    owner.contentView.addChildView(view)
    this.updateBounds(this.bounds)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // The official embedded layout is light. Keep it in this unprivileged view,
      // not in the toolbox renderer. The frame callback is promoted above.
      const src = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      const callbackSource = new URL(callback).href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src https://open.weixin.qq.com ${callbackSource};"><style>html,body{margin:0;width:100%;height:100%;background:#fff}iframe{width:100%;height:100%;border:0}</style></head><body><iframe title="微信登录" allow="local-network-access" src="${src}"></iframe></body></html>`
      await Promise.race([content.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('WECHAT_PANEL_LOAD_TIMEOUT')), 20_000)
      })])
    } catch (error) { if (this.view === view) this.close(); throw error }
    finally { if (timeout) clearTimeout(timeout) }
  }

  async mode(): Promise<{ mode: WechatPanelMode }> {
    const content = this.view?.webContents
    if (!content || content.isDestroyed()) return { mode: 'loading' }
    if (!content.getURL().startsWith('data:')) return { mode: 'confirm' }
    const frame = content.mainFrame.frames.find((frame) => frame.url.startsWith(`${wechatOrigin}/connect/qrconnect`))
    if (!frame) return { mode: 'loading' }
    try {
      // Return only a display mode; never read the customer's nickname or avatar.
      const mode: unknown = await frame.executeJavaScript(`(() => {
        const visible = selector => Array.from(document.querySelectorAll(selector)).some(el => el.getBoundingClientRect().height > 0);
        return visible('.js_quick_login_btn') ? 'quick' : visible('.js_qrcode_img') ? 'qr' : 'loading';
      })()`)
      return { mode: mode === 'quick' || mode === 'qr' ? mode : 'loading' }
    } catch { return { mode: 'loading' } } // A frame can disappear while switching to confirmation.
  }

  updateBounds(value: unknown): void {
    const zoom = this.owner?.webContents.getZoomFactor() ?? 1
    const bounds = wechatPanelBounds(value, this.owner?.getContentSize() ?? [0, 0], zoom)
    this.bounds = value
    if (!this.view) return
    this.view.setVisible(Boolean(bounds))
    if (bounds) {
      this.view.setBounds(bounds)
      const embedded = this.view.webContents.getURL().startsWith('data:')
      this.view.webContents.setZoomFactor(Math.min(zoom * (embedded ? 1.2 : 1), bounds.width / (embedded ? 240 : 300)))
    }
  }

  close(abandoned = false): void {
    const view = this.view; const abandon = this.abandon
    this.view = undefined; this.abandon = undefined
    if (view) {
      if (this.owner && !this.owner.isDestroyed()) this.owner.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    if (abandoned) abandon?.()
  }
}

export const wechatLoginPanel = new WechatLoginPanel()
