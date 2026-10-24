import { afterEach, expect, it, vi } from 'vitest'
import { mountWechatLoginPanel } from '../../app/renderer/src/ui/wechat-login-panel'
import type { WechatPanelMode } from '../../app/account-types'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('微信状态读取不重叠，退出后停止轮询、隐藏视图并忽略迟到结果', async () => {
  vi.useFakeTimers()
  let resolve: (value: { mode: WechatPanelMode }) => void = () => undefined
  const mode = vi.fn(() => new Promise<{ mode: WechatPanelMode }>(done => { resolve = done }))
  const bounds = vi.fn<(input: { bounds: string }) => Promise<void>>(async () => undefined)
  const disconnect = vi.fn(); const removeEventListener = vi.fn()
  vi.stubGlobal('window', { innerWidth: 900, innerHeight: 800, addEventListener: vi.fn(), removeEventListener,
    toolbox: { account: { wechatPanelMode: mode, wechatPanelBounds: bounds } } })
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect = disconnect })
  const slot = { isConnected: true, getBoundingClientRect: () => ({ x: 30, y: 20, width: 300, height: 290, top: 20, bottom: 310, left: 30, right: 330 }) }
  const onMode = vi.fn(); const onError = vi.fn()
  const cleanup = mountWechatLoginPanel(slot as unknown as HTMLElement, onError, onMode)
  await vi.advanceTimersByTimeAsync(3000)
  expect(mode).toHaveBeenCalledTimes(1)
  resolve({ mode: 'quick' }); await vi.advanceTimersByTimeAsync(750)
  expect(onMode).toHaveBeenLastCalledWith('quick'); expect(mode).toHaveBeenCalledTimes(2)
  cleanup(); resolve({ mode: 'qr' }); await vi.advanceTimersByTimeAsync(3000)
  expect(onMode).toHaveBeenCalledTimes(1); expect(mode).toHaveBeenCalledTimes(2)
  expect(JSON.parse(bounds.mock.calls.at(-1)![0].bounds).visible).toBe(false)
  expect(disconnect).toHaveBeenCalledOnce(); expect(removeEventListener).toHaveBeenCalledTimes(2)
  expect(onError).not.toHaveBeenCalled()
})
