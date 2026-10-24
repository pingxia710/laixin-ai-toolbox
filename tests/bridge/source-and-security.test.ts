import { describe, expect, it, vi } from 'vitest'
import { isAllowedBridgeSource } from '../../app/main/bridge/source-guard'
import { installNavigationGuards } from '../../app/main/bridge/window-security'

describe('IPC 来源和窗口边界', () => {
  const expected = 'http://127.0.0.1:5173/index.html'
  const mainFrame = { url: expected }
  const owner = { mainFrame }

  it('只放行登记主窗口的主 frame 与精确入口', () => {
    expect(isAllowedBridgeSource(mainFrame, owner, expected)).toBe(true)
    expect(isAllowedBridgeSource({ url: expected }, owner, expected)).toBe(false)
    expect(isAllowedBridgeSource({ url: 'http://127.0.0.1:5173/index.html.evil' }, owner, expected)).toBe(false)
    expect(isAllowedBridgeSource({ url: 'http://127.0.0.1:5173/other.html' }, owner, expected)).toBe(false)
    expect(isAllowedBridgeSource(null, owner, expected)).toBe(false)
  })

  it('生产 file 入口逐字匹配绝对路径', () => {
    const fileUrl = 'file:///tmp/toolbox/renderer/index.html'
    const frame = { url: fileUrl }
    expect(isAllowedBridgeSource(frame, { mainFrame: frame }, fileUrl)).toBe(true)
    expect(isAllowedBridgeSource(frame, { mainFrame: frame }, `${fileUrl}?query=1`)).toBe(false)
  })

  it('拒绝弹窗、越界导航和 webview', () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const contents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, callback: (...args: never[]) => void) => listeners.set(event, callback))
    }
    installNavigationGuards(contents, expected)

    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const blocked = { preventDefault: vi.fn() }
    listeners.get('will-navigate')?.(blocked as never, 'https://example.com' as never)
    expect(blocked.preventDefault).toHaveBeenCalledOnce()
    const permitted = { preventDefault: vi.fn() }
    listeners.get('will-navigate')?.(permitted as never, expected as never)
    expect(permitted.preventDefault).not.toHaveBeenCalled()
    listeners.get('will-attach-webview')?.(blocked as never)
    expect(blocked.preventDefault).toHaveBeenCalledTimes(2)
  })
})
