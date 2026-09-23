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
  ['newAccountClient("http://127.0.0.1:43861",'], 'LOCAL_ACCOUNT_BUILD_REQUIRED')
assert.ok(bundled.includes('"./actions/network-diagnostics.ts"'), 'DIAGNOSTIC_REGISTRATION_REQUIRED')
assert.ok(bundled.includes('"./actions/diagnostics.ts"'), 'SUPPORT_DIAGNOSTIC_REGISTRATION_REQUIRED')
const domesticUrl = /id: "domestic",\s*url: "([^"]+)"/.exec(bundled)?.[1]
assert.ok(domesticUrl, 'DOMESTIC_DIAGNOSTIC_TARGET_REQUIRED')
const windowLine = bundled.split('\n').findIndex((line) => /mainWindow = new (?:electron\.)?BrowserWindow\(/.test(line))
assert.ok(windowLine > 0, 'WINDOW_INITIALIZATION_REQUIRED')
const evidence = resolve(process.env.NETWORK_UI_EVIDENCE_DIR ?? 'release/dg01-network-evidence', String(Date.now()))
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
const conclusion = `${diagnostic}.querySelector(".diagnostic-conclusion")`
const select = 'document.querySelector("#network-diagnostic-software")'
async function click(text, scope = 'document') { assert.equal(await evaluate(`Boolean(${button(text, scope)})`), true, `BUTTON_MISSING:${text}`); await evaluate(`${button(text, scope)}.click(); true`) }
async function showNetwork() {
  await evaluate('document.querySelector("#tab-tunnel").click(); true')
  await until(() => evaluate(`Boolean(${diagnostic})`), 'network-mounted')
  await evaluate(`${diagnostic}.open = true; ${diagnostic}.scrollIntoView({block:'start'}); true`)
}
async function choose(software) { await evaluate(`${select}.value=${JSON.stringify(software)}; ${select}.dispatchEvent(new Event('change')); true`) }
async function complete() { await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('检查完成')`), 'diagnostic-complete') }
async function conclusionSnapshot() {
  return evaluate(`({ruleId:${conclusion}.dataset.ruleId,status:${conclusion}.dataset.status,title:${conclusion}.querySelector('.diagnostic-conclusion-title')?.textContent ?? '',text:${conclusion}.innerText})`)
}
async function screenshot(name) {
  const png = await renderer.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, name), Buffer.from(png.data, 'base64'))
}
async function accountMessage(action) {
  return new Promise((resolve, reject) => {
    const id = `network-ui-${action}-${Date.now()}`
    const timer = setTimeout(() => reject(new Error(`LOCAL_${action.toUpperCase()}_TIMEOUT`)), 5_000)
    const receive = (event) => { if (event.id !== id) return; clearTimeout(timer); account.removeListener('message', receive); resolve(event) }
    account.on('message', receive); account.send({ id, action })
  })
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
    globalThis.__networkUiFixture = { mode: 'ok', calls: [], releases: [], state: '已连', message: '', unrestored: '', timeOffset: 0, targetStatus: 200, configVersion: 'ui-fixture',
      lastVerifiedAt: null, selection: { mode: 'official' }, selections: [], faults: [], delayFaultRead: false, renewDuringFaultRead: false,
      repair: { running: false, phase: 'idle', outcome: 'idle', code: '', message: '', startedAt: '', finishedAt: '' }, lastRun: null };
    const fixture = globalThis.__networkUiFixture;
    const status = () => ({ state: fixture.state, lastVerifiedAt: fixture.lastVerifiedAt ?? new Date(Date.now() - 1_000).toISOString(), configVersion: fixture.configVersion, nodeLabel: '隔离UI检查', unrestored: fixture.unrestored, componentMissing: '' });
    const diagnosticStatus = () => { if (fixture.mode === 'unreadable') throw new Error('UI_FIXTURE_PRIVATE_STATUS'); return status(); };
    const selection = async () => { if (fixture.mode === 'unreadable') throw new Error('UI_FIXTURE_PRIVATE_SELECTION'); return { ...(fixture.selections.shift() ?? fixture.selection) }; };
    actionModules['./actions/network-diagnostics.ts'].registerActions({ registerAction: action => bridgeRegistry.actions.set(action.name, action) }, {
      status: diagnosticStatus, selection, now: () => { if (fixture.mode === 'fatal') throw new Error('UI_FIXTURE_PRIVATE_ERROR'); return Date.now() + fixture.timeOffset; },
      probe: async (url, route) => {
        fixture.calls.push({ url, route });
        if (fixture.mode === 'hold') await new Promise(resolve => fixture.releases.push(resolve));
        if (fixture.mode === 'domestic-unavailable' && url === ${JSON.stringify(domesticUrl)}) throw new Error('UI_FIXTURE_PRIVATE_DOMESTIC');
        if (fixture.mode === 'target-unavailable' && url !== ${JSON.stringify(domesticUrl)}) throw new Error('UI_FIXTURE_PRIVATE_TARGET');
        if (fixture.mode === 'expire-tunnel' && url !== ${JSON.stringify(domesticUrl)}) fixture.timeOffset = 0;
        if (fixture.mode === 'refresh-tunnel' && url !== ${JSON.stringify(domesticUrl)}) {
          fixture.timeOffset = 0;
          fixture.lastVerifiedAt = new Date().toISOString();
        }
        return { status: url === ${JSON.stringify(domesticUrl)} ? 204 : fixture.targetStatus, durationMs: 12 };
      }
    });
    actionModules['./actions/diagnostics.ts'].registerActions({
      registerAction: action => bridgeRegistry.actions.set(action.name, action),
      execute: (name, params) => bridgeRegistry.execute(name, params)
    }, {
      recentFaults: async () => {
        if (fixture.delayFaultRead) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (fixture.renewDuringFaultRead) fixture.lastVerifiedAt = new Date().toISOString();
        }
        return fixture.faults;
      },
      recordNetworkFault: async () => {}
    });
    const diagnosticRun = bridgeRegistry.actions.get('diagnostics.run');
    bridgeRegistry.actions.set('diagnostics.run', { ...diagnosticRun, handler: async params => {
      const result = await diagnosticRun.handler(params);
      fixture.lastRun = JSON.parse(result.snapshot);
      return result;
    } });
    process.mainModule.require('electron').clipboard.writeText = value => { globalThis.__diagnosticClipboard = value; };
    const action = bridgeRegistry.actions.get('tunnel.status');
    bridgeRegistry.actions.set('tunnel.status', { ...action, handler: () => ({ ...status(), message: fixture.message, source: '', authorization: '', backend: '', exitIp: '', pathSource: 'laixin', expiresAt: '', pendingAvailable: false, currentConfig: '', pendingConfig: '', canApplyPending: false, sshBinary: '', traffic: '' }) });
    const repairAction = bridgeRegistry.actions.get('tunnel.repairStatus');
    bridgeRegistry.actions.set('tunnel.repairStatus', { ...repairAction, handler: () => ({ ...fixture.repair }) });
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
  assert.equal(await evaluate('JSON.parse((await window.toolbox.account.register({username:"network-ui-"+crypto.randomUUID().slice(0,12), password:crypto.randomUUID(), inviteCode:""})).snapshot).state'), 'signed-in')
  const rejected = await evaluate('await window.toolbox.networkdiagnostics.run({software:"https://invalid.example"}).then(() => false, error => !String(error).includes("UI_FIXTURE_PRIVATE_ERROR"))')
  assert.equal(rejected, true, 'UNRESTRICTED_DIAGNOSTIC_INPUT')
  await showNetwork(); await click('开始检查', diagnostic); await complete()
  assert.deepEqual(await evaluate(`Array.from(${diagnostic}.querySelectorAll('li strong')).map(item => item.textContent)`), ['基础网络', '通道出口', '目标服务', '登录与额度', '应用接入'])
  assert.deepEqual(await conclusionSnapshot(), {
    ruleId: 'DG01_APPLICATION_UNCONFIRMED', status: 'unknown', title: '只能定位到应用验证这一步',
    text: await evaluate(`${conclusion}.innerText`)
  })
  assert.equal(await evaluate(`${conclusion}.innerText.includes("本次诊断快照中没有记录到已执行的处理动作或复验结果")`), true)
  const firstCheckedAt = await evaluate(`${conclusion}.querySelector('.diagnostic-conclusion-meta').textContent`)
  await main('globalThis.__diagnosticClipboard = undefined; true')
  await click('复制本次诊断', diagnostic)
  const copiedDiagnosis = await until(() => main('globalThis.__diagnosticClipboard'), 'diagnostic-copy')
  const diagnosisId = /诊断编号：(DG-[A-F0-9]{6}-[A-F0-9]{6})/.exec(copiedDiagnosis)?.[1]
  assert.ok(diagnosisId, 'DIAGNOSTIC_COPY_ID_REQUIRED')
  for (const expected of ['问题软件：Codex', '检查目标：Codex 官方', '本次结论：只能定位到应用验证这一步',
    '判断依据：', '未确认项：', '实际已试动作与复验：', '没有记录到已执行的处理动作或复验结果']) assert.ok(copiedDiagnosis.includes(expected), expected)
  assert.ok(copiedDiagnosis.includes('状态：已连') && copiedDiagnosis.includes('节点：隔离UI检查'), 'SUPPLEMENTAL_TUNNEL_STATUS_REQUIRED')
  assert.ok(copiedDiagnosis.includes(firstCheckedAt.replace(/^检查时间 /, '').split(' · ')[0]), 'COPY_CHECK_TIME_MUST_MATCH_UI')
  await click('把本次情况报给来信', diagnostic)
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('已上报')`), 'diagnostic-report', 30_000)
  const uploaded = (await accountMessage('latest-report')).report
  assert.ok(uploaded, 'UPLOADED_DIAGNOSTIC_REQUIRED')
  assert.equal(uploaded.body.diagnosis.id, diagnosisId)
  assert.equal(uploaded.body.diagnosis.software, 'codex')
  assert.equal(uploaded.body.diagnosis.conclusion.ruleId, 'DG01_APPLICATION_UNCONFIRMED')
  assert.ok(uploaded.body.diagnosis.conclusion.evidence.every(item => copiedDiagnosis.includes(item.statement)), 'UPLOAD_EVIDENCE_MUST_MATCH_COPY')
  assert.equal(typeof uploaded.body.supplemental.collectedAt, 'string', 'SUPPLEMENTAL_TIME_REQUIRED')
  assert.ok(Number.isFinite(Date.parse(uploaded.body.supplemental.collectedAt)), 'SUPPLEMENTAL_TIME_INVALID')
  assert.equal(uploaded.createdAt, uploaded.body.supplemental.collectedAt, 'SUPPLEMENTAL_TIME_MUST_DESCRIBE_UPLOAD_READS')
  assert.doesNotMatch(JSON.stringify(uploaded.body.diagnosis), /sk-[A-Za-z0-9_-]{8,}|Bearer\s|token|password/i)
  await main('globalThis.__diagnosticClipboard = "fresh-renewal-sentinel"; __networkUiFixture.lastVerifiedAt = new Date().toISOString(); true')
  await click('复制本次诊断', diagnostic)
  await until(() => main(`globalThis.__diagnosticClipboard === ${JSON.stringify(copiedDiagnosis)}`), 'fresh-renewal-copy')
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('已复制本次诊断')`), 'fresh-renewal-feedback')
  await main('globalThis.__diagnosticClipboard = "stale-sentinel"; __networkUiFixture.configVersion = "ui-fixture-changed"; true')
  await click('复制本次诊断', diagnostic)
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('重新检查')`), 'stale-copy-feedback')
  assert.equal(await main('globalThis.__diagnosticClipboard'), 'stale-sentinel', 'STALE_DIAGNOSTIC_WAS_COPIED')
  assert.equal(await evaluate(`${button('复制本次诊断', diagnostic)}.disabled && ${button('把本次情况报给来信', diagnostic)}.disabled`), true)
  await main('__networkUiFixture.configVersion = "ui-fixture"; true')
  await screenshot('diagnostics-dg02-same-snapshot.png')

  // DG-02 repair: a channel proof that crosses 90 seconds inside copy validation is stale.
  await main('Object.assign(__networkUiFixture, {delayFaultRead:false, renewDuringFaultRead:false, lastVerifiedAt:new Date().toISOString(), faults:[], repair:{running:false,phase:"idle",outcome:"idle",code:"",message:"",startedAt:"",finishedAt:""}}); true')
  await click('开始检查', diagnostic); await complete()
  await main('globalThis.__diagnosticClipboard = "expiry-sentinel"; Object.assign(__networkUiFixture, {lastVerifiedAt:new Date(Date.now()-89000).toISOString(), delayFaultRead:true}); true')
  await click('复制本次诊断', diagnostic)
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('重新检查')`), 'copy-expired-inside-capture', 10_000)
  assert.equal(await main('globalThis.__diagnosticClipboard'), 'expiry-sentinel', 'EXPIRED_DURING_CAPTURE_WAS_COPIED')

  // A verification written during the same slow read is picked up by the final tunnel read.
  await main('Object.assign(__networkUiFixture, {delayFaultRead:false, renewDuringFaultRead:false, lastVerifiedAt:new Date().toISOString()}); true')
  await click('开始检查', diagnostic); await complete()
  await main('globalThis.__diagnosticClipboard = "renewal-sentinel"; Object.assign(__networkUiFixture, {lastVerifiedAt:new Date(Date.now()-89000).toISOString(), delayFaultRead:true, renewDuringFaultRead:true}); true')
  await click('复制本次诊断', diagnostic)
  const renewedCopy = await until(() => main('globalThis.__diagnosticClipboard !== "renewal-sentinel" && globalThis.__diagnosticClipboard'), 'copy-renewed-inside-capture', 10_000)
  assert.equal(renewedCopy, await main('__networkUiFixture.lastRun.text'), 'RENEWED_COPY_CHANGED_SNAPSHOT')

  // Twenty historical actions plus the latest repair share one capped list in UI, copy, and upload.
  await main(`(() => {
    const now = Date.now();
    Object.assign(__networkUiFixture, {
      delayFaultRead:false, renewDuringFaultRead:false, lastVerifiedAt:new Date().toISOString(),
      faults:Array.from({length:20}, (_, index) => ({at:new Date(now-index*1000).toISOString(),version:'0.5.14',shell:'codex',code:'network_error',action:'retest',outcome:'still_failing'})),
      repair:{running:false,phase:'finished',outcome:'recovered',code:'NETWORK_RECOVERED',startedAt:new Date(now-5000).toISOString(),finishedAt:new Date(now-1000).toISOString(),message:''}
    });
    return true;
  })()`)
  await click('开始检查', diagnostic); await complete()
  const cappedRun = await main('__networkUiFixture.lastRun')
  assert.equal(cappedRun.attempts.length, 20)
  assert.equal(cappedRun.attemptsTotal, 21)
  assert.ok(cappedRun.attempts.some(attempt => attempt.action === '检测并修复连接'), 'LATEST_REPAIR_DROPPED')
  assert.equal(await evaluate(`${conclusion}.innerText.includes("共读取到 21 条") && ${conclusion}.innerText.includes("只保留最近 20 条")`), true)
  assert.equal(await evaluate(`Array.from(${conclusion}.querySelectorAll('dt')).find(item => item.textContent === '已试与复验')?.parentElement.querySelectorAll('li').length`), 20)
  await main('globalThis.__diagnosticClipboard = undefined; true'); await click('复制本次诊断', diagnostic)
  const cappedCopy = await until(() => main('globalThis.__diagnosticClipboard'), 'capped-diagnostic-copy')
  assert.equal(cappedCopy, cappedRun.text)
  await click('把本次情况报给来信', diagnostic)
  await until(() => evaluate(`${diagnostic}.querySelector('[role=status]').textContent.includes('已上报')`), 'capped-diagnostic-report', 30_000)
  const cappedUpload = (await accountMessage('latest-report')).report
  assert.deepEqual(cappedUpload.body.diagnosis.attempts, cappedRun.attempts)
  assert.equal(cappedUpload.body.diagnosis.attemptsTotal, cappedRun.attemptsTotal)
  await main('Object.assign(__networkUiFixture, {faults:[], delayFaultRead:false, renewDuringFaultRead:false, repair:{running:false,phase:"idle",outcome:"idle",code:"",message:"",startedAt:"",finishedAt:""}}); true')
  await screenshot('diagnostics-dg02-repair-boundaries.png')
  const firstSummary = await summary()
  for (const code of ['AI_DIAG_INTERNET_OK', 'AI_DIAG_TUNNEL_VERIFIED', 'AI_DIAG_SERVICE_REACHABLE', 'AI_DIAG_ACCOUNT_MANUAL', 'AI_DIAG_APPLICATION_UNCONFIRMED']) assert.ok(firstSummary.includes(code), code)
  assert.ok(!firstSummary.includes('https://') && !firstSummary.includes(working))
  await evaluate(`${diagnostic}.scrollIntoView({block:'start'}); true`); await screenshot('diagnostics-dg01-summary.png')
  assert.equal(await evaluate('Boolean(document.querySelector(".terminal-observation"))'), false, 'MANUAL_TERMINAL_OBSERVATION_VISIBLE')
  assert.equal(await evaluate('document.body.innerText.includes("生成并复制终端命令") || document.body.innerText.includes("查看观察结果")'), false, 'MANUAL_TERMINAL_COMMAND_VISIBLE')

  // DG-01 scenario 1: one domestic probe can fail while the selected target still responds.
  await main('Object.assign(__networkUiFixture, {mode:"domestic-unavailable", targetStatus:200, state:"未配置", selection:{mode:"deepseek", routed:true, serviceRunning:true, observedClientCall:null}}); true')
  await click('开始检查', diagnostic); await complete()
  const domesticFailure = await conclusionSnapshot()
  assert.equal(domesticFailure.ruleId, 'DG01_APPLICATION_UNCONFIRMED')
  assert.equal(await evaluate(`${diagnostic}.innerText.includes("单个检测地址不可达")`), true)
  assert.doesNotMatch(domesticFailure.text, /整机断网|账号失效/)

  // DG-01 scenario 2: a domestic provider is direct, and a stopped local API is the blocker.
  await main('Object.assign(__networkUiFixture, {mode:"ok", targetStatus:200, selection:{mode:"deepseek", routed:true, serviceRunning:false, observedClientCall:null}}); true')
  await click('开始检查', diagnostic); await complete()
  const localService = await conclusionSnapshot()
  assert.equal(localService.ruleId, 'DG01_LOCAL_SERVICE_DOWN')
  assert.match(localService.text, /本机 API 服务.*没有运行|重启本机 API 服务/)
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').children[1]?.innerText.includes("不需要接通 AI网络")`), true)
  await screenshot('diagnostics-local-service-down.png')

  // DG-01 scenario 3: unauthenticated root responses prove only that the target responded.
  for (const status of [401, 403, 429]) {
    await main(`Object.assign(__networkUiFixture, {mode:"ok", targetStatus:${status}, selection:{mode:"deepseek", routed:true, serviceRunning:true, observedClientCall:null}}); true`)
    await click('开始检查', diagnostic); await complete()
    const boundary = await conclusionSnapshot()
    assert.equal(boundary.ruleId, 'DG01_TARGET_RESPONSE_BOUNDARY')
    assert.doesNotMatch(boundary.text, /Key 错|欠费|封号/)
  }
  await screenshot('diagnostics-unauthenticated-boundary.png')

  // DG-01 scenario 4: a verified channel plus unreachable target does not prove server failure.
  await main('Object.assign(__networkUiFixture, {mode:"target-unavailable", targetStatus:200, state:"已连", selection:{mode:"official"}}); true')
  await click('开始检查', diagnostic); await complete()
  const targetPath = await conclusionSnapshot()
  assert.equal(targetPath.ruleId, 'DG01_TARGET_PATH_UNCONFIRMED')
  assert.match(targetPath.text, /经当前通道/)
  assert.doesNotMatch(targetPath.text, /服务器故障/)

  // DG-01 scenario 5: switching the selected route during a run invalidates old evidence.
  await main('Object.assign(__networkUiFixture, {mode:"hold", targetStatus:200, state:"已连", calls:[], releases:[], selection:{mode:"official"}}); true')
  await click('开始检查', diagnostic)
  await until(() => main('__networkUiFixture.releases.length === 1'), 'context-change-held-probe')
  await main('__networkUiFixture.mode="ok"; __networkUiFixture.selection={mode:"deepseek", routed:true, serviceRunning:true, observedClientCall:null}; __networkUiFixture.releases.splice(0).forEach(resolve => resolve()); true')
  await complete()
  const changedEvidence = await conclusionSnapshot()
  assert.equal(changedEvidence.ruleId, 'DG01_EVIDENCE_CHANGED')
  assert.match(changedEvidence.text, /证据已失效|重新检查/)

  // A channel record valid at the start cannot support the result after it expires during probes.
  await main('Object.assign(__networkUiFixture, {mode:"expire-tunnel", timeOffset:-2000, lastVerifiedAt:new Date(Date.now()-91000).toISOString(), targetStatus:200, state:"已连", selection:{mode:"official", observedClientCall:new Date().toISOString()}, selections:[]}); true')
  await click('开始检查', diagnostic); await complete()
  const expiredTunnel = await conclusionSnapshot()
  assert.equal(expiredTunnel.ruleId, 'DG01_EVIDENCE_CHANGED')
  assert.match(expiredTunnel.text, /证据已失效|重新检查/)
  assert.equal(await evaluate(`${diagnostic}.innerText.includes("检查期间通道发生变化")`), true)
  await screenshot('diagnostics-tunnel-expired-during-run.png')

  // A fresh verification written before completion keeps the channel evidence valid.
  await main('Object.assign(__networkUiFixture, {mode:"refresh-tunnel", timeOffset:-2000, lastVerifiedAt:new Date(Date.now()-91000).toISOString(), targetStatus:200, state:"已连", selection:{mode:"official", observedClientCall:new Date().toISOString()}, selections:[]}); true')
  await click('开始检查', diagnostic); await complete()
  const refreshedTunnel = await conclusionSnapshot()
  assert.deepEqual({ ruleId: refreshedTunnel.ruleId, status: refreshedTunnel.status }, { ruleId: 'DG01_NO_BLOCKER_FOUND', status: 'clear' })
  assert.doesNotMatch(refreshedTunnel.text, /证据已失效|重新检查/)
  await screenshot('diagnostics-tunnel-refreshed-during-run.png')

  // A normal runtime transition and a newly observed request update evidence without changing configuration.
  await main('Object.assign(__networkUiFixture, {mode:"ok", timeOffset:0, lastVerifiedAt:null, targetStatus:200, state:"未配置", selections:[{mode:"deepseek", routed:true, serviceRunning:false, observedClientCall:null},{mode:"deepseek", routed:true, serviceRunning:true, observedClientCall:new Date().toISOString()}]}); true')
  await click('开始检查', diagnostic); await complete()
  const normalRequest = await conclusionSnapshot()
  assert.deepEqual({ ruleId: normalRequest.ruleId, status: normalRequest.status }, { ruleId: 'DG01_NO_BLOCKER_FOUND', status: 'clear' })
  assert.doesNotMatch(normalRequest.text, /模型配置发生变化|证据已失效/)
  assert.equal(await evaluate(`${diagnostic}.innerText.includes("成功调用过工具箱的模型 API")`), true)
  await screenshot('diagnostics-normal-request.png')

  // DG-01 scenario 6: unreadable context remains unknown; a good control stays clear.
  await main('Object.assign(__networkUiFixture, {mode:"unreadable", state:"已连", selection:{mode:"official"}}); true')
  await click('开始检查', diagnostic); await complete()
  const unreadable = await conclusionSnapshot()
  assert.equal(unreadable.ruleId, 'DG01_CONTEXT_UNREADABLE')
  assert.match(unreadable.text, /不能定位|重新检查/)
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').children.length`), 5)
  await main('Object.assign(__networkUiFixture, {mode:"ok", targetStatus:200, state:"未配置", selection:{mode:"deepseek", routed:true, serviceRunning:true, observedClientCall:new Date().toISOString()}}); true')
  await choose('hermes'); await click('开始检查', diagnostic); await complete()
  const clearControl = await conclusionSnapshot()
  assert.deepEqual({ ruleId: clearControl.ruleId, status: clearControl.status }, { ruleId: 'DG01_NO_BLOCKER_FOUND', status: 'clear' })
  assert.doesNotMatch(clearControl.text, /故障|断网|失效/)
  await screenshot('diagnostics-clear-control.png')

  await choose('claude')
  assert.equal(await evaluate(`${diagnostic}.querySelector('ol').hidden`), true, 'SOFTWARE_SWITCH_STALE_RESULT')
  const changedSummary = await copySupport()
  assert.ok(!changedSummary.includes('AI_DIAG_SERVICE_REACHABLE'), 'OPEN_SUPPORT_RETAINED_PREVIOUS_SOFTWARE_RESULT')
  await main('Object.assign(__networkUiFixture, {mode:"ok", targetStatus:401, state:"已连", selection:{mode:"official"}}); true'); await click('开始检查', diagnostic); await complete()
  const authSummary = await copySupport(); assert.ok(authSummary.includes('软件:Claude Code') && authSummary.includes('AI_DIAG_SERVICE_AUTH'))
  assert.ok(!authSummary.includes('AI_DIAG_SERVICE_REACHABLE'))
  await choose('hermes'); await main('__networkUiFixture.mode="ok"; __networkUiFixture.targetStatus=200; __networkUiFixture.timeOffset=-595000; true')
  await click('开始检查', diagnostic); await complete()
  const directSummary = await copySupport()
  assert.ok(directSummary.includes('AI_DIAG_DIRECT_SERVICE') && directSummary.includes('AI_DIAG_SERVICE_REACHABLE'), directSummary)
  await until(() => evaluate('document.querySelector(".support-context")?.textContent.includes("检查结果已过期")'), 'open-support-expiry')
  const expiredSummary = await copySupport()
  assert.ok(expiredSummary.includes('NETWORK_DIAGNOSTIC_STALE') && !expiredSummary.includes('AI_DIAG_SERVICE_REACHABLE'))
  await choose('codex'); await main('Object.assign(__networkUiFixture, {mode:"hold", timeOffset:0, calls:[], releases:[], targetStatus:200, state:"已连", selection:{mode:"official"}}); true')
  await click('开始检查', diagnostic)
  await until(() => main('__networkUiFixture.releases.length === 1'), 'held-probe')
  assert.equal(await evaluate(`${select}.disabled && ${button('开始检查', diagnostic)}.disabled`), true)
  await evaluate('window.__same = window.toolbox.networkdiagnostics.run({software:"codex"}); window.__other = window.toolbox.networkdiagnostics.run({software:"claude"}).then(() => false, () => true); true')
  assert.equal(await evaluate('await window.__other'), true, 'DIFFERENT_SOFTWARE_WAS_NOT_BLOCKED')
  assert.equal(await main('__networkUiFixture.calls.length'), 1, 'DUPLICATE_REQUEST_DID_NOT_COALESCE')
  await main('__networkUiFixture.mode="ok"; __networkUiFixture.releases.splice(0).forEach(resolve => resolve()); true')
  await complete(); assert.equal(await evaluate('JSON.parse((await window.__same).snapshot).software'), 'codex')
  assert.equal(await main('__networkUiFixture.calls.length'), 2)

  await main('__networkUiFixture.mode="fatal"; true'); await click('开始检查', diagnostic)
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

  await main('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].setBounds({width:620,height:420}); true')
  await evaluate(`${diagnostic}.scrollIntoView({block:'start'}); true`)
  await until(() => evaluate('window.innerWidth <= 620'), 'small-window')
  const layout = await evaluate(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,detailsWidth:${diagnostic}.getBoundingClientRect().width})`)
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `SMALL_WINDOW_OVERFLOW:${JSON.stringify(layout)}`)
  await screenshot('diagnostics-620x420.png')
  const localRequests = (await accountMessage('stats')).counts
  assert.deepEqual(localRequests, { trial: 0, network: 0 }, 'NETWORK_UI_MUST_NOT_CLAIM_TRAFFIC')
  const asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  const summaryResult = { version: metadata.version, asarSha256, isolatedDirectory: working, layout, localRequests,
    passed: ['packaged-renderer', 'restricted-bridge', 'five-diagnostic-layers-retained', 'unified-conclusion-visible', 'same-diagnostic-ui-copy-upload', 'separate-supplemental-timestamp', 'copy-expiry-uses-final-read-time', 'fresh-renewal-during-capture-keeps-evidence', 'attempt-cap-shared-by-ui-copy-upload', 'single-domestic-probe-bounded', 'domestic-provider-local-service', 'unauthenticated-401-403-429-bounded', 'verified-channel-target-path-bounded', 'context-change-invalidates-evidence', 'channel-expiry-invalidates-evidence', 'fresh-channel-renewal-keeps-evidence', 'normal-request-is-not-config-change', 'unreadable-context-unknown', 'normal-control-clear', 'conclusion-expiry', 'no-manual-terminal-command', 'safe-support-copy', 'software-change-refreshes-open-support', 'completion-refreshes-open-support', 'same-request-coalescing', 'different-request-rejection', 'failure-clears-results-and-support', 'navigation-discards-results', 'small-window-no-overflow'],
    fixtureScope: 'Diagnostic HTTP probes, tunnel status, and model selection reads are synthetic. This proves packaged UI/bridge behavior, not a customer connection or AI response.',
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
