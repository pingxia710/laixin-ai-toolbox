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
export interface DesktopView {
  preferences: DesktopPreferences
  backgroundAvailable: boolean
  alerts: DesktopAlert[]
  update: UpdateView
}
