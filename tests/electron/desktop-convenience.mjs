/* global Buffer, WebSocket, console, fetch */
// Real packaged-app check. Requires the isolated localhost build in release/desktop-local.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { createHash, sign } from 'node:crypto'
import { execFileSync, spawn, fork } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { extractAll, extractFile, createPackage } from '@electron/asar'
const stamp = Date.now()
const evidence = resolve('release/unified13-desktop-evidence', String(stamp))
await mkdir(evidence, { recursive: true })
// LaunchServices must not need access to the owner's protected Documents folder.
const working = await mkdtemp(join(tmpdir(), 'toolbox-desktop-proof-'))
const target = join(working, 'target/来信AI工具箱统一版.app')
execFileSync('/usr/bin/ditto', [resolve('release/desktop-local/mac-arm64/来信AI工具箱统一版.app'), target])
const targetAsar = join(target, 'Contents/Resources/app.asar')
assert.equal(JSON.parse(extractFile(targetAsar, 'package.json')).name, 'laixin-customer-backend-local')
assert.ok(extractFile(targetAsar, 'out/main/index.js').toString().includes('http://127.0.0.1:43861/'))
// Test keychain forwarding exists only in this isolated fixture, never in the shipped helper.
const helper = join(target, 'Contents/Resources/update-helper.cjs')
await writeFile(helper, (await readFile(helper, 'utf8')).replace("    await commands('/usr/bin/open', args,", "    args.push('--use-mock-keychain');\n    await commands('/usr/bin/open', args,"))
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' })
const original = join(working, 'installed/来信AI工具箱统一版.app')
execFileSync('/usr/bin/ditto', [target, original])
const unpacked = join(working, 'old-asar'); extractAll(join(original, 'Contents/Resources/app.asar'), unpacked)
const metadata = JSON.parse(await readFile(join(unpacked, 'package.json'))); metadata.version = '0.4.1-unified.12'
await writeFile(join(unpacked, 'package.json'), JSON.stringify(metadata)); await createPackage(unpacked, join(original, 'Contents/Resources/app.asar'))
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', metadata.version, join(original, 'Contents/Info.plist')])
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', original], { stdio: 'pipe' })
const archive = join(evidence, 'toolbox.zip')
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', target, archive])
const digest = async (file) => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex') }
const payload = Buffer.from(JSON.stringify({ version: '0.4.1-unified.13', notes: '本地升级测试', assets: { 'darwin-arm64': {
  url: 'http://127.0.0.1:43867/AI-tools/updates/toolbox.zip', size: (await stat(archive)).size, sha256: await digest(archive), asarSha256: await digest(targetAsar)
} } }))
const key = await readFile(join(homedir(), '.config/laixin-ai-toolbox/release-signing/private.pem'))
const manifest = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') })
const server = createServer((req, res) => {
  if (req.url === '/AI-tools/updates/latest.json') { res.end(manifest); return }
  if (req.url === '/AI-tools/updates/toolbox.zip') { res.writeHead(200); createReadStream(archive).pipe(res); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43867, '127.0.0.1', resolve) })
const profile = join(working, 'profile'); await mkdir(profile)
await writeFile(join(profile, 'preservation-witness'), 'existing-user-configuration')
const account = fork('tests/electron/account-completion-server.cjs', [join(working, 'server'), '43861'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
await new Promise((resolve, reject) => { account.once('message', (event) => { if (event.ready) resolve(); else reject(new Error('LOCAL_BACKEND_NOT_READY')) }); account.once('exit', () => reject(new Error('LOCAL_BACKEND_EXITED'))) })
const executable = join(original, 'Contents/MacOS/来信AI工具箱统一版')
const child = spawn(executable, [`--user-data-dir=${profile}`, '--use-mock-keychain', '--remote-debugging-port=43868', '--inspect=127.0.0.1:43869'], { stdio: 'ignore' })
let websocket, inspector, newPid
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, timeout = 15_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const value = await fn(); if (value) return value } catch { /* Wait for this isolated app only. */ } await pause(100) } throw new Error('DESKTOP_CHECK_TIMEOUT') }
async function connect(url) {
  const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  return { socket, call: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('CDP_TIMEOUT')) }, 15_000)
    const listener = (event) => { const response = JSON.parse(event.data); if (response.id !== id) return; clearTimeout(timer); socket.removeEventListener('message', listener); if (response.error) reject(new Error('CDP_FAILED')); else resolve(response.result) }
    socket.addEventListener('message', listener); socket.send(JSON.stringify({ id, method, params }))
  }) }
}
try {
  const entry = await until(async () => (await (await fetch('http://127.0.0.1:43868/json/list')).json()).find((page) => page.type === 'page' && page.url.includes('index.html')))
  websocket = await connect(entry.webSocketDebuggerUrl)
  const inspectEntry = await until(async () => (await (await fetch('http://127.0.0.1:43869/json/list')).json())[0])
  inspector = await connect(inspectEntry.webSocketDebuggerUrl)
  const evaluate = async (expression) => { const result = await websocket.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true }); assert.equal(result.exceptionDetails, undefined); return result.result.value }
  const main = async (expression) => { const result = await inspector.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true }); assert.equal(result.exceptionDetails, undefined); return result.result.value }
  await until(async () => await evaluate('Boolean(window.toolbox?.desktop && document.querySelector("#tab-settings"))'))
  assert.equal(await evaluate('(await window.toolbox.desktop.status()).backgroundAvailable'), true)
  assert.equal(await evaluate('JSON.parse((await window.toolbox.account.register({username:"desktop-"+crypto.randomUUID(),password:crypto.randomUUID()})).snapshot).state'), 'signed-in')
  await evaluate('document.querySelector("#tab-settings").click(); true')
  await until(async () => await evaluate('document.querySelector("#zoom-select")?.disabled === false'))
  await evaluate('document.querySelector("#zoom-select").value="1.25";document.querySelector("#zoom-select").dispatchEvent(new Event("change"));true')
  await until(async () => await evaluate('(await window.toolbox.desktop.status()).preferences.zoom === 1.25'))
  // Inspect only this test app's main process, never another Electron app.
  const electron = 'process.mainModule.require("electron")'
  await main(`${electron}.BrowserWindow.getAllWindows()[0].setBounds({x:120,y:100,width:1000,height:760}); true`)
  assert.equal(await main(`${electron}.BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()`), 1.25)
  await main(`${electron}.BrowserWindow.getAllWindows()[0].close(); true`)
  assert.equal(await main(`${electron}.BrowserWindow.getAllWindows()[0].isVisible()`), false)
  assert.equal(await evaluate('(await window.toolbox.app.info()).version'), '0.4.1-unified.12')
  execFileSync('/usr/bin/open', ['-a', original, '--args', `--user-data-dir=${profile}`, '--use-mock-keychain'])
  await until(async () => await main(`${electron}.BrowserWindow.getAllWindows()[0].isVisible()`))
  await evaluate('document.querySelector("#tab-usage").click();true')
  const apps = await evaluate('await window.toolbox.desktop.applications()')
  const codexDetected = apps.some((item) => item.id === 'codex' && item.state === 'installed')
  if (codexDetected) await until(async () => await evaluate('document.body.innerText.includes("打开 Codex")'))
  // Do not launch the owner's Codex or change its route during an isolated test.
  assert.equal((await evaluate('await window.toolbox.desktop.checkUpdate()')).state, 'available')
  assert.equal((await evaluate('await window.toolbox.desktop.downloadUpdate()')).state, 'ready')
  await evaluate('document.querySelector("#tab-settings").click();true')
  await until(async () => await evaluate('document.body.innerText.includes("更新并重启")'))
  const png = await websocket.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'settings-before-update.png'), Buffer.from(png.data, 'base64'))
  const sessionDigest = await digest(join(profile, 'account/session.enc'))
  const installResult = await evaluate('await window.toolbox.desktop.installUpdate()')
  assert.equal(installResult.state, 'installing', installResult.message)
  // Node waits for an attached inspector before exiting. End our observation before replacement.
  inspector.socket.close(); websocket.socket.close()
  const resultPath = join(profile, 'updates/result.json')
  const result = await until(async () => JSON.parse(await readFile(resultPath, 'utf8')), 180_000)
  assert.equal(result.state, 'complete', result.message)
  const ack = JSON.parse(await readFile(join(profile, 'updates/acknowledgement.json'), 'utf8')); newPid = ack.pid
  assert.equal(ack.version, '0.4.1-unified.13')
  assert.equal(await digest(join(original, 'Contents/Resources/app.asar')), await digest(targetAsar))
  const preferences = JSON.parse(await readFile(join(profile, 'desktop.json')))
  assert.equal(preferences.zoom, 1.25); assert.equal(preferences.bounds.width, 1000); assert.equal(preferences.bounds.height, 760)
  assert.equal(await readFile(join(profile, 'preservation-witness'), 'utf8'), 'existing-user-configuration')
  assert.ok((await readdir(join(profile, 'account'))).length > 0)
  assert.equal(await digest(join(profile, 'account/session.enc')), sessionDigest)
  const summary = { version: ack.version, isolatedDirectory: working, realUpdateCompleted: true, rendererStarted: true, backgroundHideAndRestore: true,
    zoomAndBoundsPreserved: true, localRegisteredAccountDataPreserved: true, codexDetected, originalBackupPresent: Boolean(result.backup), publicRelease: false }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ evidence, ...summary }))
} finally {
  websocket?.socket.close(); inspector?.socket.close()
  if (!newPid) { try { newPid = JSON.parse(await readFile(join(profile, 'updates/acknowledgement.json'), 'utf8')).pid } catch { /* No restarted test process. */ } }
  const owned = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).trim().split('\n').map((line) => /^\s*(\d+) (.*)$/.exec(line))
  for (const processRow of owned) if (processRow?.[2] === executable) { try { process.kill(Number(processRow[1]), 'SIGTERM') } catch { /* Already exited. */ } }
  if (child.exitCode === null) child.kill('SIGTERM')
  account.kill('SIGTERM'); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
}
