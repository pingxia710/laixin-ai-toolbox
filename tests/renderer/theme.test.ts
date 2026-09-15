import { afterEach, expect, it, vi } from 'vitest'

type Listener = (event: { matches: boolean }) => void

function stubSystemAppearance(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<Listener>()
  const query = {
    get matches() { return matches },
    addEventListener(_type: string, listener: Listener) { listeners.add(listener) },
    removeEventListener(_type: string, listener: Listener) { listeners.delete(listener) },
    flip(next: boolean) { matches = next; for (const listener of [...listeners]) listener({ matches }) }
  }
  vi.stubGlobal('matchMedia', (text: string) => {
    if (text !== '(prefers-color-scheme: dark)') throw new Error(`unexpected query: ${text}`)
    return query
  })
  return query
}

const storage = () => {
  const values = new Map<string, string>()
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
  vi.stubGlobal('localStorage', store)
  return store
}

const loadTheme = async () => {
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string | undefined> } })
  const module = await import('../../app/renderer/src/theme')
  return module
}

const theme = () => document.documentElement.dataset.theme

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('无存储值时首启跟随系统深色,系统切换实时跟随', async () => {
  const system = stubSystemAppearance(true)
  storage()
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('dark')
  system.flip(false)
  expect(theme()).toBe('light')
})

it('无存储值且系统为浅色时保持浅色', async () => {
  stubSystemAppearance(false)
  storage()
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('light')
})

it('有存储值时不跟随系统,尊重用户显式选择', async () => {
  const system = stubSystemAppearance(false)
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'toolbox-theme' ? 'dark' : null, setItem: () => undefined })
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('dark')
  system.flip(true)
  expect(theme()).toBe('dark')
})

it('显式设置主题后停止跟随系统并保存选择', async () => {
  const system = stubSystemAppearance(true)
  const store = storage()
  const { initializeTheme, applyTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('dark')
  applyTheme('light')
  expect(theme()).toBe('light')
  expect(store.getItem('toolbox-theme')).toBe('light')
  system.flip(false)
  expect(theme()).toBe('light')
})

it('localStorage 不可用时仍然跟随系统外观', async () => {
  const system = stubSystemAppearance(true)
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('dark')
  system.flip(false)
  expect(theme()).toBe('light')
})

it('存储的夜航主题被尊重,不随系统切换', async () => {
  const system = stubSystemAppearance(false)
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'toolbox-theme' ? 'console' : null, setItem: () => undefined })
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('console')
  system.flip(true)
  expect(theme()).toBe('console')
})

it('显式选择夜航后保存并停止跟随系统', async () => {
  const system = stubSystemAppearance(false)
  const store = storage()
  const { initializeTheme, applyTheme } = await loadTheme()
  initializeTheme()
  applyTheme('console')
  expect(theme()).toBe('console')
  expect(store.getItem('toolbox-theme')).toBe('console')
  system.flip(true)
  expect(theme()).toBe('console')
})

it('存储的经典皮肤在自身内部跟随系统（暖白/暖黑）', async () => {
  const system = stubSystemAppearance(true)
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'toolbox-theme' ? 'classic' : null, setItem: () => undefined })
  const { initializeTheme } = await loadTheme()
  initializeTheme()
  expect(theme()).toBe('classic-dark')
  system.flip(false)
  expect(theme()).toBe('classic')
})

it('显式选择经典后保存原值并继续在暖白/暖黑间跟随系统', async () => {
  const system = stubSystemAppearance(true)
  const store = storage()
  const { initializeTheme, applyTheme, currentThemeSetting } = await loadTheme()
  initializeTheme()
  applyTheme('classic')
  expect(theme()).toBe('classic-dark')
  expect(store.getItem('toolbox-theme')).toBe('classic')
  expect(currentThemeSetting()).toBe('classic')
  system.flip(false)
  expect(theme()).toBe('classic')
})

it('经典之后再选深蓝则固定,不再跟随系统', async () => {
  const system = stubSystemAppearance(true)
  storage()
  const { initializeTheme, applyTheme } = await loadTheme()
  initializeTheme()
  applyTheme('classic')
  expect(theme()).toBe('classic-dark')
  applyTheme('console')
  expect(theme()).toBe('console')
  system.flip(false)
  expect(theme()).toBe('console')
})
