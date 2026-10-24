import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AI_ROUTER_ARGUMENT, AI_ROUTER_CLEANUP_ARGUMENT } from './ai-access/router-resident'
import { codexProviderKeyArgument, emitCodexProviderKey, readCodexProviderKeyRequest } from './ai-access/codex-workspace-key-reader'

// Dispatch before the GUI's single-instance lock and before importing any GUI module.
if (process.argv.includes(AI_ROUTER_CLEANUP_ARGUMENT)) {
  if (process.argv.filter(arg => arg === AI_ROUTER_CLEANUP_ARGUMENT).length !== 1 || process.argv.includes(AI_ROUTER_ARGUMENT) || process.argv.includes(codexProviderKeyArgument)) app.exit(1)
  else void app.whenReady().then(async () => {
    app.dock?.hide()
    const userData = app.getPath('userData')
    const { cleanupAiRouter } = await import('./ai-access/router-cleanup')
    await cleanupAiRouter(userData, {
      executable: process.execPath,
      ...(app.isPackaged ? {} : { appPath: app.getAppPath() }),
      logDir: join(userData, 'logs')
    })
    app.exit(0)
  }).catch(() => app.exit(1))
} else if (process.argv.includes(AI_ROUTER_ARGUMENT)) {
  if (process.argv.includes(codexProviderKeyArgument) || process.argv.filter(arg => arg === AI_ROUTER_ARGUMENT).length !== 1) app.exit(1)
  else void app.whenReady().then(async () => {
    app.dock?.hide()
    const { runHeadlessRouter } = await import('./ai-access/headless-router')
    await runHeadlessRouter()
  }).catch(error => {
    // Never include raw exception text: it can contain local paths or provider material.
    try {
      const logs = join(app.getPath('userData'), 'logs')
      mkdirSync(logs, { recursive: true, mode: 0o700 })
      appendFileSync(join(logs, 'ai-router.log'), `${new Date().toISOString()} start_failed\n`, { mode: 0o600 })
    } catch { /* logging cannot change the fail-closed exit */ }
    console.error('[ai-router] start failed')
    app.exit((error as Error)?.message === 'AI_ROUTER_SEAT_HELD' ? 0 : 1)
  })
} else if (process.argv.includes(codexProviderKeyArgument)) {
  const source = readCodexProviderKeyRequest(process.argv)
  if (!source) app.exit(1)
  else void app.whenReady().then(async () => {
    app.dock?.hide()
    const userData = app.getPath('userData')
    const { readRouterBusinessState } = await import('./ai-access/router-state')
    const { AiRouterController } = await import('./ai-access/router-controller')
    const isolatedFixture = !app.isPackaged && process.env.TOOLBOX_API15R_FIXTURE === '1'
    const controller = new AiRouterController(userData, {
      executable: process.execPath,
      ...(app.isPackaged ? {} : { appPath: isolatedFixture ? process.argv[1] : app.getAppPath() }),
      logDir: join(userData, 'logs')
    }, { preferSpawn: isolatedFixture })
    const ok = await emitCodexProviderKey(source, { read: () => readRouterBusinessState(userData) },
      value => { process.stdout.write(value) }, { ensureReady: state => controller.ensureReady(state) })
    app.exit(ok ? 0 : 1)
  }).catch(() => app.exit(1))
} else {
  void import('./gui').then(({ startApplication }) => startApplication()).catch(() => app.exit(1))
}
