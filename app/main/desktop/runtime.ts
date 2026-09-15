import { app, type BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from 'electron'
import { join } from 'node:path'
import type { DesktopAlert, DesktopView, UpdateView } from '../../desktop-types'
import type { AccountView } from '../../account-types'
import type { UsageReport } from '../codex-usage/types'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { displayReleaseVersion } from '../../release-version'
import { ApplicationLauncher } from './applications'
import { quotaAlerts } from './alerts'
import { debounce, DesktopStore, FAILURE_REPORT_DEFAULT_ENABLED, visibleBounds } from './preferences'
import { keepWindowInBackground } from './window-lifecycle'
import { loginItemStatus, setLoginItem, type LoginItemController } from './login-item'
import {
  RESIDENT_DEFAULT_ENABLED, applyResidentChoice, residentToggleStatus, systemResidentController,
  type ResidentController, type ResidentPreference, type ResidentToggleStatus
} from './resident-preference'
import { calibrateResident } from '../tunnel/resident-owner'
import { updateConnectOutcome } from '../tunnel/runtime-owner'
import { acknowledgeUpdate, ToolboxUpdater } from './updater'
import { AUTO_UPDATE_TICK_MS, AutoUpdateCoordinator, updateReadyMessage } from './auto-update'
import { applicationMenuTemplate } from './app-menu'
import { recipeStore } from '../shells/context'
import { asTrayNetworkStatus, TRAY_NETWORK_OPERATION_INCOMPLETE, trayNetworkFailureMessage, trayMenuSignature, trayNetworkPresentation, type TrayNetworkStatus } from './tray-network'

declare const __TOOLBOX_UPDATE_PUBLIC_KEY__: string
declare const __TOOLBOX_UPDATE_ORIGIN__: string
declare const __TOOLBOX_GITHUB_REPOSITORY__: string
export const DESKTOP_NAVIGATION = 'toolbox:desktop-navigation'

const electronLoginItem: LoginItemController = {
  get: () => app.getLoginItemSettings(),
  set: (options) => app.setLoginItemSettings(options)
}

export class DesktopRuntime {
  readonly store = new DesktopStore(join(app.getPath('userData'), 'desktop.json'))
  readonly launcher = new ApplicationLauncher(app.getPath('home'), process.platform, (path) => shell.openPath(path))
  readonly updater: ToolboxUpdater
  private readonly autoUpdate: AutoUpdateCoordinator
  private updateNotification?: Notification
  private tray?: Tray
  private window?: BrowserWindow
  private quitting = false
  private disposed = false
  private polling = false
  private tunnelStatus?: TrayNetworkStatus
  private tunnelStatusPending = false
  private tunnelActionPending = false
  private trayNetworkNotification?: Notification
  private alerts: DesktopAlert[] = []
  private notifications = new Map<string, Notification>()
  private timers: ReturnType<typeof setInterval>[] = []
  private startupTimers: ReturnType<typeof setTimeout>[] = []
  private updateDirectory = join(app.getPath('userData'), 'updates')
  // resize/move 防抖落盘;签名未变化时不重建托盘菜单。
  private readonly persistWindowBounds = debounce(() => { void this.saveWindowAsync() }, 300)
  private lastMenuSignature = ''
  // 常驻项(mac LaunchAgent / Windows 登录任务)。这里只用来「看还在不在」和「撤掉」,装归连接路径。
  private readonly resident: ResidentController = systemResidentController()

  constructor(private readonly registry: BridgeRegistry) {
    if (process.platform === 'win32') app.setAppUserModelId('com.laixin.ai-toolbox.ui-capabilities')
    // 生产环境换精简中文菜单(⛔ reload/devtools);开发模式保留默认菜单便于调试。
    if (app.isPackaged) Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform)))
    const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
    this.updater = new ToolboxUpdater({ version: app.getVersion(), platform: `${process.platform}-${process.arch}`,
      origin: __TOOLBOX_UPDATE_ORIGIN__, githubRepository: __TOOLBOX_GITHUB_REPOSITORY__, publicKey: __TOOLBOX_UPDATE_PUBLIC_KEY__, directory: this.updateDirectory,
      executable: process.execPath, helperPath: join(resources, process.platform === 'win32' ? 'update-helper.ps1' : 'update-helper.cjs'),
      packaged: app.isPackaged, quit: () => app.quit() })
    this.autoUpdate = new AutoUpdateCoordinator(this.updater,
      { autoUpdate: () => this.store.preferences().autoUpdate, notified: (key) => this.store.notified(key),
        remember: (key) => { try { this.store.rememberNotification(key) } catch { console.error('[toolbox-desktop] NOTIFICATION_PREFERENCES_UNAVAILABLE') } } },
      { notify: (version) => this.showUpdateReady(version) })
    try {
      let icon = nativeImage.createFromPath(join(resources, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.ico'))
      if (icon.isEmpty()) throw new Error('TRAY_ICON_MISSING')
      if (process.platform === 'darwin') { icon = icon.resize({ width: 18, height: 18 }); icon.setTemplateImage(true) }
      this.tray = new Tray(icon)
      this.tray.setToolTip('来信 AI 工具箱')
      this.tray.on('double-click', () => this.show())
      this.refreshMenu()
      void this.refreshTunnelStatus()
    } catch { console.error('[toolbox-desktop] TRAY_UNAVAILABLE') }
    app.on('before-quit', () => { this.quitting = true; this.saveWindow() })
    registry.registerShutdownHook('desktop', () => this.dispose())
    // 启动固定跑一次「按开关校准常驻」(装或卸)。⛔ 依赖更新助手去装——助手跑在旧版上下文里,
    // 而更新原地换过 bundle 之后,旧描述文件里的可执行路径已经不对了,必须由新版自己重装。
    this.startupTimers.push(setTimeout(() => { void this.calibrateResidentOnBoot() }, 1_000))
    this.startupTimers.push(setTimeout(() => { void this.pollQuotas() }, 15_000))
    this.startupTimers.push(setTimeout(() => { void this.runAutoUpdate('startup') }, 30_000))
    this.timers.push(setInterval(() => { void this.pollQuotas() }, 5 * 60_000))
    this.timers.push(setInterval(() => { void this.runAutoUpdate('interval') }, AUTO_UPDATE_TICK_MS))
    // 唤醒后网络可能刚恢复，稍等再检查；协调器自己决定是否到期。
    powerMonitor.on('resume', () => { this.startupTimers.push(setTimeout(() => { void this.runAutoUpdate('resume') }, 60_000)) })
    this.timers.push(setInterval(() => this.refreshMenu(), 30_000))
    this.timers.push(setInterval(() => { void this.refreshTunnelStatus() }, 5_000))
  }

  bounds() {
    const saved = visibleBounds(this.store.window().bounds, screen.getAllDisplays().map((display) => display.workArea))
    const area = screen.getPrimaryDisplay().workArea
    return saved ?? { width: Math.min(1180, area.width), height: Math.min(820, area.height) }
  }
  attach(window: BrowserWindow): void {
    this.window = window
    const maximized = this.store.window().maximized
    keepWindowInBackground(window, () => !!this.tray && !this.quitting, () => this.saveWindow())
    window.webContents.on('did-finish-load', () => {
      window.webContents.setZoomFactor(this.store.preferences().zoom)
    })
    window.once('ready-to-show', () => { if (maximized) window.maximize() })
    window.on('resize', () => this.persistWindowBounds())
    window.on('move', () => this.persistWindowBounds())
  }

  async ready(): Promise<void> {
    // 回执可能要等网络连上(更新前客户是连着的那种),⛔ 卡住 ready ——界面还等着它返回。
    // 放到后台盯;盯到「已连」或「客户自己不要连了」就写回执,到点没连上就记下这一版并退出让台。
    void acknowledgeUpdate(this.updateDirectory, app.getVersion(), {
      outcome: () => updateConnectOutcome(),
      giveUp: () => { this.quitting = true; app.quit() }
    }).catch(() => undefined)
    await recipeStore().load().catch(() => undefined)
  }

  show(tab?: string): void {
    if (!this.window || this.window.isDestroyed()) return
    if (this.window.isMinimized()) this.window.restore()
    this.window.show(); this.window.focus()
    if (tab) this.window.webContents.send(DESKTOP_NAVIGATION, tab)
  }

  async status(): Promise<DesktopView> {
    await this.readAlerts()
    const preferences = this.store.preferences()
    return { preferences, backgroundAvailable: !!this.tray, alerts: preferences.quotaNotifications ? this.alerts : [], update: this.updater.status() }
  }

  configure(zoom: string, quotaNotifications: boolean, autoUpdate: boolean): Promise<DesktopView> {
    const previous = this.store.preferences().autoUpdate
    this.store.save({ zoom: Number(zoom), quotaNotifications, autoUpdate })
    this.window?.webContents.setZoomFactor(this.store.preferences().zoom)
    if (!quotaNotifications) { for (const notification of this.notifications.values()) notification.close(); this.notifications.clear() }
    else void this.pollQuotas()
    if (autoUpdate && !previous) void this.runAutoUpdate('manual')
    return this.status()
  }

  // 设置页手动检查：检查结果立即返回；开启自动更新时随后自动下载并提醒。
  async checkUpdate(): Promise<UpdateView> {
    const view = await this.updater.check()
    if (view.state === 'available' && this.store.preferences().autoUpdate) void this.runAutoUpdate('manual')
    return view
  }

  /** 开机自启:安装版才开放;启动后 AI网络仍按用户上次的开关状态恢复(守护自恢复)。 */
  loginItem(): { enabled: boolean; supported: boolean } {
    if (!app.isPackaged) return { enabled: false, supported: false }
    return loginItemStatus(electronLoginItem)
  }

  setLoginItem(enabled: boolean): { enabled: boolean; supported: boolean } {
    if (!app.isPackaged) return { enabled: false, supported: false }
    return setLoginItem(electronLoginItem, enabled)
  }

  /** 「工具箱意外退出时,网络不断」:安装版才开放——开发态没有常驻可装。
   *  打开只记选择(真正装上由连接路径做);关掉当场把已装的撤掉,⛔ 动此刻正连着的网络。 */
  residentEnabled(): Promise<ResidentToggleStatus> {
    return residentToggleStatus(this.residentPreference(), this.resident, app.isPackaged)
  }

  // 客户拨完开关立刻生效,⛔ 让他等到下次重连:开 = 当场装上(此刻正连着也照装,当前连接不断),
  // 关 = 撤掉之后把常驻运行时的内存态同步过去(否则守护监管还以为常驻 armed 着)。
  // 「记选择 → 校准 → 重读」这三步的顺序与理由在 resident-preference.ts,连同用例一起。
  setResidentEnabled(enabled: boolean): Promise<ResidentToggleStatus> {
    return applyResidentChoice(this.residentPreference(), this.resident, enabled, app.isPackaged, calibrateResident)
  }

  /** 启动校准:读客户的选择,该装就装、该卸就卸。装不上只记日志——⛔ 因为常驻装不上就不给客户连网。 */
  private async calibrateResidentOnBoot(): Promise<void> {
    if (!app.isPackaged) return
    let wanted: boolean
    try { wanted = this.residentPreference().read() } catch { return }
    const outcome = await calibrateResident(wanted).catch(() => undefined)
    if (wanted && outcome && !outcome.installed) console.error('[toolbox-desktop] RESIDENT_INSTALL_FAILED')
  }

  private residentPreference(): ResidentPreference {
    return {
      read: () => this.store.residentChoice() ?? RESIDENT_DEFAULT_ENABLED,
      write: (enabled) => { this.store.setResidentChoice(enabled) }
    }
  }

  /** FB-1:连接失败自动回传故障类型的开关(设置页一行,默认开)。supported 恒真:
   * 这项没有平台/安装形态限制,⛔ 让客户看到灰掉的开关以为自己的机器不行。 */
  failureReportEnabled(): { enabled: boolean; supported: boolean } {
    return { enabled: this.store.failureReportChoice() ?? FAILURE_REPORT_DEFAULT_ENABLED, supported: true }
  }

  setFailureReportEnabled(enabled: boolean): { enabled: boolean; supported: boolean } {
    this.store.setFailureReportChoice(enabled)
    return { enabled, supported: true }
  }

  private async runAutoUpdate(reason: 'startup' | 'interval' | 'resume' | 'manual'): Promise<void> {
    if (this.disposed) return
    try { await this.autoUpdate.run(reason) } catch { console.error('[toolbox-desktop] AUTO_UPDATE_UNAVAILABLE') }
    finally { this.refreshMenu() }
    // 配方与更新同节奏拉取；失败保持内置或缓存。
    if (reason !== 'manual') await recipeStore().refresh().catch(() => undefined)
  }

  private showUpdateReady(version: string): void {
    this.refreshMenu()
    if (!Notification.isSupported()) return
    this.updateNotification?.close()
    const notification = new Notification({ title: '来信 AI 工具箱', body: updateReadyMessage(version), silent: true })
    this.updateNotification = notification
    notification.on('click', () => this.show('settings'))
    notification.on('close', () => { if (this.updateNotification === notification) this.updateNotification = undefined })
    notification.show()
  }

  private async readAlerts(): Promise<void> {
    const results = await Promise.allSettled(['codexusage.last', 'account.snapshot'].map((action) => this.registry.execute(action, undefined)))
    const snapshot = (index: number) => {
      const result = results[index]
      return result.status === 'fulfilled' ? JSON.parse((result.value as { snapshot: string }).snapshot) : undefined
    }
    this.alerts = quotaAlerts(snapshot(0) as UsageReport | undefined, snapshot(1) as AccountView | undefined)
  }

  private saveWindow(): void {
    this.persistWindowBounds.cancel()
    if (!this.window || this.window.isDestroyed() || this.window.isMinimized()) return
    try { this.store.save({ bounds: this.window.getNormalBounds(), maximized: this.window.isMaximized() }) }
    catch { console.error('[toolbox-desktop] WINDOW_PREFERENCES_UNAVAILABLE') }
  }

  private async saveWindowAsync(): Promise<void> {
    if (!this.window || this.window.isDestroyed() || this.window.isMinimized()) return
    try { await this.store.saveAsync({ bounds: this.window.getNormalBounds(), maximized: this.window.isMaximized() }) }
    catch { console.error('[toolbox-desktop] WINDOW_PREFERENCES_UNAVAILABLE') }
  }

  private refreshMenu(): void {
    if (!this.tray || this.disposed) return
    const update = this.updater.status()
    const network = trayNetworkPresentation(this.tunnelStatus, this.tunnelActionPending)
    const signature = trayMenuSignature(update, network)
    if (signature === this.lastMenuSignature) return
    this.lastMenuSignature = signature
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开来信 AI 工具箱', click: () => this.show() },
      { label: network.statusLabel, enabled: false },
      { label: network.actionLabel, enabled: network.actionEnabled, click: () => {
        if (network.action === 'show') this.show('tunnel')
        else void this.runTrayNetworkAction(network.action)
      } },
      { label: '查看 AI网络状态', click: () => this.show('tunnel') },
      { label: 'AI 用量', click: () => this.show('usage') },
      { label: '打开 Codex', click: () => { void this.launcher.open('codex').then((result) => { if (!result.opened) this.show('codex-download') }) } },
      { type: 'separator' },
      ...(update.state === 'ready' ? [{ label: `更新到新版 ${displayReleaseVersion(update.version)} 并重启`, click: () => { void this.updater.install().then((view) => { if (view.state === 'error') this.show('settings') }) } }] : []),
      { label: update.state === 'available' ? `新版 ${displayReleaseVersion(update.version)}` : '设置与更新', click: () => this.show('settings') },
      { type: 'separator' },
      { label: '退出工具箱（断开 AI网络）', click: () => app.quit() }
    ]))
  }

  private async refreshTunnelStatus(): Promise<void> {
    if (this.disposed || this.tunnelStatusPending) return
    this.tunnelStatusPending = true
    try {
      this.tunnelStatus = asTrayNetworkStatus(await this.registry.execute('tunnel.status', undefined))
    } catch {
      this.tunnelStatus = undefined
    } finally {
      this.tunnelStatusPending = false
      this.refreshMenu()
    }
  }

  private async runTrayNetworkAction(action: 'start' | 'stop'): Promise<void> {
    if (this.disposed || this.tunnelActionPending) return
    this.tunnelActionPending = true
    this.refreshMenu()
    try {
      const result = await this.registry.execute(action === 'start' ? 'tunnel.start' : 'tunnel.stop', undefined)
      const message = trayNetworkFailureMessage(result)
      if (message !== undefined) this.showTrayNetworkFailure(message)
    } catch {
      // 主进程异常不显示内部内容；仍给菜单操作一个可见、可执行的固定反馈。
      this.showTrayNetworkFailure(TRAY_NETWORK_OPERATION_INCOMPLETE)
    } finally {
      this.tunnelActionPending = false
      await this.refreshTunnelStatus()
    }
  }

  private showTrayNetworkFailure(message: string): void {
    this.show('tunnel')
    if (!Notification.isSupported()) {
      void dialog.showMessageBox({ type: 'warning', title: 'AI网络', message }).catch(() => undefined)
      return
    }
    this.trayNetworkNotification?.close()
    const notification = new Notification({ title: 'AI网络', body: message, silent: true })
    this.trayNetworkNotification = notification
    notification.on('close', () => {
      if (this.trayNetworkNotification === notification) this.trayNetworkNotification = undefined
    })
    notification.show()
  }

  private async pollQuotas(): Promise<void> {
    if (this.polling || this.disposed || !this.store.preferences().quotaNotifications) return
    this.polling = true
    try {
      await Promise.allSettled(['codexusage.refresh', 'account.status'].map((action) => this.registry.execute(action, undefined)))
      if (this.disposed) return
      await this.readAlerts()
      if (!this.store.preferences().quotaNotifications || !Notification.isSupported()) return
      for (const alert of this.alerts) {
        if (this.store.notified(alert.id) || this.notifications.has(alert.id)) continue
        const notification = new Notification({ title: alert.kind === 'ai' ? 'AI 额度提醒' : '网络流量提醒', body: alert.message, silent: true })
        this.notifications.set(alert.id, notification)
        notification.on('show', () => {
          try { this.store.rememberNotification(alert.id) } catch { console.error('[toolbox-desktop] NOTIFICATION_PREFERENCES_UNAVAILABLE') }
        })
        notification.on('click', () => this.show(alert.kind === 'ai' ? 'usage' : 'tunnel'))
        notification.on('close', () => this.notifications.delete(alert.id))
        notification.on('failed', () => this.notifications.delete(alert.id))
        notification.show()
      }
    } catch { console.error('[toolbox-desktop] QUOTA_READ_UNAVAILABLE') }
    finally { this.polling = false }
  }

  private dispose(): void {
    this.disposed = true; this.quitting = true; this.saveWindow(); this.updater.dispose()
    this.timers.forEach(clearInterval); this.startupTimers.forEach(clearTimeout)
    for (const notification of this.notifications.values()) notification.close()
    this.notifications.clear(); this.trayNetworkNotification?.close(); this.trayNetworkNotification = undefined
    this.updateNotification?.close(); this.updateNotification = undefined; this.tray?.destroy(); this.tray = undefined
  }
}
