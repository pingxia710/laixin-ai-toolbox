import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { debounce, DesktopStore, WINDOW_SAVE_DEBOUNCE_MS } from '../../app/main/desktop/preferences'
import { trayMenuSignature } from '../../app/main/desktop/tray-network'
import { settingsPollDelayMs } from '../../app/renderer/src/pages/settings'
import { loadCatalog } from '../../app/main/download/catalog'
import type { TrayNetworkPresentation } from '../../app/main/desktop/tray-network'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
})

describe('窗口尺寸落盘防抖与异步写', () => {
  it('防抖窗口内的连续事件只落一次盘,300ms 后执行;cancel 取消', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, WINDOW_SAVE_DEBOUNCE_MS)
    for (let index = 0; index < 100; index += 1) debounced()
    await vi.advanceTimersByTimeAsync(299)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
    debounced()
    debounced.cancel()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('saveAsync 异步落盘与同步读回一致', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'desktop-store-')), 'desktop.json')
    roots.push(await mkdtemp(join(tmpdir(), 'desktop-store-root-')))
    const store = new DesktopStore(file)
    await store.saveAsync({ bounds: { x: 4, y: 5, width: 900, height: 700 }, maximized: false })
    expect(store.window()).toEqual({ bounds: { x: 4, y: 5, width: 900, height: 700 }, maximized: false })
    const reread = new DesktopStore(file)
    expect(reread.window().bounds).toEqual({ x: 4, y: 5, width: 900, height: 700 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ bounds: { width: 900 } })
  })
})

describe('托盘菜单签名', () => {
  const network: TrayNetworkPresentation = { statusLabel: 'AI网络:未连', action: 'start', actionLabel: '连接通道', actionEnabled: true }
  it('输入未变时签名一致;更新状态或网络动作任一变化即不同', () => {
    const base = trayMenuSignature({ state: 'idle', version: '0.4.7' }, network)
    expect(trayMenuSignature({ state: 'idle', version: '0.4.7' }, network)).toBe(base)
    expect(trayMenuSignature({ state: 'ready', version: '0.4.7' }, network)).not.toBe(base)
    expect(trayMenuSignature({ state: 'idle', version: '0.4.8' }, network)).not.toBe(base)
    expect(trayMenuSignature({ state: 'idle', version: '0.4.7' }, { ...network, action: 'stop' })).not.toBe(base)
    expect(trayMenuSignature({ state: 'idle', version: '0.4.7' }, { ...network, statusLabel: 'AI网络:已连' })).not.toBe(base)
  })
})

describe('设置页轮询节奏', () => {
  it('下载进行中 1 秒,其余 15 秒', () => {
    expect(settingsPollDelayMs('downloading')).toBe(1000)
    expect(settingsPollDelayMs('checking')).toBe(15_000)
    expect(settingsPollDelayMs('idle')).toBe(15_000)
    expect(settingsPollDelayMs('')).toBe(15_000)
  })
})

describe('静态目录记忆化', () => {
  it('loadCatalog 反复访问返回同一份解析结果,不重复 parse+validate', () => {
    expect(loadCatalog()).toBe(loadCatalog())
    expect(loadCatalog().resources.length).toBeGreaterThan(0)
  })
})
