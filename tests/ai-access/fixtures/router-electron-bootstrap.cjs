/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Isolated real Electron child. Only fixture Keys are read, and no real LaunchAgent is touched.
const { app, BrowserWindow, Tray, nativeImage, safeStorage } = require('electron')
const { spawn } = require('node:child_process')
const { createHmac, randomBytes } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = process.env.TOOLBOX_API15R_TEST_ROOT
if (!root) throw new Error('isolated root required')
app.setPath('userData', root)
const mode = process.argv.includes('--fixture-setup') ? 'setup'
  : process.argv.includes('--fixture-update') ? 'update'
    : process.argv.includes('--fixture-reopen') ? 'reopen' : 'main'
if (mode === 'setup' && !app.requestSingleInstanceLock()) throw new Error('fixture GUI lock unavailable')

if (process.argv.includes('--laixin-ai-router')) {
  const upstreamPort = process.env.TOOLBOX_API15R_UPSTREAM_PORT
  const realFetch = global.fetch
  global.fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.protocol === 'https:') {
      const provider = url.hostname.includes('deepseek') ? 'deepseek' : 'zhipu-api'
      return realFetch(`http://127.0.0.1:${upstreamPort}/${provider}`, init)
    }
    return realFetch(input, init)
  }
}

const proof = (secret, action, nonce, bootId, port) =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(`${action}:${nonce}:${bootId}:${port}`).digest('hex')

async function control(state, action) {
  const runtime = JSON.parse(readFileSync(path.join(root, 'ai-access', 'ai-router.runtime.json'), 'utf8'))
  const nonce = randomBytes(16).toString('hex')
  const response = await fetch(`http://127.0.0.1:${runtime.port}/_laixin/router/${action}${action === 'ready' ? `?nonce=${nonce}` : ''}`, {
    method: action === 'ready' ? 'GET' : 'POST',
    headers: {
      'x-laixin-nonce': nonce,
      'x-laixin-proof': proof(state.codexMultiRelay.identitySecret, action, nonce, runtime.bootId, runtime.port)
    }, signal: AbortSignal.timeout(2000)
  })
  const value = await response.json()
  return { ok: response.ok && value.bootId === runtime.bootId && value.proof === proof(state.codexMultiRelay.identitySecret, `${action}-ack`, nonce, runtime.bootId, runtime.port), pid: value.pid }
}

if (mode === 'main') require(path.resolve(__dirname, '../../../out/main/index.js'))
else void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  const tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg=='))
  const state = JSON.parse(readFileSync(process.env.TOOLBOX_API15R_STATE_FILE, 'utf8'))
  if (mode !== 'reopen') {
    const stateRoot = path.join(root, 'ai-access')
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(stateRoot, 'ai-access.enc'), safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 })
  }
  if (mode === 'setup') {
    const child = spawn(process.execPath, [__filename, '--laixin-ai-router'], {
      detached: true, stdio: 'ignore', env: process.env
    })
    child.unref()
    writeFileSync(path.join(root, 'fixture-headless.pid'), String(child.pid))
    const runtime = path.join(root, 'ai-access', 'ai-router.runtime.json')
    const deadline = Date.now() + 8000
    while (!require('node:fs').existsSync(runtime) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (!require('node:fs').existsSync(runtime)) throw new Error('headless did not become ready while GUI lock held')
  }
  if (mode === 'update' || mode === 'reopen') {
    const result = await control(state, mode === 'update' ? 'refresh' : 'ready')
    writeFileSync(path.join(root, `fixture-${mode}.json`), JSON.stringify({ ...result, guiPid: process.pid, windowCount: BrowserWindow.getAllWindows().length, trayPresent: !tray.isDestroyed() }))
  }
  if (mode === 'setup') writeFileSync(path.join(root, 'fixture-setup.json'), JSON.stringify({ guiPid: process.pid, windowCount: BrowserWindow.getAllWindows().length, trayPresent: true }))
  writeFileSync(path.join(root, `fixture-${mode}.pid`), String(process.pid))
  tray.destroy()
  window.destroy()
  app.quit()
}).catch(() => app.exit(1))
