import { app, dialog, shell } from 'electron'
import { constants } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { loadCatalog } from '../download/catalog'
import { DownloadManager } from '../download/download-manager'
import { ElectronDownloadEngine } from '../download/electron-download-engine'
import { MacArtifactInspector, MacInstallerHandoff } from '../download/mac-artifact'
import { WinArtifactInspector, WinInstallerHandoff } from '../download/win-artifact'
import { hasExistingInstallation } from '../download/preinstall'
import { createFileTaskStore, taskPaths } from '../download/task-store'
import { downloadTunnelSnapshot } from '../download/tunnel-runtime'
import type { DownloadTaskSnapshot } from '../download/types'
import { captureDownloadReport } from '../account/installation-report'
import { canChooseLocalDownload } from '../download/runtime-compatibility'

let manager: DownloadManager | undefined
let managerRecovery: Promise<void> | undefined
let choosingLocal = false
const officialEntries = new Set([
  'codex-official-download', 'codex-github',
  'claude-code-official-install', 'claude-code-github',
  'hermes-official-download', 'hermes-github',
  'deepseek-harness-official-install', 'deepseek-harness-github',
  'zcode-official-download',
  'kimi-code-official-install', 'kimi-code-github'
])

const taskSchema = schema.object({ taskId: schema.string({ maxLength: 100 }) })
const resourceSchema = schema.object({ resourceId: schema.string({ maxLength: 100 }) })
const resultSchema = schema.object({
  taskId: schema.string({ maxLength: 100 }),
  state: schema.string({ maxLength: 100 }),
  reason: schema.string({ maxLength: 100 }),
  message: schema.string({ maxLength: 100 }),
  receivedBytes: schema.string({ maxLength: 100 }),
  totalBytes: schema.string({ maxLength: 100 }),
  retryCount: schema.string({ maxLength: 100 }),
  localSha256: schema.string({ maxLength: 100 }),
  installerPath: schema.string({ maxLength: 500 })
})

export function registerActions(registry: BridgeRegistry): void {
  registerHandlers(registry, getManager, false)
}

// 历史下载链路仅供旧任务回归；产品注册不开放这些动作。
export function registerDownloadActions(registry: BridgeRegistry, manager: DownloadManager): void {
  registerHandlers(registry, async () => manager, true)
}

function registerHandlers(registry: BridgeRegistry, resolveManager: () => Promise<DownloadManager>, legacyActions: boolean): void {
  registry.registerAction({ name: 'download.latest', paramsSchema: resourceSchema, resultSchema,
    handler: (params) => legacyActions
      ? respond(() => resolveManager().then((manager) => manager.latest(readResourceId(params))), true)
      : historyStore().list().then((tasks) => toOptionalResult(tasks.filter((task) => task.resourceId === readResourceId(params))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0])) })
  registry.registerAction({
    name: 'download.status',
    paramsSchema: taskSchema,
    resultSchema,
    handler: (params) => legacyActions
      ? respond(() => resolveManager().then((manager) => manager.status(readTaskId(params))), true)
      : historyStore().get(readTaskId(params)).then((task) => {
        if (!task) throw new Error('DOWNLOAD_TASK_NOT_FOUND')
        return toBridgeResult(task)
      })
  })
  if (legacyActions) {
    registry.registerAction({ name: 'download.chooseLocal', paramsSchema: resourceSchema, resultSchema, handler: async (params) => {
      if (choosingLocal) throw new Error('DOWNLOAD_PICKER_BUSY')
      const resourceId = readResourceId(params)
      const resource = loadCatalog().resources.find((item) => item.id === resourceId && item.type === 'download')
      if (!resource || !canChooseLocalDownload({ platform: process.platform, architecture: process.arch }, resource)) throw new Error('DOWNLOAD_LOCAL_IMPORT_UNAVAILABLE')
      choosingLocal = true
      const report = captureDownloadReport()
      try {
        const selected = await dialog.showOpenDialog({ title: '选择已经下载的安装包', properties: ['openFile'], filters: [{ name: '安装包', extensions: [resource.format ?? 'dmg'] }] })
        const manager = await resolveManager()
        if (selected.canceled || selected.filePaths.length !== 1) return toOptionalResult(await manager.latest(resourceId))
        const task = await manager.importLocal(resourceId, selected.filePaths[0]); report(task); return toBridgeResult(task)
      } finally { choosingLocal = false }
    } })
    registry.registerAction({
      name: 'download.start',
      paramsSchema: resourceSchema,
      resultSchema,
      handler: (params) => respond(() => resolveManager().then((manager) => manager.start(readResourceId(params))))
    })
    registry.registerAction({
      name: 'download.cancel',
      paramsSchema: taskSchema,
      resultSchema,
      handler: (params) => respond(() => resolveManager().then((manager) => manager.cancel(readTaskId(params))))
    })
    registry.registerAction({
      name: 'download.retry',
      paramsSchema: taskSchema,
      resultSchema,
      handler: (params) => respond(() => resolveManager().then((manager) => manager.retry(readTaskId(params))))
    })
    registry.registerAction({
      name: 'download.resume',
      paramsSchema: taskSchema,
      resultSchema,
      handler: (params) => respond(() => resolveManager().then((manager) => manager.resume(readTaskId(params))))
    })
    registry.registerAction({
      name: 'download.openInstaller',
      paramsSchema: taskSchema,
      resultSchema,
      handler: (params) => respond(() => resolveManager().then((manager) => manager.openInstaller(readTaskId(params))))
    })
  }
  registry.registerAction({
    name: 'download.openExternal',
    paramsSchema: resourceSchema,
    resultSchema,
    handler: async (params) => {
      const resourceId = readResourceId(params)
      if (legacyActions) return respond(() => resolveManager().then((manager) => manager.openExternal(resourceId)))
      if (!officialEntries.has(resourceId)) throw new Error('DOWNLOAD_ENTRY_UNAVAILABLE')
      const resource = loadCatalog().resources.find((item) => item.id === resourceId && item.type === 'external-entry')
      if (!resource) throw new Error('DOWNLOAD_ENTRY_UNAVAILABLE')
      await shell.openExternal(resource.officialPageUrl)
      return { taskId: '', state: 'opened-external', reason: '', message: '已打开官方页面', receivedBytes: '0', totalBytes: '0', retryCount: '0', localSha256: '', installerPath: '' }
    }
  })
}

function historyStore() {
  return createFileTaskStore(join(app.getPath('userData'), 'toolbox-download'))
}

async function respond(operation: () => Promise<DownloadTaskSnapshot | undefined>, passive = false) {
  const report = captureDownloadReport(passive)
  const task = await operation(); report(task)
  return toOptionalResult(task)
}

async function getManager(): Promise<DownloadManager> {
  if (manager === undefined) {
    const root = join(app.getPath('userData'), 'toolbox-download')
    manager = new DownloadManager({
      catalog: loadCatalog(),
      engine: new ElectronDownloadEngine(),
      store: createFileTaskStore(root),
      inspector: process.platform === 'win32' ? new WinArtifactInspector() : new MacArtifactInspector(),
      tunnel: downloadTunnelSnapshot,
      taskPaths: (taskId, resource) => taskPaths(root, taskId, resource),
      hasExistingInstallation,
      externalOpen: (url) => shell.openExternal(url),
      installerHandoff: process.platform === 'win32'
        ? new WinInstallerHandoff((filePath) => shell.showItemInFolder(filePath), (filePath) => shell.openPath(filePath)).handoff
        : (task, resource) => new MacInstallerHandoff().handoff(task, resource),
      copyLocalArtifact: async (source, destination) => {
        const file = await stat(source)
        if (!file.isFile() || file.size === 0 || file.size > 2 * 1024 ** 3) throw new Error('DOWNLOAD_LOCAL_FILE_INVALID')
        await copyFile(source, destination, constants.COPYFILE_EXCL)
      }
    })
    managerRecovery = manager.recoverAfterRestart()
  }
  const current = manager
  try { await managerRecovery }
  catch (error) {
    if (manager === current) { manager = undefined; managerRecovery = undefined }
    throw error
  }
  return current
}

function readTaskId(params: unknown): string {
  return (params as { readonly taskId: string }).taskId
}

function readResourceId(params: unknown): string {
  return (params as { readonly resourceId: string }).resourceId
}

function toBridgeResult(task: DownloadTaskSnapshot) {
  return {
    taskId: task.taskId,
    state: task.state,
    reason: task.reason,
    message: task.message,
    receivedBytes: task.receivedBytes,
    totalBytes: task.totalBytes,
    retryCount: task.retryCount,
    localSha256: task.localSha256,
    installerPath: task.artifactPath
  }
}

function toOptionalResult(task: DownloadTaskSnapshot | undefined) {
  return task ? toBridgeResult(task) : { taskId: '', state: 'not-downloaded', reason: '', message: '未下载', receivedBytes: '0', totalBytes: '0', retryCount: '0', localSha256: '', installerPath: '' }
}
