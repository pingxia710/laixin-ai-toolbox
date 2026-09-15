/* global Buffer, WebSocket, console, fetch */
// Packaged renderer + real restricted bridge/service; only read-only probes use fixtures.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, fork } from 'node:child_process'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { extractFile } from '@electron/asar'

const source = resolve(process.argv[2] ?? 'release/network-local/mac-arm64/来信工具箱后台验证.app')
const archive = join(source, 'Contents/Resources/app.asar')
const metadata = JSON.parse(extractFile(archive, 'package.json').toString())
const bundled = extractFile(archive, 'out/main/index.js').toString()
assert.equal(process.platform, 'darwin', 'LOCAL_MAC_REQUIRED')
assert.equal(metadata.name, 'laixin-customer-backend-local', 'ISOLATED_LOCAL_APP_REQUIRED')
assert.deepEqual(bundled.match(/new AccountClient\(\s*[^,]+,/g)?.map((value) => value.replace(/\s+/g, '')),
  ['newAccountClient("http://127.0.0.1:43861/",'], 'LOCAL_ACCOUNT_BUILD_REQUIRED')
assert.ok(bundled.includes('"./actions/network-diagnostics.ts"'), 'DIAGNOSTIC_REGISTRATION_REQUIRED')
const domesticUrl = /id: "domestic",\s*url: "([^"]+)"/.exec(bundled)?.[1]
assert.ok(domesticUrl, 'DOMESTIC_DIAGNOSTIC_TARGET_REQUIRED')
const windowLine = bundled.split('\n').findIndex((line) => /mainWindow = new (?:electron\.)?BrowserWindow\(/.test(line))
assert.ok(windowLine > 0, 'WINDOW_INITIALIZATION_REQUIRED')
const evidence = resolve('release/unified14-network-evidence', String(Date.now()))
await mkdir(evidence, { recursive: true })
const working = await mkdtemp(join(tmpdir(), 'toolbox-network-ui-'))
const application = join(working, basename(source))
execFileSync('/usr/bin/ditto', [source, application])
const executable = join(application, 'Contents/MacOS', basename(source, '.app'))
const profile = join(working, 'profile'); await mkdir(profile)
async function availablePort(port = 0) {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const selected = server.address().port
  await new Promise((resolve) => server.close(resolve)); return selected
}
await availablePort(43861)
const rendererPort = await availablePort(); const inspectorPort = await availablePort()
const account = fork('tests/electron/account-completion-server.cjs', [join(working, 'server'), '43861'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
let child, inspector, renderer
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(75) }
  throw new Error(`NETWORK_UI_TIMEOUT:${label}`)
}
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map(); const events = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) { events.push(message); return }
    const item = pending.get(message.id); if (!item) return
    clearTimeout(item.timer); pending.delete(message.id)
    if (message.error) item.reject(new Error(`CDP_FAILED:${message.error.message}`)); else item.resolve(message.result)
  })
  socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP_CLOSED')) } pending.clear() })
  return { socket, events, call: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP_TIMEOUT:${method}`)) }, 15_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  }) }
}
async function endpoint(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch { return [] }
}
const resultValue = (result) => { assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text); return result.result.value }
const evaluate = async (expression) => resultValue(await renderer.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true }))
const main = async (expression) => resultValue(await inspector.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, replMode: true }))
const button = (text, scope = 'document') => `Array.from(${scope}.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)})`
const diagnostic = 'document.querySelector(".network-diagnostics")'
const select = 'document.querySelector("#network-diagnostic-software")'
async function click(text, scope = 'document') { assert.equal(await evaluate(`Boolean(${button(text, scope)})`), true, `BUTTON_MISSING:${text}`); await evaluate(`${button(text, scope)}.click(); true`) }
async function showNetwork() {
  await evaluate('document.querySelector("#tab-tunnel").click(); true')
  await until(() => evaluate(`Boolean(${diagnostic})`), 'network-mounted')
  await evaluate(`${diagnostic}.open = true; ${diagnostic}.scrollIntoView({block:'start'}); true`)
}
async function choose(software) { await evaluate(`${select}.value=${JSON.stringify(software)}; ${select}.dispatchEvent(new Event('change')); true`) }
async function complete() { await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('检查完成')`), 'diagnostic-complete') }
async function screenshot(name) {
  const png = await renderer.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, name), Buffer.from(png.data, 'base64'))
}
async function summary() {
  await click('查看客服信息', diagnostic)
  return copySupport()
}
async function copySupport() {
  await until(() => evaluate(`Boolean(${button('复制问题信息')})`), 'support-ready')
  await evaluate('window.__copied = undefined; true'); await click('复制问题信息')
  return until(() => evaluate('window.__copied'), 'support-copy')
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOCAL_BACKEND_TIMEOUT')), 15_000)
    account.once('message', (event) => { clearTimeout(timer); if (event.ready) resolve(); else reject(new Error('LOCAL_BACKEND_NOT_READY')) })
    account.once('exit', () => { clearTimeout(timer); reject(new Error('LOCAL_BACKEND_EXITED')) })
  })
  child = spawn(executable, [`--user-data-dir=${profile}`, '--use-mock-keychain', `--remote-debugging-port=${rendererPort}`, `--inspect-brk=127.0.0.1:${inspectorPort}`], { stdio: 'ignore' })
  const inspected = await until(async () => (await endpoint(inspectorPort))[0], 'main-inspector')
  inspector = await connect(inspected.webSocketDebuggerUrl)
  await inspector.call('Debugger.enable'); await inspector.call('Runtime.runIfWaitingForDebugger')
  const initial = await until(() => inspector.events.find((event) => event.method === 'Debugger.paused'), 'initial-pause')
  assert.equal(resultValue(await inspector.call('Debugger.evaluateOnCallFrame', { callFrameId: initial.params.callFrames[0].callFrameId, expression: 'process.pid', returnByValue: true })), child.pid)
  const breakpoint = await inspector.call('Debugger.setBreakpoint', { location: { scriptId: initial.params.callFrames[0].location.scriptId, lineNumber: windowLine } })
  inspector.events.length = 0; await inspector.call('Debugger.resume')
  const paused = await until(() => inspector.events.find((event) => event.method === 'Debugger.paused'), 'window-pause')
  const fixture = `(() => {
    globalThis.__networkUiFixture = { mode: 'ok', calls: [], releases: [], state: '已连', message: '', unrestored: '', timeOffset: 0 };
    const fixture = globalThis.__networkUiFixture;
    const status = () => ({ state: fixture.state, lastVerifiedAt: new Date().toISOString(), configVersion: 'ui-fixture', nodeLabel: '隔离UI检查', unrestored: fixture.unrestored, componentMissing: '' });
    actionModules['./actions/network-diagnostics.ts'].registerActions({ registerAction: action => bridgeRegistry.actions.set(action.name, action) }, {
      status, now: () => { if (fixture.mode === 'fail') throw new Error('UI_FIXTURE_PRIVATE_ERROR'); return Date.now() + fixture.timeOffset; },
      probe: async (url, route) => {
        fixture.calls.push({ url, route });
        if (fixture.mode === 'hold') await new Promise(resolve => fixture.releases.push(resolve));
        return { status: url === ${JSON.stringify(domesticUrl)} ? 204 : fixture.mode === 'auth' ? 401 : 200, durationMs: 12 };
      }
    });
    const action = bridgeRegistry.actions.get('tunnel.status');
    bridgeRegistry.actions.set('tunnel.status', { ...action, handler: () => ({ ...status(), message: fixture.message, source: '', authorization: '', backend: '', exitIp: '', expiresAt: '', pendingAvailable: false, currentConfig: '', pendingConfig: '', canApplyPending: false, traffic: '' }) });
    return true;
  })()`
  assert.equal(resultValue(await inspector.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.params.callFrames[1].callFrameId, expression: fixture, returnByValue: true })), true)
  await inspector.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }); await inspector.call('Debugger.resume')
  const page = await until(async () => (await endpoint(rendererPort)).find((item) => item.type === 'page' && item.url.includes('index.html')), 'renderer')
  renderer = await connect(page.webSocketDebuggerUrl)
  await until(() => evaluate('Boolean(window.toolbox?.networkdiagnostics && document.querySelector("#tab-tunnel"))'), 'bridge-ready')
  assert.equal(await evaluate('(await window.toolbox.app.info()).version'), metadata.version)
  // Capture this app's copy payload without reading or changing the owner's clipboard.
  await evaluate('Object.defineProperty(navigator.clipboard, "writeText", {value: async value => { window.__copied = value; }}); true')
  assert.equal(await evaluate('JSON.parse((await window.toolbox.account.register({username:"network-ui-"+crypto.randomUUID(), password:crypto.randomUUID()})).snapshot).state'), 'signed-in')
  const rejected = await evaluate('await window.toolbox.networkdiagnostics.run({software:"https://invalid.example"}).then(() => false, error => !String(error).includes("UI_FIXTURE_PRIVATE_ERROR"))')
  assert.equal(rejected, true, 'UNRESTRICTED_DIAGNOSTIC_INPUT')
  await showNetwork(); await click('开始检查', diagnostic); await complete()
  assert.deepEqual(await evaluate(`Array.from(${diagnostic}.querySelectorAll('li strong')).map(item => item.textContent)`), ['基础网络', '通道出口', '目标服务', '登录与额度', '应用接入'])
  const firstSummary = await summary()
  for (const code of ['AI_DIAG_INTERNET_OK', 'AI_DIAG_TUNNEL_VERIFIED', 'AI_DIAG_SERVICE_REACHABLE', 'AI_DIAG_ACCOUNT_MANUAL', 'AI_DIAG_APPLICATION_UNCONFIRMED']) assert.ok(firstSummary.includes(code), code)
  assert.ok(firstSummary.includes('通道:已连'))
  assert.ok(!firstSummary.includes('https://') && !firstSummary.includes(working))
  await evaluate(`${diagnostic}.scrollIntoView({block:'start'}); true`); await screenshot('diagnostics-codex.png')
  assert.equal(await evaluate('Boolean(document.querySelector(".terminal-observation"))'), false, 'MANUAL_TERMINAL_OBSERVATION_VISIBLE')
  assert.equal(await evaluate('document.body.innerText.includes("生成并复制终端命令") || document.body.innerText.includes("查看观察结果")'), false, 'MANUAL_TERMINAL_COMMAND_VISIBLE')

  await choose('claude')
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').hidden`), true, 'SOFTWARE_SWITCH_STALE_RESULT')
  const changedSummary = await copySupport()
  assert.ok(!changedSummary.includes('AI_DIAG_SERVICE_REACHABLE'), 'OPEN_SUPPORT_RETAINED_PREVIOUS_SOFTWARE_RESULT')
  await main('__networkUiFixture.mode="auth"; true'); await click('开始检查', diagnostic); await complete()
  const authSummary = await copySupport(); assert.ok(authSummary.includes('软件:Claude') && authSummary.includes('AI_DIAG_SERVICE_AUTH'))
  assert.ok(!authSummary.includes('AI_DIAG_SERVICE_REACHABLE'))
  await choose('hermes'); await main('__networkUiFixture.mode="ok"; __networkUiFixture.timeOffset=-598500; true')
  await click('开始检查', diagnostic); await complete()
  const directSummary = await copySupport()
  assert.ok(directSummary.includes('AI_DIAG_DIRECT_SERVICE') && directSummary.includes('AI_DIAG_SERVICE_REACHABLE'))
  await until(() => evaluate('document.querySelector(".support-context")?.textContent.includes("检查结果已过期")'), 'open-support-expiry')
  const expiredSummary = await copySupport()
  assert.ok(expiredSummary.includes('NETWORK_DIAGNOSTIC_STALE') && !expiredSummary.includes('AI_DIAG_SERVICE_REACHABLE'))
  await choose('codex'); await main('__networkUiFixture.mode="hold"; __networkUiFixture.timeOffset=0; __networkUiFixture.calls=[]; true')
  await click('开始检查', diagnostic)
  await until(() => main('__networkUiFixture.releases.length === 1'), 'held-probe')
  assert.equal(await evaluate(`${select}.disabled && ${button('开始检查', diagnostic)}.disabled`), true)
  await evaluate('window.__same = window.toolbox.networkdiagnostics.run({software:"codex"}); window.__other = window.toolbox.networkdiagnostics.run({software:"claude"}).then(() => false, () => true); true')
  assert.equal(await evaluate('await window.__other'), true, 'DIFFERENT_SOFTWARE_WAS_NOT_BLOCKED')
  assert.equal(await main('__networkUiFixture.calls.length'), 1, 'DUPLICATE_REQUEST_DID_NOT_COALESCE')
  await main('__networkUiFixture.mode="ok"; __networkUiFixture.releases.splice(0).forEach(resolve => resolve()); true')
  await complete(); assert.equal(await evaluate('JSON.parse((await window.__same).snapshot).software'), 'codex')
  assert.equal(await main('__networkUiFixture.calls.length'), 2)

  await main('__networkUiFixture.mode="fail"; true'); await click('开始检查', diagnostic)
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('本次检查未完成')`), 'failure-feedback')
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').hidden && ${diagnostic}.querySelectorAll('li').length === 0`), true)
  assert.equal(await evaluate('document.body.innerText.includes("UI_FIXTURE_PRIVATE_ERROR")'), false)
  assert.ok(!(await copySupport()).includes('AI_DIAG_SERVICE_REACHABLE'), 'FAILED_RUN_RETAINED_PREVIOUS_SUPPORT_RESULT')
  await main('__networkUiFixture.mode="hold"; true'); await click('开始检查', diagnostic)
  await until(() => main('__networkUiFixture.releases.length === 1'), 'navigation-held-probe')
  await evaluate('document.querySelector("#tab-settings").click(); true')
  await main('__networkUiFixture.mode="ok"; __networkUiFixture.releases.splice(0).forEach(resolve => resolve()); true')
  await until(() => main('__networkUiFixture.calls.at(-1)?.url === "https://chatgpt.com/"'), 'navigation-probe-finished')
  await showNetwork()
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').hidden && ${diagnostic}.querySelectorAll('li').length === 0`), true, 'UNMOUNTED_RESULT_CONTAMINATED_NEW_PAGE')
  await click('开始检查', diagnostic); await complete()

  await main('__networkUiFixture.state="异常"; __networkUiFixture.message="系统代理设置未生效 UI_FIXTURE_PRIVATE_ERROR"; true')
  const failureSummary = await summary()
  assert.ok(failureSummary.includes('NETWORK_PROXY_NOT_APPLIED') && failureSummary.includes('通道:未知'))
  assert.ok(!failureSummary.includes('UI_FIXTURE_PRIVATE_ERROR'))
  await main('__networkUiFixture.state="已停止并恢复原设置"; __networkUiFixture.message=""; true')
  const restoredSummary = await summary()
  assert.ok(restoredSummary.includes('NETWORK_RESTORED') && restoredSummary.includes('通道:未连'))
  await main('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].setBounds({width:620,height:420}); true')
  await evaluate(`${diagnostic}.scrollIntoView({block:'start'}); true`)
  await until(() => evaluate('window.innerWidth <= 620'), 'small-window')
  const layout = await evaluate(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,detailsWidth:${diagnostic}.getBoundingClientRect().width})`)
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `SMALL_WINDOW_OVERFLOW:${JSON.stringify(layout)}`)
  await screenshot('diagnostics-620x420.png')
  const localRequests = await new Promise((resolve, reject) => {
    const id = 'network-ui-counts'
    const timer = setTimeout(() => reject(new Error('LOCAL_REQUEST_COUNTS_TIMEOUT')), 5_000)
    const receive = (event) => { if (event.id !== id) return; clearTimeout(timer); account.removeListener('message', receive); resolve(event.counts) }
    account.on('message', receive); account.send({ id, action: 'stats' })
  })
  assert.deepEqual(localRequests, { trial: 0, network: 0 }, 'NETWORK_UI_MUST_NOT_CLAIM_TRAFFIC')
  const asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  const summaryResult = { version: metadata.version, asarSha256, isolatedDirectory: working, layout, localRequests,
    passed: ['packaged-renderer', 'restricted-bridge', 'five-diagnostic-layers', 'no-manual-terminal-command', 'safe-support-copy', 'software-change-refreshes-open-support', 'completion-refreshes-open-support', 'expiry-refreshes-open-support', 'same-request-coalescing', 'different-request-rejection', 'failure-clears-results-and-support', 'navigation-discards-results', 'support-restoration-state', 'small-window-no-overflow'],
    fixtureScope: 'Only diagnostic HTTP probes and tunnel status are synthetic. This proves packaged UI/bridge behavior, not a customer connection or AI response.',
    systemProxyChanged: false, realTrafficClaimed: false, ownerCredentialsRead: false, systemClipboardChanged: false }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(summaryResult, null, 2)); console.log(JSON.stringify({ evidence, ...summaryResult }))
} catch (error) {
  if (renderer) { try { await screenshot('failure.png') } catch { /* Preserve the original test failure. */ } }
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), isolatedDirectory: working }, null, 2))
  throw error
} finally {
  renderer?.socket.close(); inspector?.socket.close()
  if (child && child.exitCode === null) child.kill('SIGTERM')
  if (account.exitCode === null) account.kill('SIGTERM')
}
