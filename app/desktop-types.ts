export type AiApplicationId = 'codex' | 'hermes'
export interface AiApplicationView {
  id: AiApplicationId
  state: 'installed' | 'missing' | 'unavailable'
  version: string
}
export interface DesktopPreferences { zoom: number; quotaNotifications: boolean; autoUpdate: boolean }
export interface DesktopAlert { id: string; kind: 'ai' | 'network'; message: string }
export interface UpdateView {
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
  version: string
  notes: string
  progress: number
  message: string
}
/** 「更新成功」弹窗的内容。version=装上的新版;previous=升级前的版本(空=旧 pending 没记);notes=那次更新的说明。 */
export interface UpdateSuccessNotice { version: string; previous: string; notes: string }
export interface DesktopView {
  preferences: DesktopPreferences
  backgroundAvailable: boolean
  alerts: DesktopAlert[]
  update: UpdateView
}
