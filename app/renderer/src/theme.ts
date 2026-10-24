export type Theme = 'light' | 'dark' | 'console' | 'classic'

const THEME_KEY = 'toolbox-theme'
// 首启无用户选择时跟随系统外观；显式 applyTheme 后停止跟随。
// 例外：经典皮肤在自身内部跟随系统（暖白/暖黑），与 0.4.8 及更早版本一致。
let systemQueries: MediaQueryList[] = []
let current: Theme = 'light'

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

function systemTheme(): Theme {
  return systemDark() ? 'dark' : 'light'
}

function resolve(theme: Theme): string {
  return theme === 'classic' ? (systemDark() ? 'classic-dark' : 'classic') : theme
}

function setTheme(theme: Theme): void {
  current = theme
  document.documentElement.dataset.theme = resolve(theme)
}

function systemListener(): void {
  if (current === 'classic') { setTheme('classic'); return }
  setTheme(systemTheme())
}

function followSystem(): void {
  if (typeof matchMedia !== 'function') return
  stopFollowingSystem()
  const query = matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', systemListener)
  systemQueries = [query]
}

function stopFollowingSystem(): void {
  for (const query of systemQueries) query.removeEventListener('change', systemListener)
  systemQueries = []
}

export function applyTheme(theme: Theme): void {
  stopFollowingSystem()
  setTheme(theme)
  if (theme === 'classic') followSystem()
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* Appearance still applies for this window. */ }
}

export function currentThemeSetting(): Theme {
  return current
}

export function initializeTheme(): void {
  let stored: string | null = null
  try { stored = localStorage.getItem(THEME_KEY) } catch { /* Follow the system appearance. */ }
  if (stored === 'light' || stored === 'dark' || stored === 'console' || stored === 'classic') {
    setTheme(stored)
    if (stored === 'classic') followSystem()
    return
  }
  setTheme(systemTheme())
  followSystem()
}
