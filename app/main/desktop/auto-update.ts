import type { UpdateView } from '../../desktop-types'
import { displayReleaseVersion } from '../../release-version'

// 自动更新的决策逻辑：何时检查、何时自动下载、何时提醒。
// 不含 Electron 依赖，运行时把更新器、偏好存储和系统提醒注入进来。
export interface AutoUpdateDriver {
  status(): UpdateView
  check(): Promise<UpdateView>
  download(): Promise<UpdateView>
}
export interface AutoUpdateMemory {
  autoUpdate(): boolean
  notified(key: string): boolean
  remember(key: string): void
}
export interface AutoUpdateHooks {
  notify(version: string): void
  now?: () => number
}
export type AutoUpdateReason = 'startup' | 'interval' | 'resume' | 'manual'
export type AutoUpdateOutcome = 'skipped' | 'current' | 'available' | 'downloaded' | 'notified' | 'failed' | 'disabled'

// 检查成功后 6 小时再检查；检查或下载失败后 30 分钟再试；同一版本每次运行最多自动下载 3 次。
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const AUTO_UPDATE_RETRY_INTERVAL_MS = 30 * 60_000
export const AUTO_UPDATE_TICK_MS = 5 * 60_000
export const AUTO_UPDATE_DOWNLOAD_ATTEMPTS = 3
export const updateNotificationKey = (version: string): string => `update:${version}`
export const updateReadyMessage = (version: string): string =>
  `新版 ${displayReleaseVersion(version)} 已下载完成，点击更新并重启。更新会暂时断开 AI网络，账号和配置保留。`

export class AutoUpdateCoordinator {
  private lastAttempt = 0
  private lastFailed = false
  private running = false
  private downloads = new Map<string, number>()
  constructor(private readonly driver: AutoUpdateDriver, private readonly memory: AutoUpdateMemory, private readonly hooks: AutoUpdateHooks) {}

  due(now = this.now()): boolean {
    if (this.lastAttempt === 0) return true
    return now - this.lastAttempt >= (this.lastFailed ? AUTO_UPDATE_RETRY_INTERVAL_MS : AUTO_UPDATE_CHECK_INTERVAL_MS)
  }

  async run(reason: AutoUpdateReason): Promise<AutoUpdateOutcome> {
    if (this.running) return 'skipped'
    let view = this.driver.status()
    if (['downloading', 'installing', 'checking'].includes(view.state)) return 'skipped'
    if (view.state === 'ready') return this.remind(view.version)
    if (reason !== 'manual' && !this.due()) return 'skipped'
    this.running = true
    try {
      if (view.state !== 'available') {
        this.lastAttempt = this.now()
        view = await this.driver.check()
        if (view.state === 'error') { this.lastFailed = true; return 'failed' }
        this.lastFailed = false
        if (view.state !== 'available') return 'current'
      }
      if (!this.memory.autoUpdate()) return 'disabled'
      const attempts = this.downloads.get(view.version) ?? 0
      if (attempts >= AUTO_UPDATE_DOWNLOAD_ATTEMPTS) return 'available'
      this.downloads.set(view.version, attempts + 1)
      this.lastAttempt = this.now()
      view = await this.driver.download()
      if (view.state !== 'ready') { this.lastFailed = true; return 'failed' }
      this.lastFailed = false
      return this.remind(view.version) === 'notified' ? 'notified' : 'downloaded'
    } finally { this.running = false }
  }

  private remind(version: string): AutoUpdateOutcome {
    const key = updateNotificationKey(version)
    if (!version || this.memory.notified(key)) return 'skipped'
    this.memory.remember(key)
    this.hooks.notify(version)
    return 'notified'
  }

  private now(): number { return (this.hooks.now ?? Date.now)() }
}
