import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDiscoveredActions } from './bridge/action-loader'
import { BridgeRegistry } from './bridge/bridge-registry'
import { installIpcBridge } from './bridge/ipc-bridge'
import { resolveRendererTarget } from './bridge/renderer-target'
import { installShutdownLifecycle } from './bridge/shutdown-lifecycle'
import { installNavigationGuards } from './bridge/window-security'
import { DesktopRuntime } from './desktop/runtime'
import { registerDesktopActions } from './desktop/bridge'
import { createMainCrashLog, createRendererRecovery } from './desktop/renderer-recovery'
import { actionLocalFault } from './bridge/local-fault'
import { recordFault } from './diagnostics/context'
import { createAiAccessStore } from './ai-access/store'
import { codexProviderKeyArgument, emitCodexProviderKey, readCodexProviderKeyRequest } from './ai-access/codex-workspace-key-reader'

// 主进程顶层异常落盘(收敛包3·件3):⛔ 静默丢失。
const logMainCrash = createMainCrashLog((line) => {
  const directory = join(app.getPath('userData'), 'logs')
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, 'main-crash.log'), line, { encoding: 'utf8' })
})
process.on('uncaughtException', (error) => logMainCrash('uncaughtException', error))
process.on('unhandledRejection', (reason) => logMainCrash('unhandledRejection', reason))

let mainWindow: BrowserWindow | undefined
let currentEntryUrl: string | undefined
let desktop: DesktopRuntime

const bridgeRegistry = new BridgeRegistry({ diagnostic: logBridgeDiagnostic })
const actionModules = import.meta.glob(['./actions/*.ts', '!./actions/*.test.ts'], { eager: true })

const shutdownTimeoutMs = 5_000

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    ...desktop.bounds(),
    minWidth: 620,
    minHeight: 420,
    show: false,
    title: '来信AI工具箱',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })
  desktop.attach(mainWindow)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const target = resolveRendererTarget(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    join(__dirname, '../renderer/index.html')
  )
  currentEntryUrl = target.kind === 'file' ? pathToFileURL(target.value).href : target.value
  installNavigationGuards(mainWindow.webContents, currentEntryUrl)

  // 渲染进程崩溃自愈(收敛包3·件3):第一次自动 reload 并提示;连续崩溃给可复制诊断。
  const reloadEntry = () => {
    void mainWindow?.webContents.loadURL(target.kind === 'url' ? target.value : pathToFileURL(target.value).href)
  }
  const rendererRecovery = createRendererRecovery({
    reload: reloadEntry,
    notify: (message) => {
      if (Notification.isSupported()) new Notification({ title: '来信AI工具箱', body: message, silent: true }).show()
      else void dialog.showMessageBox({ type: 'warning', title: '来信AI工具箱', message })
    },
    showDialog: async (title, message, detail) => {
      const result = await dialog.showMessageBox(mainWindow!, { type: 'error', title, message, detail, buttons: ['复制诊断信息', '关闭'] })
      if (result.response === 0) clipboard.writeText(detail)
    },
    now: Date.now
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logMainCrash('render-process-gone', new Error(`渲染进程退出:${details.reason} exitCode=${details.exitCode}`))
    rendererRecovery.handle({ reason: details.reason, exitCode: details.exitCode })
  })

  if (target.kind === 'url') {
    await mainWindow.loadURL(target.value)
    return
  }

  await mainWindow.loadFile(target.value)
}

const providerKeyRequest = readCodexProviderKeyRequest(process.argv)
if (!process.argv.includes(codexProviderKeyArgument)) startApplication()
else if (providerKeyRequest === undefined) app.exit(1)
else void app.whenReady().then(async () => {
  app.dock?.hide()
  const ok = await emitCodexProviderKey(providerKeyRequest, createAiAccessStore(join(app.getPath('userData'), 'ai-access')))
  app.exit(ok ? 0 : 1)
}, () => app.exit(1))

function startApplication(): void {
  const primaryInstance = app.requestSingleInstanceLock()
  if (!primaryInstance) { app.exit(0); return }
  app.on('second-instance', () => desktop?.show())
  void app.whenReady().then(async () => {
    registerDiscoveredActions(bridgeRegistry, actionModules)
    desktop = new DesktopRuntime(bridgeRegistry)
    registerDesktopActions(bridgeRegistry, desktop)
    installIpcBridge(ipcMain, {
      registry: bridgeRegistry,
      mainFrame: () => mainWindow?.webContents.mainFrame ?? null,
      entryUrl: () => {
        if (currentEntryUrl === undefined) {
          throw new Error('主窗口尚未登记入口地址。')
        }
        return currentEntryUrl
      }
    })
    installShutdownLifecycle(app, bridgeRegistry.shutdownHooks, shutdownTimeoutMs, logBridgeDiagnostic)
    await createWindow()

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow()
      } else desktop.show()
    })
  })
  app.on('window-all-closed', () => { app.quit() })
}

function logBridgeDiagnostic(code: string, subject: string, error?: unknown): void {
  console.error(`[toolbox-bridge] ${code}:${subject}`)
  // 甲-6:兜底的原始错误落进本机故障记录(诊断包收集);⛔ 只进 console.error(打包 GUI 下 stderr 蒸发)。
  // 甲-6返工:按动作归类——tunnel.* 照旧记通道码;其余模块不再冒充网络问题,记模块+动作维度。
  // 参数形状仍只有受控枚举/受控形状(错误名:fs码);⛔ 原始消息(可能带路径)。
  const fault = actionLocalFault(code, subject, error)
  if (fault !== undefined) recordFault(fault)
}
