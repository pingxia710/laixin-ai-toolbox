/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { app, BrowserWindow, Tray, nativeImage, safeStorage } = require('electron')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const root = process.env.TOOLBOX_API13_ROOT
if (!root) throw new Error('isolated root required')
app.setPath('userData', root)

if (process.argv.includes('--laixin-ai-router')) {
  const realFetch = global.fetch
  global.fetch = (input, init) => {
    const url = new URL(String(input))
    return realFetch(url.protocol === 'https:' ? `http://127.0.0.1:${process.env.TOOLBOX_API13_UPSTREAM}${url.pathname}` : input, init)
  }
  require(path.resolve(__dirname, '../../../out/main/index.js'))
} else void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  const tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg=='))
  if (!process.argv.includes('--fixture-reopen')) {
    const stateRoot = path.join(root, 'ai-access')
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    const initial = JSON.parse(readFileSync(path.join(root, 'initial.json'), 'utf8'))
    writeFileSync(path.join(stateRoot, 'ai-access.enc'), safeStorage.encryptString(JSON.stringify(initial)), { mode: 0o600 })
  }
  const { fixtureGui } = require(process.env.TOOLBOX_API13_GUI)
  const { service, report } = await fixtureGui(root, __filename)
  writeFileSync(path.join(root, 'gui-ready.json'), JSON.stringify({ ...report, windowCount: BrowserWindow.getAllWindows().length, trayPresent: !tray.isDestroyed() }), { mode: 0o600 })
  let exiting = false
  const timer = setInterval(() => {
    if (exiting || !existsSync(path.join(root, 'quit-gui'))) return
    exiting = true
    clearInterval(timer)
    void service.stop().then(() => { tray.destroy(); window.destroy(); app.quit() }).catch(() => app.exit(1))
  }, 25)
  setTimeout(() => { if (!exiting) app.exit(1) }, 30_000).unref()
}).catch(() => app.exit(1))
