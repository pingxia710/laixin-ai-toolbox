import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ActionRegistry } from '../../app/main/bridge/action-registry'
import { installIpcBridge } from '../../app/main/bridge/ipc-bridge'
import { schema } from '../../app/main/bridge/schema'

const expectedScenarios = new Set(['/main.html', '/child.html', '/main.html.evil', '/other.html'])
const results = new Map<string, { readonly accepted: boolean; readonly rejectedBySourceGuard?: boolean }>()
let receiverCalls = 0
let actionCalls = 0
let primaryWindow: BrowserWindow | undefined
let finishing = false

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(path === '/main.html' ? '<iframe src="/child.html"></iframe>' : '<main>probe</main>')
})

void app
  .whenReady()
  .then(async () => {
    if (process.env.TOOLBOX_PAGE_LIFECYCLE_PROBE === '1') {
      await runPageLifecycleProbe()
      return
    }
    await runSourceGuardProbe()
  })
  .catch((error: unknown) => {
    process.stderr.write(`BRIDGE_PROBE_UNEXPECTED_ERROR=${String(error)}\n`)
    app.exit(1)
  })

async function runSourceGuardProbe(): Promise<void> {
  const port = await listen(server)
  const expectedEntry = `http://127.0.0.1:${port}/main.html`
  const registry = new ActionRegistry()
  registry.registerAction({
    name: 'test.ping',
    paramsSchema: schema.undefined(),
    resultSchema: schema.object({ ok: schema.boolean() }),
    handler: () => {
      actionCalls += 1
      return { ok: true }
    }
  })
  installIpcBridge(ipcMain, {
    registry,
    mainFrame: () => primaryWindow?.webContents.mainFrame ?? null,
    entryUrl: () => expectedEntry,
    received: () => {
      receiverCalls += 1
    }
  })
  ipcMain.on('bridge-probe-result', (_event, result: unknown) => {
    if (!isProbeResult(result) || !expectedScenarios.has(result.scenario)) {
      return
    }
    results.set(result.scenario, result)
    if (results.size === expectedScenarios.size) {
      finishSourceGuardProbe()
    }
  })

  primaryWindow = createSenderWindow()
  await primaryWindow.loadURL(expectedEntry)
  const pseudoPrefixWindow = createSenderWindow()
  await pseudoPrefixWindow.loadURL(`${expectedEntry}.evil`)
  const sameOriginWindow = createSenderWindow()
  await sameOriginWindow.loadURL(`http://127.0.0.1:${port}/other.html`)

  setTimeout(() => finishSourceGuardProbe(), 8_000)
}

function createSenderWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegrationInSubFrames: true,
      preload: join(process.cwd(), 'tests/electron/bridge-sender-preload.cjs')
    }
  })
}

function finishSourceGuardProbe(): void {
  if (finishing) {
    return
  }
  finishing = true
  const encoded = JSON.stringify({
    receiverCalls,
    actionCalls,
    results: Object.fromEntries(results)
  })
  const passed = sourceGuardProbePassed()
  process.stdout.write(`${encoded}\nSOURCE_GUARD_PROBE=${passed ? 'PASS' : 'FAIL'}\n`)
  server.close()
  app.exit(passed ? 0 : 1)
}

function sourceGuardProbePassed(): boolean {
  if (receiverCalls !== 4 || actionCalls !== 1 || results.size !== expectedScenarios.size) {
    return false
  }
  return [...expectedScenarios].every((scenario) => {
    const result = results.get(scenario)
    if (result === undefined) {
      return false
    }
    return scenario === '/main.html'
      ? result.accepted === true
      : result.accepted === false && result.rejectedBySourceGuard === true
  })
}

async function runPageLifecycleProbe(): Promise<void> {
  const pageWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: join(process.cwd(), 'tests/electron/page-probe-preload.cjs')
    }
  })
  pageWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    process.stderr.write(`PAGE_LIFECYCLE_CONSOLE=${sourceId}:${line}:${message}\n`)
  })
  await pageWindow.loadFile(join(__dirname, '../renderer/index.html'))
  await pageWindow.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const wait = () => {
        if (document.querySelector('#tab-tunnel') !== null) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error('PAGE_LIFECYCLE_NAVIGATION_NOT_READY'));
        } else {
          setTimeout(wait, 10);
        }
      };
      wait();
    });
  `)
  const result = await pageWindow.webContents.executeJavaScript(`
    (async () => {
    const ids = ['example.alpha', 'example.beta'];
    const click = (id) => document.querySelector('#tab-' + id).click();
    const waitFor = (selector) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const wait = () => {
        if (document.querySelector(selector) !== null) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error('PAGE_LIFECYCLE_SELECTOR_NOT_READY:' + selector));
        } else {
          setTimeout(wait, 10);
        }
      };
      wait();
    });
    const read = () => Object.fromEntries(ids.map((id) => {
      const node = document.querySelector('[data-module-id="' + id + '"]');
      return [id, node === null ? null : node.getAttribute('data-listener-count')];
    }));
    click('tunnel');
    await waitFor('[data-module-id="example.alpha"]');
    const first = read();
    const stateBeforeUnmount = Object.fromEntries(ids.map((id) => {
      const node = document.querySelector('[data-module-id="' + id + '"]');
      node.click();
      return [id, node.textContent];
    }));
    const detached = Object.fromEntries(ids.map((id) => [id, document.querySelector('[data-module-id="' + id + '"]')]));
    click('dashboard');
    const afterUnmount = Object.fromEntries(ids.map((id) => [id, detached[id]?.getAttribute('data-listener-count') ?? null]));
    click('tunnel');
    await waitFor('[data-module-id="example.alpha"]');
    const stateAfterRemount = Object.fromEntries(ids.map((id) => {
      const node = document.querySelector('[data-module-id="' + id + '"]');
      return [id, node.textContent];
    }));
    return { first, afterUnmount, afterRemount: read(), stateBeforeUnmount, stateAfterRemount };
    })();
  `)
  const listenerCountsPassed = pageLifecycleListenerCountsPassed(result)
  const statePreserved = pageLifecycleStatePreserved(result)
  const passed = listenerCountsPassed && statePreserved
  process.stdout.write(`PAGE_LIFECYCLE_LISTENER_COUNTS=${JSON.stringify(result)}\n`)
  process.stdout.write(`PAGE_LIFECYCLE_STATE_PRESERVED=${statePreserved ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`PAGE_LIFECYCLE_PROBE=${passed ? 'PASS' : 'FAIL'}\n`)
  pageWindow.destroy()
  app.exit(passed ? 0 : 1)
}

function pageLifecycleListenerCountsPassed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const expected = { 'example.alpha': '1', 'example.beta': '1' }
  return (
    ['first', 'afterRemount'].every((key) => valueHasExactCounts(value, key, expected)) &&
    valueHasExactCounts(value, 'afterUnmount', { 'example.alpha': '0', 'example.beta': '0' })
  )
}

function pageLifecycleStatePreserved(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const expected = { 'example.alpha': 'alpha:1', 'example.beta': 'beta:1' }
  return (
    valueHasExactCounts(value, 'stateBeforeUnmount', expected) &&
    valueHasExactCounts(value, 'stateAfterRemount', expected)
  )
}

function valueHasExactCounts(
  value: object,
  key: string,
  expected: Readonly<Record<string, string>>
): boolean {
  if (!(key in value)) {
    return false
  }
  const candidate = value[key as keyof typeof value]
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Object.entries(expected).every(([moduleId, count]) => candidate[moduleId] === count)
  )
}

function listen(httpServer: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        throw new Error('bridge probe failed to bind loopback')
      }
      resolve(address.port)
    })
  })
}

function isProbeResult(
  value: unknown
): value is { readonly scenario: string; readonly accepted: boolean; readonly rejectedBySourceGuard?: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scenario' in value &&
    typeof value.scenario === 'string' &&
    'accepted' in value &&
    typeof value.accepted === 'boolean' &&
    (!('rejectedBySourceGuard' in value) || typeof value.rejectedBySourceGuard === 'boolean')
  )
}
